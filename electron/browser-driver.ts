/**
 * Drives one browser page the way a person uses it, from the main process,
 * over the debugging connection Tacit already holds to every guest page
 * (docs/architecture/browser-agents.md, Stage 2).
 *
 * - Frames: every frame, including ones from other sites that run in their
 *   own process (Target.setAutoAttach, flatten), each with PAGE_SCRIPT in a
 *   script world of its own.
 * - Seeing: an outline of what can be clicked, typed into or read, with
 *   handles (shared/browser-snapshot.ts), and screenshots.
 * - Doing: real mouse and keyboard input (Input.*), so pages that ignore
 *   script-made events (Excel Online's grid) take it. A target is scrolled
 *   into view, must be shown, still, and not covered.
 */
import { PAGE_SCRIPT } from "../shared/browser-page-script";
import { chordEvents, typeEvents, type KeyEventParams } from "../shared/browser-keys";
import { capLines, diffLines, findLines, parseRef, snapshotLines, type FrameSnapshot, type SnapshotEntry } from "../shared/browser-snapshot";

/** What the driver needs of a guest webContents. */
export interface DriverPage {
  readonly debugger: {
    isAttached(): boolean;
    attach(version?: string): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<any>;
    on(event: "message", listener: (event: unknown, method: string, params: any, sessionId: string) => void): unknown;
    on(event: "detach", listener: (event: unknown, reason: string) => void): unknown;
  };
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
}

export class DriverError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const ROOT = "";
const CALL_TIMEOUT_MS = 10_000;

interface FrameInfo {
  sessionId: string;
  parentId: string | null;
  url: string;
}

export interface Dialog {
  type: string;
  message: string;
  defaultPrompt?: string;
  sessionId: string;
}

export interface Screenshot {
  id: string;
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /** Image pixels per page CSS pixel. */
  scale: number;
}

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new DriverError(`${what} took longer than ${Math.round(ms / 1000)} s`, "timeout")), ms))]);

export class PageDriver {
  private ready: Promise<void> | null = null;
  private readonly children = new Map<string, { targetId: string; type: string; url: string; parentFrameId: string | null }>();
  private frames = new Map<string, FrameInfo>();
  private rootFrameId: string | null = null;
  private worlds = new Map<string, number>();
  private prefixes = new Map<string, string>();
  private byPrefix = new Map<string, string>();
  private nextPrefix = 1;
  /** Handles start above any handed out before, on any document: an old one never names a new element. */
  private refFloor = 1;
  private listening = false;
  private lastLines: string[] | null = null;
  private shots = new Map<string, { scale: number; pageX: number; pageY: number }>();
  private shotSeq = 0;
  dialog: Dialog | null = null;
  /**
   * Input the agent sent that the page hasn't reported yet: a mouse press or key press the
   * page reports is the agent's while one is owed, and otherwise the person's.
   */
  private owed: Array<{ kind: "mouse" | "key"; until: number }> = [];
  /** Called before each input event: throws to stop an agent mid-way (the person pressed Stop). */
  checkpoint: (() => void) | null = null;
  /**
   * Whether Tacit's window has its keyboard on this page. A key the page doesn't take goes
   * back to the window, to whatever has the keyboard there (an agent's own terminal, where
   * Escape stops it). Null where there's no window to ask.
   */
  keyboardHere: (() => Promise<boolean>) | null = null;
  /**
   * A PNG (base64) as the person sees it, on white, as a JPEG at most this many pixels wide:
   * Electron's nativeImage in the app. Null where there's none, and then there are no screenshots.
   */
  jpegOf: ((pngBase64: string, width: number, quality: number) => { data: string; width: number; height: number }) | null = null;
  /** Navigations seen; a ref from before the latest is stale. */
  generation = 0;

  constructor(private readonly page: DriverPage) {}

  private send(method: string, params: unknown = {}, sessionId: string = ROOT, ms = CALL_TIMEOUT_MS): Promise<any> {
    if (this.page.isDestroyed()) return Promise.reject(new DriverError("The page is gone.", "gone"));
    return withTimeout(this.page.debugger.sendCommand(method, params, sessionId || undefined), ms, method);
  }

  private onMessage = (_e: unknown, method: string, params: any, sessionId: string) => {
    const sid = sessionId || ROOT;
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo;
      this.children.set(params.sessionId, { targetId: info.targetId, type: info.type, url: info.url, parentFrameId: typeof info.parentFrameId === "string" ? info.parentFrameId : null });
      if (info.type === "iframe") {
        // Its own frames too (a frame from another site inside it), and its dialogs.
        void this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => {});
        void this.send("Page.enable", {}, params.sessionId).catch(() => {});
      }
      this.frames.clear();
    } else if (method === "Target.detachedFromTarget") {
      this.children.delete(params.sessionId);
      this.frames.clear();
    } else if (method === "Page.frameNavigated") {
      const f = params.frame;
      if (!f.parentId && sid === ROOT) this.reset();
      else { this.worlds.delete(f.id); this.frames.clear(); }
    } else if (method === "Page.frameDetached") {
      this.worlds.delete(params.frameId);
      this.frames.clear();
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = { type: params.type, message: params.message, ...(params.defaultPrompt ? { defaultPrompt: params.defaultPrompt } : {}), sessionId: sid };
      for (const w of this.dialogWaiters.splice(0)) w();
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
    }
  };

  private reset(): void {
    this.generation++;
    this.frames.clear();
    this.worlds.clear();
    this.prefixes.clear();
    this.byPrefix.clear();
    this.lastLines = null;
    this.shots.clear();
  }

  async init(): Promise<void> {
    this.ready ??= (async () => {
      const d = this.page.debugger;
      if (!d.isAttached()) d.attach("1.3");
      if (!this.listening) {
        // Once: a reattach after a detach reuses them.
        this.listening = true;
        d.on("message", this.onMessage);
        d.on("detach", () => { this.ready = null; this.children.clear(); this.reset(); });
      }
      await this.send("Page.enable");
      await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  private guardDialog(): void {
    if (this.dialog) throw new DriverError(`A ${this.dialog.type} dialog is open on the page: "${this.dialog.message.slice(0, 200)}". Answer it with browser_dialog first.`, "dialog_open");
  }

  /** Which session owns each frame, and its parent. */
  private async frameMap(): Promise<Map<string, FrameInfo>> {
    if (this.frames.size) return this.frames;
    const map = new Map<string, FrameInfo>();
    const walk = (node: any, sessionId: string, parentId: string | null) => {
      map.set(node.frame.id, { sessionId, parentId, url: node.frame.url });
      for (const c of node.childFrames ?? []) walk(c, sessionId, node.frame.id);
    };
    const root = await this.send("Page.getFrameTree");
    this.rootFrameId = root.frameTree.frame.id;
    walk(root.frameTree, ROOT, null);
    for (const [sid, child] of this.children) {
      if (child.type !== "iframe") continue;
      try {
        const t = await this.send("Page.getFrameTree", {}, sid);
        // A frame from another site isn't in its parent's tree: its parent comes with the
        // target (parentFrameId). Its own frames are under it, in its session.
        const own = (node: any, parentId: string | null) => {
          const known = map.get(node.frame.id);
          map.set(node.frame.id, { sessionId: sid, parentId: known?.parentId ?? parentId, url: node.frame.url });
          for (const c of node.childFrames ?? []) own(c, node.frame.id);
        };
        own(t.frameTree, child.parentFrameId);
      } catch {
        // Gone between the event and now.
      }
    }
    this.frames = map;
    for (const id of map.keys()) {
      if (id === this.rootFrameId || this.prefixes.has(id)) continue;
      const p = `f${this.nextPrefix++}`;
      this.prefixes.set(id, p);
      this.byPrefix.set(p, id);
    }
    return map;
  }

  private prefixOf(frameId: string): string {
    return frameId === this.rootFrameId ? "" : this.prefixes.get(frameId) ?? "";
  }

  /** The frame's own script world, with PAGE_SCRIPT in it. */
  private async world(frameId: string): Promise<{ sessionId: string; contextId: number }> {
    const frames = await this.frameMap();
    const info = frames.get(frameId);
    if (!info) throw new DriverError("That frame is gone: the page changed. Take a new snapshot.", "stale");
    let contextId = this.worlds.get(frameId);
    if (contextId === undefined) {
      const made = await this.send("Page.createIsolatedWorld", { frameId, worldName: "tacit", grantUniveralAccess: false }, info.sessionId);
      contextId = made.executionContextId as number;
      await this.send("Runtime.evaluate", { expression: PAGE_SCRIPT, contextId, returnByValue: true }, info.sessionId);
      await this.send("Runtime.evaluate", { expression: `__tacit.startAt(${this.refFloor})`, contextId, returnByValue: true }, info.sessionId);
      this.worlds.set(frameId, contextId);
    }
    return { sessionId: info.sessionId, contextId };
  }

  /** An expression in a frame's world; its context is made again if the frame moved on. */
  private async evalIn(frameId: string, expression: string, opts: { awaitPromise?: boolean; byValue?: boolean } = {}): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sessionId, contextId } = await this.world(frameId);
      try {
        const r = await this.send("Runtime.evaluate", { expression, contextId, returnByValue: opts.byValue !== false, awaitPromise: !!opts.awaitPromise }, sessionId);
        if (r.exceptionDetails) throw new DriverError(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Script failed", "script");
        return opts.byValue === false ? r.result : r.result.value;
      } catch (e) {
        if (attempt === 0 && /context|Cannot find|not found|destroyed/i.test(String((e as Error).message))) { this.worlds.delete(frameId); this.frames.clear(); continue; }
        throw e;
      }
    }
  }

  /** The page as an outline: every frame, each under its <iframe>. */
  async snapshot(opts: { maxChars?: number; since?: boolean } = {}): Promise<{ url: string; title: string; text: string; lines: string[]; truncated: boolean; changes?: ReturnType<typeof diffLines> }> {
    await this.init();
    this.guardDialog();
    const frames = await this.frameMap();
    const results: FrameSnapshot[] = [];
    let title = this.page.getTitle();
    let url = this.page.getURL();
    for (const [frameId, info] of frames) {
      const prefix = this.prefixOf(frameId);
      let snap: { entries: SnapshotEntry[]; truncated: boolean; url: string; title: string };
      try {
        snap = await this.evalIn(frameId, "__tacit.snapshot({ max: 3000 })");
      } catch {
        continue; // A frame that can't be read (about:blank mid-load, gone): left out.
      }
      if (frameId === this.rootFrameId) ({ title, url } = snap);
      for (const e of snap.entries) {
        const n = Number(/^e(\d+)$/.exec(e.ref)?.[1]);
        if (n >= this.refFloor) this.refFloor = n + 1;
      }
      let ownerRef: string | null = null;
      if (info.parentId) ownerRef = await this.ownerRef(frameId, info.parentId).catch(() => null);
      results.push({ prefix, entries: snap.entries, truncated: snap.truncated, ...(info.parentId ? { parentPrefix: this.prefixOf(info.parentId), ownerRef } : {}) });
    }
    const lines = snapshotLines(results);
    const capped = capLines(lines, opts.maxChars ?? 12_000);
    const changes = opts.since && this.lastLines ? diffLines(this.lastLines, lines) : undefined;
    this.lastLines = lines;
    return { url, title, text: capped.text, lines, truncated: capped.truncated, ...(changes ? { changes } : {}) };
  }

  async find(query: string): Promise<string[]> {
    const snap = await this.snapshot({ maxChars: 1 });
    return findLines(snap.lines, query);
  }

  /** The handle, in its parent frame, of the <iframe> holding a frame. */
  private async ownerRef(frameId: string, parentId: string): Promise<string | null> {
    const { sessionId, objectId } = await this.ownerObject(frameId, parentId);
    const r = await this.send("Runtime.callFunctionOn", { functionDeclaration: "function () { return globalThis.__tacit.refFor.call(this); }", objectId, returnByValue: true }, sessionId);
    return r.result.value ?? null;
  }

  /** The <iframe> element holding a frame, as a remote object in its parent's world. */
  private async ownerObject(frameId: string, parentId: string): Promise<{ sessionId: string | undefined; objectId: string }> {
    const { sessionId, contextId } = await this.world(parentId);
    const owner = await this.send("DOM.getFrameOwner", { frameId }, sessionId).catch(async () => {
      await this.send("DOM.enable", {}, sessionId);
      return this.send("DOM.getFrameOwner", { frameId }, sessionId);
    });
    const node = await this.send("DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: contextId }, sessionId);
    return { sessionId, objectId: node.object.objectId };
  }

  /** The frames from the top page down to this one, outermost first, without the top page. */
  private async frameChain(frameId: string): Promise<Array<{ frameId: string; parentId: string }>> {
    const frames = await this.frameMap();
    const chain: Array<{ frameId: string; parentId: string }> = [];
    for (let id: string | undefined = frameId; id; ) {
      const parentId: string | undefined = frames.get(id)?.parentId ?? undefined;
      if (!parentId) break;
      chain.unshift({ frameId: id, parentId });
      id = parentId;
    }
    return chain;
  }

  /** Scrolls each <iframe> around a frame into view in its own page, outermost first, when it isn't already. */
  private async revealFrame(frameId: string): Promise<void> {
    for (const { frameId: id, parentId } of await this.frameChain(frameId)) {
      const { sessionId, objectId } = await this.ownerObject(id, parentId);
      await this.send("Runtime.callFunctionOn", {
        functionDeclaration: "function () { const r = this.getBoundingClientRect(); const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; if (!inView) this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }",
        objectId,
      }, sessionId);
    }
  }

  /** Where a frame's viewport starts on the page, in CSS pixels. */
  private async frameOffset(frameId: string): Promise<{ x: number; y: number }> {
    let x = 0, y = 0;
    for (const { frameId: id, parentId } of await this.frameChain(frameId)) {
      const { sessionId, objectId } = await this.ownerObject(id, parentId);
      const r = await this.send("Runtime.callFunctionOn", {
        functionDeclaration: "function () { const r = this.getBoundingClientRect(); const s = getComputedStyle(this); return [r.left + this.clientLeft + parseFloat(s.paddingLeft || '0'), r.top + this.clientTop + parseFloat(s.paddingTop || '0')]; }",
        objectId,
        returnByValue: true,
      }, sessionId);
      const [fx, fy] = r.result.value as [number, number];
      x += fx; y += fy;
    }
    return { x, y };
  }

  /** Whether a point inside a frame reaches it: in each page around it, the point lands on the <iframe>, not on something over it. */
  private async frameHit(frameId: string, x: number, y: number): Promise<{ ok: true } | { ok: false; message: string }> {
    const chain = await this.frameChain(frameId);
    // Walk outward, turning the point into each parent's coordinates.
    let px = x, py = y;
    for (const { frameId: id, parentId } of [...chain].reverse()) {
      const { sessionId, objectId } = await this.ownerObject(id, parentId);
      const r = await this.send("Runtime.callFunctionOn", {
        functionDeclaration: `function (x, y) {
          const b = this.getBoundingClientRect(); const s = getComputedStyle(this);
          const ox = b.left + this.clientLeft + parseFloat(s.paddingLeft || '0'), oy = b.top + this.clientTop + parseFloat(s.paddingTop || '0');
          const px = x + ox, py = y + oy;
          if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) return { ok: false, message: 'The frame is outside the visible page; scroll it into view.', px, py };
          let top = document.elementFromPoint(px, py);
          while (top && top.shadowRoot && top.shadowRoot.elementFromPoint) { const inner = top.shadowRoot.elementFromPoint(px, py); if (!inner || inner === top) break; top = inner; }
          if (top === this) return { ok: true, px, py };
          const what = top ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + ((top.innerText || '').trim() ? ' "' + (top.innerText || '').trim().slice(0, 40) + '"' : '')) : 'nothing';
          return { ok: false, message: 'The frame is covered there by ' + what + '. Close or scroll past it, then try again.', px, py };
        }`,
        objectId,
        arguments: [{ value: px }, { value: py }],
        returnByValue: true,
      }, sessionId);
      const v = r.result.value as { ok: boolean; message?: string; px: number; py: number };
      if (!v.ok) return { ok: false, message: v.message ?? "The frame can't be reached there." };
      px = v.px; py = v.py;
    }
    return { ok: true };
  }

  private async frameOfRef(qref: string): Promise<{ frameId: string; ref: string }> {
    const parsed = parseRef(qref);
    if (!parsed) throw new DriverError(`"${qref}" isn't a ref: use one from browser_snapshot, like e12 or f1e3.`, "invalid_ref");
    await this.frameMap();
    const frameId = parsed.prefix ? this.byPrefix.get(parsed.prefix) : this.rootFrameId;
    if (!frameId) throw new DriverError(`There's no frame ${parsed.prefix} any more: the page changed. Take a new snapshot.`, "stale");
    return { frameId, ref: parsed.ref };
  }

  /** The middle of a ref on the page, after scrolling it into view and checking nothing covers it. */
  async pointOf(qref: string, opts: { enabled?: boolean } = {}): Promise<{ x: number; y: number }> {
    await this.init();
    this.guardDialog();
    const { frameId, ref } = await this.frameOfRef(qref);
    if (frameId !== this.rootFrameId) await this.revealFrame(frameId);
    const at = await this.evalIn(frameId, `__tacit.actionable(${JSON.stringify(ref)}, ${JSON.stringify({ enabled: !!opts.enabled })})`, { awaitPromise: true });
    if (!at.ok) throw new DriverError(at.message, at.reason);
    const hit = await this.evalIn(frameId, `__tacit.hit(${JSON.stringify(ref)}, ${at.x}, ${at.y})`);
    if (!hit.ok) throw new DriverError(hit.message, "covered");
    if (frameId !== this.rootFrameId) {
      const reach = await this.frameHit(frameId, at.x, at.y);
      if (!reach.ok) throw new DriverError(reach.message, "covered");
    }
    const off = await this.frameOffset(frameId);
    this.pointedFrame = frameId;
    return { x: at.x + off.x, y: at.y + off.y };
  }

  /** The frame of the last thing pointed at, and one a click went into whose focus hasn't been seen yet. */
  private pointedFrame: string | null = null;
  private focusPending: string | null = null;

  /**
   * After a click into a frame from another site, Chromium gives that frame the keyboard a
   * moment later; keys sent before then go to the page around it. Waits until it has it.
   */
  private async settleFocus(): Promise<void> {
    const frameId = this.focusPending;
    this.focusPending = null;
    if (!frameId) return;
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      const has = await this.evalIn(frameId, "document.hasFocus()").catch(() => true);
      if (has) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A point from a screenshot, in its image pixels, as page CSS pixels. */
  pointFromShot(id: string | undefined, x: number, y: number): { x: number; y: number } {
    if (!id) return { x, y };
    const s = this.shots.get(id);
    if (!s) throw new DriverError(`Screenshot ${id} is from before the page changed. Take a new one.`, "stale");
    return { x: x / s.scale, y: y / s.scale };
  }

  private dialogWaiters: Array<() => void> = [];

  /** Input that opens a dialog (a confirm, an alert) doesn't finish until it's answered: it returns once the dialog shows. */
  private async input(method: string, params: unknown): Promise<void> {
    this.guardDialog();
    const type = (params as { type?: string }).type;
    // Only what starts something is stopped: a release (key up, mouse up) always goes, so
    // nothing is left held down.
    const releases = type === "keyUp" || type === "mouseReleased";
    if (!releases) this.checkpoint?.();
    const kind = method === "Input.dispatchMouseEvent" && type === "mousePressed" ? "mouse" : method === "Input.dispatchKeyEvent" && (type === "keyDown" || type === "rawKeyDown") ? "key" : null;
    const token = kind ? { kind, until: Date.now() + 2000 } as const : null;
    if (token) this.owed.push(token);
    let opened: () => void = () => {};
    const dialog = new Promise<void>((r) => { opened = r; this.dialogWaiters.push(r); });
    try {
      await Promise.race([this.send(method, params), dialog]);
    } catch (e) {
      // Not delivered: the page won't report it, so it isn't owed.
      if (token) this.owed = this.owed.filter((o) => o !== token);
      throw e;
    } finally {
      this.dialogWaiters = this.dialogWaiters.filter((w) => w !== opened);
    }
  }

  /** Whether a press the page reports (Electron's input-event type) is one the agent sent. */
  isOwnInput(type: string): boolean {
    const kind = type === "mouseDown" ? "mouse" : type === "keyDown" || type === "rawKeyDown" ? "key" : null;
    if (!kind) return false;
    const now = Date.now();
    this.owed = this.owed.filter((o) => o.until > now);
    const i = this.owed.findIndex((o) => o.kind === kind);
    if (i < 0) return false;
    this.owed.splice(i, 1);
    return true;
  }

  /** Whether the element with the keyboard, in whichever frame has it, is a password field. */
  async focusIsPassword(): Promise<boolean> {
    await this.init();
    // After a click into a frame, the keyboard arrives there a moment later: ask once it has.
    await this.settleFocus();
    for (const frameId of (await this.frameMap()).keys()) {
      if (await this.evalIn(frameId, "__tacit.focusedIsPassword()").catch(() => false)) return true;
    }
    return false;
  }

  async mouse(x: number, y: number, opts: { button?: "left" | "right" | "middle"; count?: number; modifiers?: number } = {}): Promise<void> {
    const button = opts.button ?? "left";
    const count = Math.max(1, Math.min(3, opts.count ?? 1));
    await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers: opts.modifiers ?? 0 });
    for (let i = 1; i <= count; i++) {
      await this.input("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, buttons: 1, modifiers: opts.modifiers ?? 0 });
      await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, buttons: 0, modifiers: opts.modifiers ?? 0 });
    }
    // A click on something pointed at inside a frame: the next keys wait for that frame's focus.
    const pointed = this.pointedFrame;
    this.pointedFrame = null;
    this.focusPending = pointed && pointed !== this.rootFrameId ? pointed : null;
  }

  async hover(x: number, y: number): Promise<void> {
    await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none" });
    await this.input("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1 });
    let at = from;
    try {
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
        await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "left", buttons: 1 });
      }
    } finally {
      // The button goes up wherever the drag stopped.
      await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1, buttons: 0 });
    }
  }

  async wheel(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.input("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, button: "none" });
  }

  /**
   * Keys go only to a page that has the keyboard: one sent to a page that hasn't would land
   * wherever the keyboard is in Tacit's window. A click in the page gives it the keyboard at
   * once; a moment's grace covers the window catching up.
   */
  private async mustHaveKeyboard(): Promise<void> {
    const here = this.keyboardHere;
    if (!here) return;
    const until = Date.now() + 200;
    for (;;) {
      if (await here()) return;
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new DriverError(
      "This page doesn't have the keyboard: something else in Tacit has it (the person may be typing there), so nothing was sent. Click in the page where you want to type, then type or press.",
      "no_keyboard",
    );
  }

  async keys(events: readonly KeyEventParams[]): Promise<void> {
    await this.settleFocus();
    const down = new Map<string, KeyEventParams>();
    try {
      for (const ev of events) {
        // Each press, not just the first: the person can click elsewhere mid-way.
        if (ev.type !== "keyUp") await this.mustHaveKeyboard();
        await this.input("Input.dispatchKeyEvent", ev);
        if (ev.type === "keyUp") down.delete(ev.code || ev.key);
        else down.set(ev.code || ev.key, ev);
      }
    } catch (e) {
      // Stopped mid-chord: whatever is still down (a modifier) goes up, last first.
      for (const ev of [...down.values()].reverse()) {
        await this.input("Input.dispatchKeyEvent", { type: "keyUp", key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode, modifiers: 0 }).catch(() => {});
      }
      throw e;
    }
  }

  press(chord: string): Promise<void> {
    return this.keys(chordEvents(chord));
  }

  /** Characters as key presses: what a canvas editor like Excel's grid takes. */
  typeKeys(text: string): Promise<void> {
    return this.keys(typeEvents(text));
  }

  /** Text inserted at the caret, as an input method does: fast, for ordinary fields. */
  async insertText(text: string): Promise<void> {
    this.guardDialog();
    await this.settleFocus();
    // Not a key press, so it can't land outside the page, but it would be lost there unseen.
    await this.mustHaveKeyboard();
    await this.input("Input.insertText", { text });
  }

  /** The middle of what's on screen, for scrolling with nothing in particular under it. */
  async viewportCenter(): Promise<{ x: number; y: number }> {
    await this.init();
    const m = await this.send("Page.getLayoutMetrics");
    const v = m.cssVisualViewport ?? m.visualViewport;
    return { x: v.clientWidth / 2, y: v.clientHeight / 2 };
  }

  async screenshot(opts: { maxWidth?: number; quality?: number } = {}): Promise<Screenshot> {
    await this.init();
    this.guardDialog();
    const jpegOf = this.jpegOf;
    if (!jpegOf) throw new DriverError("Screenshots aren't available here.", "unsupported");
    const m = await this.send("Page.getLayoutMetrics");
    const v = m.cssVisualViewport ?? m.visualViewport;
    const scale = Math.min(1, (opts.maxWidth ?? 1280) / v.clientWidth);
    const quality = opts.quality ?? 70;
    // What's on screen, as drawn, with no clip: Chromium takes a clip as a stand-in viewport
    // and waits for the page to draw at it. A page that never does (Excel, its grid in a
    // frame from another site) leaves that capture, and every one after it, waiting.
    // A PNG: a page with no background of its own is see-through, and shows on the white
    // behind it; a JPEG straight from Chromium would make that black.
    const raw = await this.send("Page.captureScreenshot", { format: "png" }, ROOT, 6000);
    // Drawn at the screen's density: brought to the page's own pixels times the scale asked.
    const img = jpegOf(raw.data, Math.max(1, Math.round(v.clientWidth * scale)), quality);
    const used = img.width / v.clientWidth;
    const id = `s${++this.shotSeq}`;
    this.shots.set(id, { scale: used, pageX: v.pageX, pageY: v.pageY });
    if (this.shots.size > 20) this.shots.delete(this.shots.keys().next().value as string);
    return { id, data: img.data, mimeType: "image/jpeg", width: img.width, height: img.height, scale: used };
  }

  /** Whether the page is being drawn: a hidden tile drops input and gives no picture. */
  async drawable(): Promise<boolean> {
    await this.init();
    try {
      const r = await this.send("Runtime.evaluate", {
        expression: "new Promise((r) => { let done = false; requestAnimationFrame(() => { done = true; r(document.visibilityState === 'visible'); }); setTimeout(() => { if (!done) r(false); }, 400); })",
        awaitPromise: true,
        returnByValue: true,
      }, ROOT, 3000);
      return r.result?.value === true;
    } catch {
      return false;
    }
  }

  /** Whether text can be typed into it: a field, a text area, or editable text. */
  async refIsEditable(qref: string): Promise<boolean> {
    const { frameId, ref } = await this.frameOfRef(qref);
    return !!(await this.evalIn(frameId, `__tacit.isEditable(${JSON.stringify(ref)})`));
  }

  async refIsPassword(qref: string): Promise<boolean> {
    const { frameId, ref } = await this.frameOfRef(qref);
    return !!(await this.evalIn(frameId, `__tacit.isPassword(${JSON.stringify(ref)})`));
  }

  async describe(qref: string): Promise<string> {
    const { frameId, ref } = await this.frameOfRef(qref);
    return (await this.evalIn(frameId, `__tacit.describe(${JSON.stringify(ref)})`)) ?? qref;
  }

  /** Clears a field's text, focused, so what's typed next replaces it. */
  async clearField(qref: string): Promise<void> {
    const { frameId, ref } = await this.frameOfRef(qref);
    await this.evalIn(frameId, `(() => { const e = __tacit.el(${JSON.stringify(ref)}); if (!e) return false; e.focus(); if ('select' in e && typeof e.select === 'function') e.select(); else { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r); } return true; })()`);
    await this.press("Backspace");
  }

  async selectOptions(qref: string, values: readonly string[]): Promise<string[]> {
    const { frameId, ref } = await this.frameOfRef(qref);
    // Stop pressed while the list was being found: checked right before it changes.
    this.checkpoint?.();
    const r = await this.evalIn(frameId, `(() => { const e = __tacit.el(${JSON.stringify(ref)}); if (!e || e.tagName !== 'SELECT') return { error: 'That is not a list to choose from (a <select>).' }; const want = ${JSON.stringify(values)}; const opts = Array.from(e.options); const match = (o) => want.some((w) => w === o.value || w.trim().toLowerCase() === o.textContent.trim().toLowerCase()); if (e.multiple) { for (const o of opts) o.selected = match(o); } else { const o = opts.find(match); if (o) o.selected = true; } const chosen = opts.filter((o) => o.selected && match(o)).map((o) => o.textContent.trim()); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return { chosen }; })()`);
    if (r.error) throw new DriverError(r.error, "not_select");
    if (!r.chosen.length) throw new DriverError(`None of ${values.map((v) => `"${v}"`).join(", ")} is an option there.`, "no_option");
    return r.chosen;
  }

  async isChecked(qref: string): Promise<boolean> {
    const { frameId, ref } = await this.frameOfRef(qref);
    return !!(await this.evalIn(frameId, `(() => { const e = __tacit.el(${JSON.stringify(ref)}); return !!e && (e.checked === true || e.getAttribute('aria-checked') === 'true'); })()`));
  }

  async setFiles(qref: string, files: readonly string[]): Promise<void> {
    const { frameId, ref } = await this.frameOfRef(qref);
    const obj = await this.evalIn(frameId, `__tacit.control(${JSON.stringify(ref)})`, { byValue: false });
    if (!obj?.objectId) throw new DriverError("That ref is gone: take a new snapshot.", "stale");
    const isFile = await this.evalIn(frameId, `(() => { const e = __tacit.control(${JSON.stringify(ref)}); return !!e && e.tagName === 'INPUT' && e.type === 'file'; })()`);
    if (!isFile) throw new DriverError("That isn't a file picker (an <input type=file>).", "not_file_input");
    const { sessionId } = await this.world(frameId);
    this.checkpoint?.();
    await this.send("DOM.setFileInputFiles", { files, objectId: obj.objectId }, sessionId);
  }

  /** Waits for text to show or go, a ref to show or go, or the address to match. */
  async waitFor(cond: { text?: string; gone?: string; ref?: string; refGone?: string; url?: string }, timeoutMs: number): Promise<string> {
    await this.init();
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000);
    for (;;) {
      this.guardDialog();
      const frames = [...(await this.frameMap()).keys()];
      const anyFrame = async (expr: string) => {
        for (const f of frames) if (await this.evalIn(f, expr).catch(() => false)) return true;
        return false;
      };
      if (cond.url !== undefined && this.page.getURL().includes(cond.url)) return `The address has "${cond.url}".`;
      if (cond.text !== undefined && (await anyFrame(`__tacit.textIncludes(${JSON.stringify(cond.text)})`))) return `"${cond.text}" is on the page.`;
      if (cond.gone !== undefined && !(await anyFrame(`__tacit.textIncludes(${JSON.stringify(cond.gone)})`))) return `"${cond.gone}" is gone.`;
      if (cond.ref !== undefined) {
        const { frameId, ref } = await this.frameOfRef(cond.ref).catch(() => ({ frameId: "", ref: "" }));
        if (frameId && (await this.evalIn(frameId, `__tacit.refVisible(${JSON.stringify(ref)})`).catch(() => false))) return `${cond.ref} is shown.`;
      }
      if (cond.refGone !== undefined) {
        const { frameId, ref } = await this.frameOfRef(cond.refGone).catch(() => ({ frameId: "", ref: "" }));
        if (!frameId || !(await this.evalIn(frameId, `__tacit.refVisible(${JSON.stringify(ref)})`).catch(() => false))) return `${cond.refGone} is gone.`;
      }
      if (Date.now() >= deadline) throw new DriverError("What you waited for didn't happen in time.", "timeout");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** The page's text, every frame's, in pages of `maxChars`. */
  async readText(opts: { maxChars?: number; page?: number } = {}): Promise<{ url: string; title: string; text: string; page: number; pages: number }> {
    await this.init();
    this.guardDialog();
    const frames = await this.frameMap();
    const parts: string[] = [];
    for (const [frameId, info] of frames) {
      const t = await this.evalIn(frameId, "document.body ? document.body.innerText : ''").catch(() => "");
      if (!t || !String(t).trim()) continue;
      parts.push(frameId === this.rootFrameId ? String(t) : `\n--- frame ${this.prefixOf(frameId)} (${info.url.slice(0, 120)}) ---\n${t}`);
    }
    const all = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const size = Math.max(1000, Math.min(opts.maxChars ?? 20_000, 100_000));
    const pages = Math.max(1, Math.ceil(all.length / size));
    const page = Math.min(Math.max(1, opts.page ?? 1), pages);
    return { url: this.page.getURL(), title: this.page.getTitle(), text: all.slice((page - 1) * size, page * size), page, pages };
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    if (!this.dialog) throw new DriverError("No dialog is open.", "no_dialog");
    const d = this.dialog;
    await this.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }, d.sessionId);
    this.dialog = null;
    return `${accept ? "Accepted" : "Dismissed"} the ${d.type}: "${d.message.slice(0, 120)}"`;
  }

  get lastOutline(): string[] | null {
    return this.lastLines;
  }
}
