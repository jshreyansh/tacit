/**
 * Agents' browser actions, carried out in the main process
 * (docs/architecture/browser-agents.md).
 *
 * The window says which tile is which (its page, its backend, whether its
 * profile lets agents act); main checks the page really is a guest of Tacit's
 * own window and does the action itself: on the page through its driver
 * (electron/browser-driver.ts), or through the connected-browser broker.
 *
 * Several agents can read a page at once; one at a time may change it, for as
 * long as it keeps acting (a lease). The person always wins: their own click or
 * key on the page pauses agents there, and Stop on the tile keeps them off.
 */
import { MAX_STEPS, isReadOnlyStep, typesCharacter, type ActStep, type Target } from "../shared/browser-act";
import {
  READ_ONLY_BROWSER_ACTIONS,
  capabilityForBrowserAction,
  isBrowserActionName,
  validateBrowserActionRequest,
  type BrowserActionName,
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserBackendKind,
  type BrowserControllerCapability,
  type BrowserNodeBinding,
} from "../shared/browser-controller";
import { DriverError, PageDriver, type DriverPage, type ReportedInput } from "./browser-driver";
import { pageEvents, type DownloadEvent, type PageEvent, type PageEvents } from "./browser-page-events";

/** What main needs of a tile's page; an Electron guest webContents in the app. */
export interface GuestPage {
  readonly id?: number;
  isDestroyed(): boolean;
  getType(): string;
  /** The window that embeds it; must be Tacit's own. */
  readonly hostWebContents: unknown;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  readonly navigationHistory: { goBack(): void; goForward(): void };
  reload(): void;
  readonly debugger?: DriverPage["debugger"];
  on?(event: "input-event", listener: (event: unknown, input: ReportedInput) => void): unknown;
  once?(event: "destroyed", listener: () => void): unknown;
  /** Off, the page keeps drawing and taking input though its window is covered or in the background. */
  setBackgroundThrottling?(allowed: boolean): void;
}

type Throttled = { setBackgroundThrottling?(allowed: boolean): void; isDestroyed?(): boolean };

function setThrottling(contents: unknown, allowed: boolean): void {
  const c = contents as Throttled | null;
  if (!c || typeof c.setBackgroundThrottling !== "function" || c.isDestroyed?.()) return;
  c.setBackgroundThrottling(allowed);
}

/** The driver's surface the service uses; a fake in tests. */
export type Driver = Pick<
  PageDriver,
  | "snapshot" | "find" | "screenshot" | "readText" | "waitFor" | "handleDialog" | "pointOf" | "pointFromShot" | "mouse" | "hover" | "drag" | "wheel"
  | "press" | "typeKeys" | "insertText" | "viewportCenter" | "drawable" | "refIsPassword" | "refIsEditable" | "describe" | "clearField" | "selectOptions" | "isChecked" | "setFiles"
  | "focusIsPassword" | "isOwnInput" | "checkpoint" | "dialog"
>;

/** Where an action goes: the tile's page, or a connected tab. */
export interface BrowserTarget {
  binding: BrowserNodeBinding;
  /** The managed tile's guest page; null when it isn't mounted. */
  page: GuestPage | null;
  /** Its driver, made when first needed. */
  driver?: () => Driver;
}

export interface BrowserBackendAdapter {
  kind: BrowserBackendKind;
  capabilities: ReadonlySet<BrowserControllerCapability>;
  execute(target: BrowserTarget, request: BrowserActionRequest): Promise<unknown>;
}

/** Validates, picks the backend, and reports what happened in one shape. */
export class BrowserController {
  private readonly adapters = new Map<BrowserBackendKind, BrowserBackendAdapter>();

  register(adapter: BrowserBackendAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  async execute(target: BrowserTarget, actionInput: string, params: Record<string, unknown> = {}): Promise<BrowserActionResult> {
    const kind = target.binding.kind;
    if (!isBrowserActionName(actionInput)) {
      return failure(kind, "navigate", "invalid_request", `Unknown browser action: ${actionInput}`, false);
    }
    const action: BrowserActionName = actionInput;
    const capability = capabilityForBrowserAction(action);
    const adapter = this.adapters.get(kind);
    if (!adapter) return failure(kind, capability, "backend_unavailable", `Browser backend is unavailable: ${kind}`, true);
    if (!adapter.capabilities.has(capability)) {
      return failure(kind, capability, "capability_missing", `The ${kind} browser backend does not support ${capability}`, false);
    }
    const invalid = validateBrowserActionRequest(action, params);
    if (invalid) return failure(kind, capability, "invalid_request", invalid, false);
    try {
      const data = await adapter.execute(target, { action, params });
      return { ok: true, backend: kind, capability, data };
    } catch (error) {
      const code = error instanceof DriverError ? error.code : undefined;
      return failure(kind, capability, "execution_failed", error instanceof Error ? error.message : String(error), code !== "covered" && code !== "invalid_ref", code);
    }
  }
}

function failure(
  backend: BrowserBackendKind,
  capability: BrowserControllerCapability,
  code: Extract<BrowserActionResult, { ok: false }>["error"]["code"],
  message: string,
  retryable: boolean,
  reason?: string,
): BrowserActionResult {
  return { ok: false, backend, capability, error: { code, message, retryable, ...(reason ? { reason } : {}) } } as BrowserActionResult;
}

export interface ManagedDeps {
  /** May this file be given to a page (a file in one of the workdesk's folders)? */
  fileAllowed(path: string): boolean;
  /** Puts text on the clipboard for a paste; returns how to put back what was there. */
  clipboardFor(text: string): () => void;
  /** What pages downloaded and opened (electron/browser-page-events.ts). */
  events?: PageEvents;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a check step waits for the page to show the box ticked. */
const CHECK_SETTLE_MS = 1000;
const CHECK_SETTLE_STEP_MS = 100;

/**
 * The clipboard is the whole computer's: one paste at a time across every tile, each
 * putting back what was there before the next begins.
 */
let clipboardTurn: Promise<unknown> = Promise.resolve();
function withClipboard<T>(run: () => Promise<T>): Promise<T> {
  const mine = clipboardTurn.catch(() => {}).then(run);
  clipboardTurn = mine.catch(() => {});
  return mine;
}

/** Text going where the keyboard is: refused when that's a password field, in any frame. */
async function notIntoPassword(d: Driver): Promise<void> {
  if (await d.focusIsPassword()) throw new DriverError("That's a password field: the person types passwords themselves.", "password");
}

const PASTE_CHORD = process.platform === "darwin" ? "Meta+V" : "Control+V";

/** A managed tile: the action runs on its guest page, from main. */
export function managedAdapter(deps: ManagedDeps): BrowserBackendAdapter {
  return {
    kind: "managed",
    capabilities: new Set(["inspect", "navigate", "back", "forward", "reload", "click", "non_portable_eval", "type", "screenshot", "wait"]),
    async execute(target, request) {
      const { page } = target;
      if (!page) throw new Error("Browser tile not found or not mounted");
      const driver = () => {
        if (!target.driver) throw new Error("This page can't be driven");
        return target.driver();
      };
      const p = request.params;
      switch (request.action) {
        case "navigate":
          await page.loadURL(p.url as string);
          return { url: page.getURL(), title: page.getTitle() };
        case "read":
          return driver().readText({ maxChars: num(p.maxChars), page: num(p.page) });
        case "back":
          page.navigationHistory.goBack();
          return { ok: true };
        case "forward":
          page.navigationHistory.goForward();
          return { ok: true };
        case "reload":
          page.reload();
          return { ok: true };
        case "click": {
          if (typeof p.ref === "string") {
            const d = driver();
            const at = await d.pointOf(p.ref, { enabled: true });
            await d.mouse(at.x, at.y);
            return { ok: true, clicked: await d.describe(p.ref).catch(() => p.ref) };
          }
          const selector = p.selector as string;
          const clicked = await page.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
          );
          if (!clicked) throw new Error(`No element matched selector: ${selector}`);
          return { ok: true };
        }
        case "eval":
          return { result: await page.executeJavaScript(p.script as string) };
        case "snapshot": {
          const s = await driver().snapshot({ maxChars: num(p.maxChars), since: p.since === true });
          // A download or a window that came after the agent's last act, told now.
          const did = await pageDid(deps.events, page.id, Number.POSITIVE_INFINITY, false);
          return { url: s.url, title: s.title, snapshot: s.text, truncated: s.truncated, ...(s.changes ? { changes: s.changes } : {}), ...did };
        }
        case "find":
          return { matches: await driver().find(p.query as string) };
        case "screenshot":
          return driver().screenshot({ maxWidth: num(p.maxWidth), quality: num(p.quality) });
        case "wait":
          return { ok: true, saw: await driver().waitFor({ text: str(p.text), gone: str(p.gone), ref: str(p.ref), refGone: str(p.refGone), url: str(p.url) }, num(p.timeoutMs) ?? 10_000) };
        case "dialog":
          return { ok: true, result: await driver().handleDialog(p.accept === true, str(p.promptText)) };
        case "act":
          return runSteps(driver(), p.steps as ActStep[], deps, page.id);
      }
    },
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

async function pointFor(d: Driver, t: Target, enabled = false): Promise<{ x: number; y: number }> {
  return "ref" in t ? d.pointOf(t.ref, { enabled }) : d.pointFromShot(t.screenshot, t.x, t.y);
}

/** A download, as the agent is told of it. */
function downloadNote(e: DownloadEvent) {
  return {
    file: e.file,
    path: e.path,
    state: e.state,
    bytes: e.bytes,
    ...(e.total > 0 && e.state === "progressing" ? { of: e.total } : {}),
  };
}

const OPENED_AS = {
  tile: "a new browser tile (browser_list shows it; it's now your default browser)",
  window: "a separate window (a sign-in or a pop-up): the person finishes what's in it",
  outside: "the person's own browser, outside Tacit",
} as const;

/** How long an act waits at its end for a download its steps started to finish. */
const SETTLE_DOWNLOAD_MS = 15_000;

/** What the page did besides change: downloads (waiting a little for them to finish) and windows opened. */
async function pageDid(events: PageEvents | undefined, pageId: number | undefined, since: number, settle = true) {
  if (!events || pageId === undefined) return {};
  if (settle) await events.waitFor(pageId, since, (evs) => (evs.some((e) => e.kind === "download" && e.state === "progressing") ? null : true), SETTLE_DOWNLOAD_MS);
  const evs = events.take(pageId, since);
  const downloads = evs.filter((e): e is DownloadEvent => e.kind === "download").map(downloadNote);
  const opened = evs.filter((e): e is Extract<PageEvent, { kind: "opened" }> => e.kind === "opened").map((e) => ({ url: e.url, as: OPENED_AS[e.as] }));
  return { ...(downloads.length ? { downloads } : {}), ...(opened.length ? { opened } : {}) };
}

/** Where a run of steps is: its page and when it began, for what the page did since. */
interface RunContext {
  events?: PageEvents;
  pageId?: number;
  since: number;
}

/** Steps in order, stopping at the first that fails; then what changed on the page. */
export async function runSteps(d: Driver, steps: ActStep[], deps: ManagedDeps, pageId?: number) {
  const ctx: RunContext = { events: deps.events, pageId, since: deps.events?.now() ?? Date.now() };
  const done: Array<{ step: number; do: string; ok: boolean; note?: string; error?: string; reason?: string }> = [];
  for (const [i, s] of steps.slice(0, MAX_STEPS).entries()) {
    try {
      // Stop, the person's hands, another agent: checked before each step too, so a step that
      // sends no key or click (choosing an option, giving a file) is stopped as well.
      if (!isReadOnlyStep(s)) d.checkpoint?.();
      const note = await runStep(d, s, deps, ctx);
      done.push({ step: i + 1, do: s.do, ok: true, ...(note ? { note } : {}) });
      if (!isReadOnlyStep(s)) await sleep(60);
    } catch (e) {
      done.push({ step: i + 1, do: s.do, ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof DriverError ? { reason: e.code } : {}) });
      break;
    }
  }
  const ok = done.length === steps.length && done.every((x) => x.ok);
  const did = await pageDid(ctx.events, ctx.pageId, ctx.since);
  let after: Awaited<ReturnType<Driver["snapshot"]>> | null = null;
  try {
    after = await d.snapshot({ maxChars: 1, since: true });
  } catch {
    // A dialog opened, or the page is gone: said below.
  }
  return {
    ok,
    steps: done,
    ...(after ? { url: after.url, title: after.title } : {}),
    ...(after?.changes ? { changes: after.changes } : { note: "Take browser_snapshot to see the page." }),
    ...(d.dialog ? { dialog: { type: d.dialog.type, message: d.dialog.message.slice(0, 300) } } : {}),
    ...did,
  };
}

/** How long a wait for a download gives it to start, and to finish. */
const DOWNLOAD_START_MS = 10_000;
const DOWNLOAD_FINISH_MS = 120_000;

/** Waits for a download these steps started (or one that starts now) to finish. */
async function waitForDownload(ctx: RunContext): Promise<string> {
  const { events, pageId, since } = ctx;
  if (!events || pageId === undefined) throw new DriverError("Downloads can't be watched on this page.", "unsupported");
  const latest = (evs: PageEvent[]) => evs.filter((e): e is DownloadEvent => e.kind === "download").pop();
  const started = await events.waitFor(pageId, since, latest, DOWNLOAD_START_MS);
  if (!started) throw new DriverError("No download started. Click the link or button that downloads the file first, in the same browser_act.", "no_download");
  const ended = await events.waitFor(pageId, since, (evs) => {
    const e = evs.find((x): x is DownloadEvent => x.kind === "download" && x.id === started.id);
    return e && e.state !== "progressing" ? e : null;
  }, DOWNLOAD_FINISH_MS);
  if (!ended) {
    const now = latest(events.since(pageId, since));
    return `still downloading ${started.file} (${now?.bytes ?? 0} of ${now?.total || "?"} bytes) after ${DOWNLOAD_FINISH_MS / 1000} s`;
  }
  if (ended.state !== "completed") throw new DriverError(`The download of ${ended.file} was ${ended.state}.`, "download_failed");
  return `downloaded ${ended.file} (${ended.bytes} bytes) to ${ended.path}`;
}

async function runStep(d: Driver, s: ActStep, deps: ManagedDeps, ctx: RunContext): Promise<string | void> {
  switch (s.do) {
    case "click": {
      const at = await pointFor(d, s, true);
      await d.mouse(at.x, at.y, { button: s.button, count: s.count });
      return "ref" in s ? `clicked ${await d.describe(s.ref).catch(() => s.ref)}` : `clicked at ${Math.round(at.x)},${Math.round(at.y)}`;
    }
    case "hover": {
      const at = await pointFor(d, s);
      await d.hover(at.x, at.y);
      return;
    }
    case "fill": {
      if (await d.refIsPassword(s.ref)) throw new DriverError("That's a password field: the person types passwords themselves.", "password");
      if (!(await d.refIsEditable(s.ref))) throw new DriverError(`${await d.describe(s.ref).catch(() => s.ref)} isn't something to type into. Fill a textbox; for a spreadsheet or canvas, click it and use type.`, "not_editable");
      const at = await d.pointOf(s.ref, { enabled: true });
      await d.mouse(at.x, at.y);
      await notIntoPassword(d);
      await d.clearField(s.ref);
      if (s.text) await d.insertText(s.text);
      return;
    }
    case "type": {
      if (s.ref) {
        if (await d.refIsPassword(s.ref)) throw new DriverError("That's a password field: the person types passwords themselves.", "password");
        const at = await d.pointOf(s.ref, { enabled: true });
        await d.mouse(at.x, at.y);
      }
      // A Tab or Enter moves the keyboard (maybe into a password field): checked again after each.
      for (const part of s.text.split(/([\t\n])/)) {
        if (!part) continue;
        if (part === "\t" || part === "\n") { await d.typeKeys(part); continue; }
        await notIntoPassword(d);
        await d.typeKeys(part);
      }
      return;
    }
    case "press":
      for (const k of s.keys) {
        // A key that types a character is typing.
        if (typesCharacter(k)) await notIntoPassword(d);
        await d.press(k);
      }
      return;
    case "paste": {
      if (s.ref) {
        if (await d.refIsPassword(s.ref)) throw new DriverError("That's a password field: the person types passwords themselves.", "password");
        const at = await d.pointOf(s.ref, { enabled: true });
        await d.mouse(at.x, at.y);
      }
      await notIntoPassword(d);
      // Through the clipboard, as a person pastes, then what was there is put back.
      await withClipboard(async () => {
        const restore = deps.clipboardFor(s.text);
        try {
          await d.press(PASTE_CHORD);
          await sleep(250);
        } finally {
          restore();
        }
      });
      return;
    }
    case "select":
      return `chose ${(await d.selectOptions(s.ref, s.values)).join(", ")}`;
    case "check": {
      if ((await d.isChecked(s.ref)) === s.checked) return "already so";
      const at = await d.pointOf(s.ref, { enabled: true });
      await d.mouse(at.x, at.y);
      // Some pages tick it a moment after the click (Google Forms, Notion's to-dos).
      for (let waited = 0; (await d.isChecked(s.ref)) !== s.checked; waited += CHECK_SETTLE_STEP_MS) {
        if (waited >= CHECK_SETTLE_MS) throw new DriverError("Clicking it didn't change it.", "unchanged");
        await sleep(CHECK_SETTLE_STEP_MS);
      }
      return;
    }
    case "scroll": {
      const at = s.ref ? await d.pointOf(s.ref) : await d.viewportCenter();
      if (s.dx || s.dy || !s.ref) await d.wheel(at.x, at.y, s.dx ?? 0, s.dy ?? (s.ref ? 0 : 600));
      return;
    }
    case "drag": {
      const from = await pointFor(d, s.from);
      const to = await pointFor(d, s.to);
      await d.drag(from, to);
      return;
    }
    case "upload": {
      const refused = s.paths.filter((p) => !deps.fileAllowed(p));
      if (refused.length) throw new DriverError(`Only files in this workdesk's folders can be given to a page; not ${refused.join(", ")}.`, "file_not_allowed");
      await d.setFiles(s.ref, s.paths);
      return `gave ${s.paths.length} file${s.paths.length === 1 ? "" : "s"}`;
    }
    case "wait":
      if (s.download) return waitForDownload(ctx);
      if (s.ms !== undefined) await sleep(s.ms);
      else return d.waitFor({ text: s.text, gone: s.gone }, 10_000);
      return;
  }
}

/** A connected tab in the person's own browser, through the extension's broker. */
export function connectedTabAdapter(execute: (bindingId: string, action: BrowserActionName, params: Record<string, unknown>) => Promise<unknown>): BrowserBackendAdapter {
  return {
    kind: "connected-tab",
    capabilities: new Set(["inspect", "navigate", "back", "forward", "reload", "click"]),
    async execute({ binding }, request) {
      if (binding.kind !== "connected-tab") throw new Error("Connected-tab adapter received an incompatible browser binding");
      if (request.action !== "read" && request.action !== "navigate" && request.action !== "back" && request.action !== "forward" && request.action !== "reload" && request.action !== "click") {
        throw new Error(`"${request.action}" isn't available in a connected browser tab yet`);
      }
      return execute(binding.tabBindingId, request.action, request.params);
    },
  };
}

/** What the window knows about a tile, asked once per action. */
export interface BrowserTileContext {
  exists: boolean;
  binding: BrowserNodeBinding | null;
  /** The guest page's webContents id; null when the tile isn't mounted. */
  webContentsId: number | null;
  /** Whether its profile lets agents act on it now (src/browser/agentBrowserProfiles.ts). */
  permission: { allowed: true } | { allowed: false; code: string; message: string };
}

/** Who is driving a tile, for the bar on it. */
export interface DriverState {
  /** The agent changing the page now, as a terminal ref; null when none. */
  driver: string | null;
  /** Agents are kept off: the person is using it, or pressed Stop. */
  held: "user" | "stopped" | null;
}

export interface BrowserServiceDeps extends Partial<ManagedDeps> {
  context(cardId: string): Promise<BrowserTileContext>;
  /** A webContents by id, if it exists. */
  pageById(id: number): GuestPage | null;
  /** Tacit's own window's webContents: a tile's page must be its guest. */
  hostWebContents(): unknown;
  connected(bindingId: string, action: BrowserActionName, params: Record<string, unknown>): Promise<unknown>;
  /** Into the record (shared/capture.ts browser_action). */
  record(entry: { node: string; action: string; backend: BrowserBackendKind; by: string; ok: boolean; url?: string; error?: string }): void;
  /** Tells the window who is driving a tile now. */
  notify?(cardId: string, state: DriverState): void;
  /**
   * Keeps Tacit's window drawing at full rate a while longer: its background throttling is
   * one switch, kept by the render throttling coordinator (electron/render-throttling-coordinator.ts).
   */
  windowActive?(): void;
  /** Keeps a tile drawn while it's driven, though off screen or behind the grid; and lets it go. */
  wake?(cardId: string): Promise<void>;
  sleep?(cardId: string): Promise<void>;
  makeDriver?(page: GuestPage): Driver;
  /** Whether Tacit's window has its keyboard on this page (its focused element is this tile). */
  pageHasKeyboard?(pageId: number): Promise<boolean>;
  /** A screenshot's PNG (base64) on white, as a JPEG at most this wide: it comes at the screen's density. */
  jpegOf?(pngBase64: string, width: number, quality: number): { data: string; width: number; height: number };
  now?(): number;
}

export class BrowserActionError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/**
 * Who a browser action is done for: only a terminal that proved who it is
 * (electron/terminal-credentials.ts), and only as itself. The launch token
 * alone says nothing about which terminal is asking, so a call without a
 * proven terminal is refused rather than treated as Tacit's own.
 */
export function checkBrowserCaller(caller: string | null, claimed: unknown): string {
  if (!caller) {
    throw new BrowserActionError(
      "This call didn't come with its terminal's credential, so Tacit can't tell which terminal is asking. Browser tools work from an agent's terminal in Tacit.",
      401,
      "unverified_terminal",
    );
  }
  if (typeof claimed === "string" && claimed !== `terminal:${caller}`) {
    throw new BrowserActionError("The terminal named in this call isn't the one that sent it.", 403, "caller_mismatch");
  }
  return `terminal:${caller}`;
}

/** How long an agent keeps a tile to itself after its last change. */
export const LEASE_MS = 30_000;
/** How long agents stay off after the person clicks or types on the page, or presses Stop. */
export const USER_HOLD_MS = 15_000;
export const STOP_HOLD_MS = 120_000;
/** How long a woken tile stays drawn after the last action. */
const AWAKE_MS = 10_000;

/** Whether an action changes the page. */
export function changesPage(action: string, params: Record<string, unknown>): boolean {
  if (READ_ONLY_BROWSER_ACTIONS.has(action as BrowserActionName)) return false;
  if (action === "act" && Array.isArray(params.steps)) return !(params.steps as ActStep[]).every((s) => s && isReadOnlyStep(s));
  return true;
}

export class BrowserService {
  private readonly controller = new BrowserController();
  private readonly drivers = new Map<number, Driver>();
  private readonly cardOfPage = new Map<number, string>();
  private readonly leases = new Map<string, { actor: string; since: number; until: number }>();
  private readonly holds = new Map<string, { until: number; why: "user" | "stopped" }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly awake = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly expiry = new Map<string, ReturnType<typeof setTimeout>>();
  /** When the person last clicked or pressed a key on each tile's page. */
  private readonly personAt = new Map<string, number>();
  /** The same, by page, for a page no agent has touched yet (its tile isn't known here). */
  private readonly personAtPage = new Map<number, number>();
  private readonly watched = new Set<number>();
  /** Driven actions running on each tile now: it sleeps only once none is. */
  private readonly drawing = new Map<string, number>();

  constructor(private readonly deps: BrowserServiceDeps) {
    this.controller.register(managedAdapter({
      fileAllowed: deps.fileAllowed ?? (() => false),
      clipboardFor: deps.clipboardFor ?? (() => () => {}),
      events: deps.events ?? pageEvents,
    }));
    this.controller.register(connectedTabAdapter(deps.connected));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A tile's page, only if it is a guest of Tacit's own window. */
  private guest(id: number | null): GuestPage | null {
    if (id === null || !Number.isInteger(id)) return null;
    const page = this.deps.pageById(id);
    if (!page || page.isDestroyed() || page.getType() !== "webview") return null;
    const host = this.deps.hostWebContents();
    return host && page.hostWebContents === host ? page : null;
  }

  private driverFor(page: GuestPage, pageId: number, cardId: string): Driver {
    this.cardOfPage.set(pageId, cardId);
    let d = this.drivers.get(pageId);
    if (d) return d;
    if (!this.deps.makeDriver && !page.debugger) throw new Error("This page can't be driven");
    if (this.deps.makeDriver) d = this.deps.makeDriver(page);
    else {
      const real = new PageDriver(page as unknown as DriverPage);
      const has = this.deps.pageHasKeyboard;
      if (has) real.keyboardHere = () => has(pageId);
      if (this.deps.jpegOf) real.jpegOf = this.deps.jpegOf;
      d = real;
    }
    this.drivers.set(pageId, d);
    this.watch(page, pageId);
    return d;
  }

  /**
   * Watches a tile's page for the person's own clicks and keys, from when it's attached
   * (main calls this), so input before any agent came is seen too. A press is the agent's
   * only if its driver sent one the page hasn't reported yet.
   */
  watch(page: GuestPage, pageId: number = page.id ?? -1): void {
    if (pageId < 0 || this.watched.has(pageId)) return;
    this.watched.add(pageId);
    page.on?.("input-event", (_e, input) => {
      if (input.type !== "mouseDown" && input.type !== "keyDown" && input.type !== "rawKeyDown") return;
      if (this.drivers.get(pageId)?.isOwnInput(input)) return;
      this.personAtPage.set(pageId, this.now());
      const card = this.cardOfPage.get(pageId);
      if (card) this.personUsed(card);
    });
    page.once?.("destroyed", () => {
      this.drivers.delete(pageId);
      this.cardOfPage.delete(pageId);
      this.personAtPage.delete(pageId);
      this.watched.delete(pageId);
    });
  }

  private state(cardId: string): DriverState {
    const now = this.now();
    const lease = this.leases.get(cardId);
    const hold = this.holds.get(cardId);
    return { driver: lease && lease.until > now ? lease.actor : null, held: hold && hold.until > now ? hold.why : null };
  }

  private tell(cardId: string): void {
    this.deps.notify?.(cardId, this.state(cardId));
  }

  /**
   * The person clicked or typed on a tile. Agents wait until they've been still for a
   * while; the bar says so when an agent is on the tile or already waiting, not on every click.
   */
  personUsed(cardId: string): void {
    this.personAt.set(cardId, this.now());
    const hold = this.holds.get(cardId);
    if (hold?.why === "stopped" && hold.until > this.now()) return;
    if (this.leases.has(cardId) || (hold && hold.until > this.now())) this.hold(cardId, "user", USER_HOLD_MS);
  }

  /** Agents off this tile for a while: the person is using it, or pressed Stop. */
  hold(cardId: string, why: "user" | "stopped", ms: number): void {
    this.holds.set(cardId, { until: this.now() + ms, why });
    this.leases.delete(cardId);
    this.tell(cardId);
    this.schedule(cardId, ms);
  }

  /** The person let agents back on (Resume on the tile). */
  release(cardId: string): void {
    this.holds.delete(cardId);
    // Resume is the person saying "go ahead": their own clicks before it don't hold agents off.
    this.personAt.delete(cardId);
    for (const [pageId, card] of this.cardOfPage) if (card === cardId) this.personAtPage.delete(pageId);
    this.leases.delete(cardId);
    this.tell(cardId);
  }

  private schedule(cardId: string, ms: number): void {
    clearTimeout(this.expiry.get(cardId));
    this.expiry.set(cardId, setTimeout(() => this.tell(cardId), ms + 50));
  }

  /** Whether `actor` may change the tile now; throws why not. Takes nothing. */
  private mayChange(cardId: string, actor: string): void {
    const now = this.now();
    const hold = this.holds.get(cardId);
    if (hold && hold.until > now) {
      const s = Math.ceil((hold.until - now) / 1000);
      throw hold.why === "stopped"
        ? new BrowserActionError(`The person pressed Stop on this browser: agents are kept off it for ${s} s more, or until they press Resume. Reading still works.`, 409, "stopped_by_user")
        : new BrowserActionError(`The person is using this browser: wait ${s} s and try again. Reading still works.`, 409, "user_driving");
    }
    const person = this.personAt.get(cardId);
    if (person !== undefined && now - person < USER_HOLD_MS) {
      throw new BrowserActionError(`The person is using this browser: wait ${Math.ceil((person + USER_HOLD_MS - now) / 1000)} s and try again. Reading still works.`, 409, "user_driving");
    }
    const lease = this.leases.get(cardId);
    if (lease && lease.actor !== actor && lease.until > now) {
      throw new BrowserActionError(`Another agent (${lease.actor}) is changing this page, for the last ${Math.round((now - lease.since) / 1000)} s. Reading still works; try again in a little while.`, 409, "busy");
    }
  }

  /** Whether `actor` may change the tile now; takes or renews its lease. */
  private claim(cardId: string, actor: string): void {
    this.mayChange(cardId, actor);
    const now = this.now();
    const lease = this.leases.get(cardId);
    const fresh = !lease || lease.actor !== actor || lease.until <= now;
    this.leases.set(cardId, { actor, since: fresh ? now : lease!.since, until: now + LEASE_MS });
    if (fresh) this.tell(cardId);
    this.schedule(cardId, LEASE_MS);
  }

  /** One change at a time on a tile, in the order asked. */
  private serial<T>(cardId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(cardId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.queues.set(cardId, next.catch(() => {}));
    return next;
  }

  /**
   * Keeps a tile drawn while it's driven: a hidden one drops input and gives no picture.
   * Off screen or behind the grid, the window places it where it still draws; with Tacit's
   * window covered or in the background, Chromium stops drawing the whole window, so its
   * background throttling is off for as long as a tile is kept awake.
   */
  private async keepAwake(cardId: string, driver: Driver, page: GuestPage): Promise<void> {
    // Awake until every action on it is over; the countdown to sleep starts then (restAfter).
    this.drawing.set(cardId, (this.drawing.get(cardId) ?? 0) + 1);
    clearTimeout(this.awake.get(cardId));
    this.awake.set(cardId, undefined as unknown as ReturnType<typeof setTimeout>);
    this.deps.windowActive?.();
    setThrottling(page, false);
    if (await driver.drawable()) return;
    if (!this.deps.wake) throw new DriverError("The browser tile isn't on screen, so its page can't be driven. Ask the person to show it.", "hidden");
    await this.deps.wake(cardId);
    for (let i = 0; i < 12; i++) {
      if (await driver.drawable()) return;
      await sleep(150);
    }
    throw new DriverError("The browser tile isn't on screen and couldn't be brought back. Ask the person to show it.", "hidden");
  }

  /** After a driven action: the tile stays drawn a little longer, then goes back. */
  private restAfter(cardId: string, page: GuestPage): void {
    const left = (this.drawing.get(cardId) ?? 1) - 1;
    this.deps.windowActive?.();
    if (left > 0) { this.drawing.set(cardId, left); return; }
    this.drawing.delete(cardId);
    clearTimeout(this.awake.get(cardId));
    this.awake.set(cardId, setTimeout(() => {
      this.awake.delete(cardId);
      setThrottling(page, true);
      void this.deps.sleep?.(cardId);
    }, AWAKE_MS));
  }

  /**
   * Does `action` on tile `cardId` for `actor` (a terminal ref, or "user" for
   * the person's own Send on a wire). The caller has already checked the actor
   * may: for a terminal, that it proved who it is and is wired to this tile.
   */
  async drive(cardId: string, action: string, params: Record<string, unknown>, actor: string): Promise<unknown> {
    const ctx = await this.deps.context(cardId);
    if (!ctx.exists || !ctx.binding) throw new BrowserActionError(`Browser card not found: ${cardId}`, 404, "not_found");
    const node = `browser:${cardId}`;
    const url = typeof params.url === "string" ? params.url : undefined;
    // Re-checked on every action: revoking a profile stops a task already running.
    if (!ctx.permission.allowed) {
      const message = `${ctx.permission.code}: ${ctx.permission.message}`;
      this.deps.record({ node, action, backend: ctx.binding.kind, by: actor, ok: false, error: message });
      throw new BrowserActionError(message, 403, ctx.permission.code);
    }
    const writes = changesPage(action, params);
    // The person's input on this page before any agent drove it counts too. Which tile the
    // page is, known from here on (so Resume clears it, even if this action is refused).
    if (ctx.webContentsId !== null) {
      this.cardOfPage.set(ctx.webContentsId, cardId);
      const before = this.personAtPage.get(ctx.webContentsId);
      if (before !== undefined && before > (this.personAt.get(cardId) ?? 0)) this.personAt.set(cardId, before);
    }
    if (writes && actor !== "user") this.claim(cardId, actor);
    const binding = ctx.binding;
    const page = binding.kind === "managed" ? this.guest(ctx.webContentsId) : null;
    const pageId = ctx.webContentsId;
    const target: BrowserTarget = {
      binding,
      page,
      ...(page && pageId !== null ? { driver: () => this.driverFor(page, pageId, cardId) } : {}),
    };
    const run = async () => {
      if (writes && actor !== "user") {
        // Its turn may come after the person pressed Stop, or took the profile's permission
        // away, while it waited behind another action: asked again now.
        const now = await this.deps.context(cardId);
        if (!now.exists || !now.permission.allowed) {
          const message = now.exists && !now.permission.allowed ? `${now.permission.code}: ${now.permission.message}` : `Browser card not found: ${cardId}`;
          this.deps.record({ node, action, backend: binding.kind, by: actor, ok: false, error: message });
          throw new BrowserActionError(message, now.exists ? 403 : 404, now.exists && !now.permission.allowed ? now.permission.code : "not_found");
        }
        this.claim(cardId, actor);
      }
      const needsDrawing = binding.kind === "managed" && page && pageId !== null && (writes || action === "screenshot") && (action === "act" || action === "screenshot" || (action === "click" && typeof params.ref === "string"));
      const driver = page && pageId !== null ? this.driverFor(page, pageId, cardId) : null;
      try {
        if (needsDrawing) {
          try {
            await this.keepAwake(cardId, driver!, page!);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.deps.record({ node, action, backend: binding.kind, by: actor, ok: false, error: message });
            throw new BrowserActionError(message, 409, e instanceof DriverError ? e.code : "hidden");
          }
        }
        // Stop, the person's hands, or another agent's lease stop it between any two input events.
        // Only a change sets it, and only its own is taken away after: a read at the same time
        // leaves it be.
        const check = driver && writes && actor !== "user" ? () => this.mayChange(cardId, actor) : null;
        if (check) driver!.checkpoint = check;
        try {
          return await this.controller.execute(target, action, params);
        } finally {
          if (check && driver!.checkpoint === check) driver!.checkpoint = null;
        }
      } finally {
        if (needsDrawing) this.restAfter(cardId, page!);
      }
    };
    const result = writes ? await this.serial(cardId, run) : await run();
    this.deps.record({ node, action, backend: result.backend, by: actor, ok: result.ok, ...(url ? { url } : {}), ...(!result.ok ? { error: result.error.message } : {}) });
    if (!result.ok) {
      const reason = (result.error as { reason?: string }).reason;
      const status = result.error.code === "invalid_request" || result.error.code === "capability_missing" ? 400 : reason === "dialog_open" || reason === "hidden" ? 409 : reason === "stale" || reason === "covered" || reason === "timeout" ? 422 : 500;
      throw new BrowserActionError(`${result.error.code}: ${result.error.message}`, status, reason ?? result.error.code);
    }
    return result.data;
  }

  /** Who drives each tile now: what browser_list says. */
  driverOf(cardId: string): DriverState {
    return this.state(cardId);
  }
}
