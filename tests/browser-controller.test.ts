import test from "node:test";
import assert from "node:assert/strict";
import {
  BrowserController,
  BrowserService,
  checkBrowserCaller,
  changesPage,
  type BrowserTarget,
  type BrowserTileContext,
  type Driver,
  type GuestPage,
} from "../electron/browser-service";
import { managedBrowserBinding, normalizeBrowserNodeBinding } from "../shared/browser-controller";

const managed: BrowserTarget = { binding: managedBrowserBinding("identity-default"), page: null };

test("controller validates requests before invoking an adapter", async () => {
  let calls = 0;
  const controller = new BrowserController();
  controller.register({ kind: "managed", capabilities: new Set(["navigate"]), async execute() { calls += 1; return { ok: true }; } });
  const result = await controller.execute(managed, "navigate", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_request");
  assert.equal(calls, 0);
});

test("missing capabilities fail clearly before execution", async () => {
  const controller = new BrowserController();
  controller.register({ kind: "managed", capabilities: new Set(["inspect"]), async execute() { throw new Error("must not run"); } });
  const result = await controller.execute(managed, "click", { selector: "button" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "capability_missing");
    assert.match(result.error.message, /click/);
  }
});

test("controller routes a valid action through the matching backend", async () => {
  const controller = new BrowserController();
  controller.register({
    kind: "managed",
    capabilities: new Set(["inspect"]),
    async execute(target, request) {
      assert.equal(target.binding.kind, "managed");
      assert.equal(request.action, "read");
      return { text: "hello" };
    },
  });
  assert.deepEqual(await controller.execute(managed, "read"), { ok: true, backend: "managed", capability: "inspect", data: { text: "hello" } });
});

test("eval is explicitly negotiated as a non-portable escape hatch", async () => {
  const controller = new BrowserController();
  controller.register({ kind: "managed", capabilities: new Set(["non_portable_eval"]), async execute() { return 42; } });
  const result = await controller.execute(managed, "eval", { script: "6 * 7" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.capability, "non_portable_eval");
});

test("malformed persisted backend bindings fall back to the safe managed identity", () => {
  assert.deepEqual(normalizeBrowserNodeBinding({ kind: "connected-tab", connectionId: "spoof", tabBindingId: "" }, "identity-safe"), {
    kind: "managed",
    engine: "legacy-webview",
    identityId: "identity-safe",
  });
});

// --- The service in main: which page, whose profile, what's recorded. ---

const HOST = { id: "tacit-window" };
function page(over: Partial<GuestPage> = {}): GuestPage & { loaded: string[]; ran: string[] } {
  const loaded: string[] = [];
  const ran: string[] = [];
  let url = "https://example.com/";
  return {
    loaded,
    ran,
    isDestroyed: () => false,
    getType: () => "webview",
    hostWebContents: HOST,
    loadURL: async (u: string) => { loaded.push(u); url = u; },
    getURL: () => url,
    getTitle: () => "Example",
    executeJavaScript: async (code: string) => { ran.push(code); return code.includes("innerText") ? "Hello" : true; },
    navigationHistory: { goBack() {}, goForward() {} },
    reload() {},
    ...over,
  };
}
/** A driver that answers reading and records input, for the service's own logic. */
function fakeDriver(over: Partial<Driver> = {}): Driver & { inputs: string[] } {
  const inputs: string[] = [];
  // Like PageDriver.input: the service's checkpoint before each input event.
  const input = (what: string) => { drv.checkpoint?.(); inputs.push(what); };
  const drv = {
    inputs,
    checkpoint: null,
    isOwnInput: () => false,
    focusIsPassword: async () => false,
    dialog: null,
    snapshot: async () => ({ url: "https://example.com/", title: "Example", text: "- button \"Save\" [e1]", lines: ['- button "Save" [e1]'], truncated: false }),
    find: async () => [],
    screenshot: async () => ({ id: "s1", data: "", mimeType: "image/jpeg", width: 10, height: 10, scale: 1 }),
    readText: async () => ({ url: "https://tacit.test/", title: "Example", text: "Hello", page: 1, pages: 1 }),
    waitFor: async () => "ok",
    handleDialog: async () => "ok",
    pointOf: async () => ({ x: 10, y: 20 }),
    pointFromShot: (_id, x, y) => ({ x, y }),
    mouse: async (x, y) => input(`click ${x},${y}`),
    hover: async () => {},
    drag: async () => {},
    wheel: async () => {},
    press: async (k) => input(`press ${k}`),
    typeKeys: async (t) => input(`type ${t}`),
    insertText: async (t) => input(`insert ${t}`),
    viewportCenter: async () => ({ x: 0, y: 0 }),
    drawable: async () => true,
    refIsPassword: async () => false,
    refIsEditable: async () => true,
    describe: async (r) => r,
    clearField: async () => {},
    selectOptions: async () => ["A"],
    isChecked: async () => false,
    setFiles: async () => {},
    ...over,
  } as Driver & { inputs: string[] };
  return drv;
}

function service(opts: { ctx?: Partial<BrowserTileContext>; pages?: Record<number, GuestPage>; host?: unknown; driver?: Driver; now?: () => number } = {}) {
  const records: Array<Record<string, unknown>> = [];
  const connected: unknown[] = [];
  const s = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: { allowed: true }, ...opts.ctx }) as BrowserTileContext,
    pageById: (id) => (opts.pages ?? {})[id] ?? null,
    hostWebContents: () => ("host" in opts ? opts.host : HOST),
    connected: async (...args) => { connected.push(args); return { ok: true }; },
    record: (e) => void records.push(e),
    makeDriver: () => opts.driver ?? fakeDriver(),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { s, records, connected };
}

test("a tile's action runs on its page in main, and is recorded with who asked", async () => {
  const p = page();
  const { s, records } = service({ pages: { 7: p } });
  assert.deepEqual(await s.drive("browser-1", "navigate", { url: "https://tacit.test/" }, "terminal:t1"), { url: "https://tacit.test/", title: "Example" });
  assert.deepEqual(p.loaded, ["https://tacit.test/"]);
  assert.deepEqual(await s.drive("browser-1", "read", {}, "terminal:t1"), { url: "https://tacit.test/", title: "Example", text: "Hello", page: 1, pages: 1 });
  assert.deepEqual(records.map((r) => [r.node, r.action, r.by, r.ok]), [
    ["browser:browser-1", "navigate", "terminal:t1", true],
    ["browser:browser-1", "read", "terminal:t1", true],
  ]);
});

test("only a guest of Tacit's own window is acted on: another page, a destroyed one, or no window are refused", async () => {
  for (const [label, pages, host] of [
    ["another window's page", { 7: page({ hostWebContents: { id: "elsewhere" } }) }, HOST],
    ["not a guest page", { 7: page({ getType: () => "window" }) }, HOST],
    ["destroyed", { 7: page({ isDestroyed: () => true }) }, HOST],
    ["no such page", {}, HOST],
    ["no window", { 7: page() }, null],
  ] as const) {
    const { s, records } = service({ pages, host });
    await assert.rejects(s.drive("browser-1", "navigate", { url: "https://x.test/" }, "terminal:t1"), /not found or not mounted/, label);
    assert.equal(records[0].ok, false, label);
  }
});

test("a profile that no longer lets agents act stops the action, and the refusal is recorded", async () => {
  const p = page();
  const { s, records } = service({ pages: { 7: p }, ctx: { permission: { allowed: false, code: "profile_revoked", message: "You took this profile back." } } });
  await assert.rejects(s.drive("browser-1", "navigate", { url: "https://x.test/" }, "terminal:t1"), (e: { status: number; code: string }) => e.status === 403 && e.code === "profile_revoked");
  assert.deepEqual(p.loaded, []);
  assert.equal(records[0].ok, false);
});

test("a connected tab goes to the broker, never to a page, and refuses scripts", async () => {
  const { s, connected } = service({
    ctx: { binding: { kind: "connected-tab", connectionId: "c1", tabBindingId: "tb1", browser: "chrome", profileLabel: "Me" }, webContentsId: null },
  });
  assert.deepEqual(await s.drive("browser-1", "read", {}, "terminal:t1"), { ok: true });
  assert.deepEqual(connected, [["tb1", "read", {}]]);
  await assert.rejects(s.drive("browser-1", "eval", { script: "1" }, "terminal:t1"), (e: { status: number }) => e.status === 400);
});

test("an unknown tile is a 404, not a crash", async () => {
  const { s } = service({ ctx: { exists: false, binding: null } });
  await assert.rejects(s.drive("nope", "read", {}, "terminal:t1"), (e: { status: number }) => e.status === 404);
});

test("only a terminal that proved who it is may drive a browser, and only as itself", () => {
  assert.equal(checkBrowserCaller("t1", undefined), "terminal:t1");
  assert.equal(checkBrowserCaller("t1", "terminal:t1"), "terminal:t1");
  assert.throws(() => checkBrowserCaller(null, "terminal:t1"), (e: { status: number; code: string }) => e.status === 401 && e.code === "unverified_terminal");
  assert.throws(() => checkBrowserCaller(null, undefined), (e: { code: string }) => e.code === "unverified_terminal", "no claim at all isn't 'system' any more");
  assert.throws(() => checkBrowserCaller("t1", "terminal:t2"), (e: { status: number; code: string }) => e.status === 403 && e.code === "caller_mismatch");
});

test("real input: a click on a ref, then typing, goes to the page's driver in order, with what changed", async () => {
  const d = fakeDriver();
  const { s } = service({ pages: { 7: page() }, driver: d });
  const r = (await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }, { do: "type", text: "Name" }, { do: "press", keys: ["Tab"] }] }, "terminal:t1")) as { ok: boolean; steps: Array<{ ok: boolean }> };
  assert.equal(r.ok, true);
  assert.deepEqual(d.inputs, ["click 10,20", "type Name", "press Tab"]);
});

test("a step that fails stops the rest, and says why", async () => {
  const d = fakeDriver({ pointOf: async () => { throw Object.assign(new Error('button "Save" is covered by dialog "Cookies".'), { code: "covered" }); } });
  const { s } = service({ pages: { 7: page() }, driver: d });
  const r = (await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }, { do: "type", text: "x" }] }, "terminal:t1")) as { ok: boolean; steps: Array<{ ok: boolean; error?: string }> };
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 1);
  assert.match(r.steps[0].error!, /covered by dialog "Cookies"/);
  assert.deepEqual(d.inputs, []);
});

test("passwords are the person's: fill or type into a password field is refused", async () => {
  const d = fakeDriver({ refIsPassword: async () => true });
  const { s } = service({ pages: { 7: page() }, driver: d });
  const r = (await s.drive("browser-1", "act", { steps: [{ do: "fill", ref: "e2", text: "hunter2" }] }, "terminal:t1")) as { ok: boolean; steps: Array<{ error?: string }> };
  assert.equal(r.ok, false);
  assert.match(r.steps[0].error!, /password/);
  assert.deepEqual(d.inputs, []);
});

test("one agent changes a page at a time; another may still read it, and gets the page back when the first goes quiet", async () => {
  let t = 1_000_000;
  const { s } = service({ pages: { 7: page() }, now: () => t });
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:b"), (e: { status: number; code: string }) => e.status === 409 && e.code === "busy");
  assert.ok(await s.drive("browser-1", "snapshot", {}, "terminal:b"), "reading never waits");
  assert.equal(s.driverOf("browser-1").driver, "terminal:a");
  t += 31_000;
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:b");
  assert.equal(s.driverOf("browser-1").driver, "terminal:b");
});

test("the person wins: Stop keeps agents off until Resume; the person's own Send still works", async () => {
  let t = 1_000_000;
  const { s } = service({ pages: { 7: page() }, now: () => t });
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  s.hold("browser-1", "stopped", 120_000);
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "stopped_by_user");
  assert.ok(await s.drive("browser-1", "read", {}, "user"), "the person isn't held off");
  s.release("browser-1");
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
});

test("a tile off screen is woken before it's driven, and refused plainly if it can't be", async () => {
  let drawn = false;
  const woken: string[] = [];
  const d = fakeDriver({ drawable: async () => drawn });
  const records: unknown[] = [];
  const s = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: { allowed: true } }),
    pageById: () => page(),
    hostWebContents: () => HOST,
    connected: async () => ({}),
    record: (e) => void records.push(e),
    makeDriver: () => d,
    wake: async (id) => { woken.push(id); drawn = true; },
    sleep: async () => {},
  });
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  assert.deepEqual(woken, ["browser-1"]);
  assert.deepEqual(d.inputs, ["click 10,20"]);
  const never = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: { allowed: true } }),
    pageById: () => page(),
    hostWebContents: () => HOST,
    connected: async () => ({}),
    record: () => {},
    makeDriver: () => fakeDriver({ drawable: async () => false }),
  });
  await assert.rejects(never.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "hidden");
});

test("while a tile is driven, it and Tacit's window keep drawing though the window is covered", async () => {
  const calls: string[] = [];
  const host = {};
  const guest = page({ hostWebContents: host, setBackgroundThrottling: (on: boolean) => void calls.push(`page ${on}`) });
  const s = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: { allowed: true } }),
    pageById: () => guest,
    hostWebContents: () => host,
    connected: async () => ({}),
    record: () => {},
    makeDriver: () => fakeDriver(),
    windowActive: () => void calls.push("window active"),
  });
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  // The window's switch is the coordinator's: asked to stay active, at the start and the end.
  assert.deepEqual(calls, ["window active", "page false", "window active"]);
  // Reading needs no drawing, and changes nothing.
  await s.drive("browser-1", "snapshot", {}, "terminal:a");
  assert.deepEqual(calls, ["window active", "page false", "window active"]);
});

test("Stop stops an agent mid-way: the next input event is refused, and nothing more is typed", async () => {
  let s!: BrowserService;
  const d = fakeDriver({ mouse: async () => { d.inputs.push("click"); s.hold("browser-1", "stopped", 120_000); } });
  ({ s } = service({ pages: { 7: page() }, driver: d }));
  const r = (await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }, { do: "type", text: "secret plan" }] }, "terminal:a")) as { ok: boolean; steps: Array<{ ok: boolean; error?: string }> };
  assert.equal(r.ok, false);
  assert.match(r.steps[1].error!, /pressed Stop/);
  assert.deepEqual(d.inputs, ["click"]);
});

test("an action waiting its turn is checked again when the turn comes: a profile taken away meanwhile stops it", async () => {
  let asked = 0;
  const s = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: ++asked === 1 ? { allowed: true } : { allowed: false, code: "profile_blocked", message: "Agents may not use this profile now." } }) as BrowserTileContext,
    pageById: () => page(),
    hostWebContents: () => HOST,
    connected: async () => ({}),
    record: () => {},
    makeDriver: () => fakeDriver(),
  });
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { status: number; code: string }) => e.status === 403 && e.code === "profile_blocked");
});

test("pastes on two tiles at once each paste their own text, and the person's clipboard comes back", async () => {
  let board = "the person's own";
  const seen: string[] = [];
  const pages: Record<number, GuestPage> = { 7: page(), 8: page() };
  const drivers: Record<string, Driver> = {};
  const s = new BrowserService({
    context: async (card) => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: card === "a" ? 7 : 8, permission: { allowed: true } }) as BrowserTileContext,
    pageById: (id) => pages[id] ?? null,
    hostWebContents: () => HOST,
    connected: async () => ({}),
    record: () => {},
    clipboardFor: (text) => { const was = board; board = text; return () => { board = was; }; },
    makeDriver: (p) => (drivers[p === pages[7] ? "a" : "b"] = fakeDriver({ press: async () => { await new Promise((r) => setTimeout(r, 20)); seen.push(board); } })),
  });
  await Promise.all([
    s.drive("a", "act", { steps: [{ do: "paste", text: "A" }] }, "terminal:a"),
    s.drive("b", "act", { steps: [{ do: "paste", text: "B" }] }, "terminal:b"),
  ]);
  assert.deepEqual(seen.sort(), ["A", "B"]);
  assert.equal(board, "the person's own");
});

test("an agent can't paste the person's clipboard with a key: only its own text, with paste", async () => {
  const d = fakeDriver();
  const { s } = service({ pages: { 7: page() }, driver: d });
  for (const keys of [["Meta+V"], ["ctrl+v"], ["Shift+Insert"], ["Meta+Shift+V"]]) {
    await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "press", keys }] }, "terminal:a"), (e: { status: number; message: string }) => e.status === 400 && /clipboard/.test(e.message));
  }
  assert.deepEqual(d.inputs, []);
});

test("text never goes into a password field, however it gets the keyboard: a click then typing, a key, a paste", async () => {
  const d = fakeDriver({ focusIsPassword: async () => true });
  const { s } = service({ pages: { 7: page() }, driver: d });
  for (const step of [{ do: "type", text: "hunter2" }, { do: "press", keys: ["h"] }, { do: "paste", text: "hunter2" }]) {
    const r = (await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e5" }, step] }, "terminal:a")) as { ok: boolean; steps: Array<{ reason?: string }> };
    assert.equal(r.ok, false);
    assert.equal(r.steps[1].reason, "password");
  }
  assert.ok(d.inputs.every((i) => i.startsWith("click")), "only the clicks went in");
  // Keys that don't type (Enter to submit what the person typed) still work.
  const ok = (await s.drive("browser-1", "act", { steps: [{ do: "press", keys: ["Enter"] }] }, "terminal:a")) as { ok: boolean };
  assert.equal(ok.ok, true);
});

test("the person's own clicks and keys hold agents off, with or without an agent on the page, and each one renews it", async () => {
  let t = 1_000_000;
  let fire: (input: { type: string }) => void = () => {};
  const own = new Set<number>();
  let n = 0;
  const d = fakeDriver({ isOwnInput: () => own.has(n) });
  const guest = page({ on: ((_ev: string, l: (e: unknown, input: { type: string }) => void) => { fire = (input) => l({}, input); }) as GuestPage["on"] });
  const { s } = service({ pages: { 7: guest }, driver: d, now: () => t });
  await s.drive("browser-1", "snapshot", {}, "terminal:a"); // the driver is made, listening
  fire({ type: "mouseDown" }); // the person, before any agent holds the page
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "user_driving");
  t += 16_000;
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  fire({ type: "keyDown" });
  assert.equal(s.driverOf("browser-1").held, "user");
  t += 10_000;
  fire({ type: "keyDown" }); // still typing: renewed
  t += 10_000;
  assert.equal(s.driverOf("browser-1").held, "user", "15 s after the last key, not the first");
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "user_driving");
  // Resume lets agents back at once, though the person clicked just now.
  s.hold("browser-1", "stopped", 120_000);
  s.release("browser-1");
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
  // The agent's own presses, reported back by the page, aren't the person's.
  t += 16_000;
  own.add(++n);
  fire({ type: "mouseDown" });
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
});

test("a read at the same time doesn't take away a change's Stop check, and a step with no keys is stopped too", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let first = true;
  const d = fakeDriver({ press: async (k) => { d.checkpoint?.(); d.inputs.push(`press ${k}`); if (first) { first = false; await gate; } } });
  const { s } = service({ pages: { 7: page() }, driver: d });
  const running = s.drive("browser-1", "act", { steps: [{ do: "press", keys: ["a"] }, { do: "select", ref: "e4", values: ["B"] }] }, "terminal:a");
  await new Promise((r) => setTimeout(r, 20));
  await s.drive("browser-1", "snapshot", {}, "terminal:b"); // a read, alongside
  s.hold("browser-1", "stopped", 120_000);
  open();
  const r = (await running) as { ok: boolean; steps: Array<{ ok: boolean; error?: string }> };
  assert.equal(r.ok, false);
  assert.match(r.steps[1].error!, /pressed Stop/, "choosing an option is a change too");
});

test("a Tab in typed text that lands in a password field stops the typing there", async () => {
  let inPassword = false;
  const d = fakeDriver({
    focusIsPassword: async () => inPassword,
    typeKeys: async (t) => { d.inputs.push(`type ${JSON.stringify(t)}`); if (t === "\t") inPassword = true; },
  });
  const { s } = service({ pages: { 7: page() }, driver: d });
  const r = (await s.drive("browser-1", "act", { steps: [{ do: "type", text: "ada\thunter2" }] }, "terminal:a")) as { ok: boolean; steps: Array<{ reason?: string }> };
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].reason, "password");
  assert.deepEqual(d.inputs, ['type "ada"', 'type "\\t"']);
});

test("the person's input before any agent came to the page counts: the page is watched from when it's attached", async () => {
  let t = 1_000_000;
  let fire: (input: { type: string }) => void = () => {};
  const guest = page({ id: 7, on: ((_ev: string, l: (e: unknown, input: { type: string }) => void) => { fire = (input) => l({}, input); }) as GuestPage["on"] });
  const { s } = service({ pages: { 7: guest }, now: () => t });
  s.watch(guest, 7);
  fire({ type: "keyDown" });
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "user_driving");
  t += 16_000;
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
});

test("Resume clears the person's earlier input even when it refused an agent's very first change", async () => {
  let t = 1_000_000;
  let fire: (input: { type: string }) => void = () => {};
  const guest = page({ id: 7, on: ((_ev: string, l: (e: unknown, input: { type: string }) => void) => { fire = (input) => l({}, input); }) as GuestPage["on"] });
  const { s } = service({ pages: { 7: guest }, now: () => t });
  s.watch(guest, 7);
  fire({ type: "mouseDown" });
  await assert.rejects(s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a"), (e: { code: string }) => e.code === "user_driving");
  s.release("browser-1");
  await s.drive("browser-1", "act", { steps: [{ do: "click", ref: "e1" }] }, "terminal:a");
});

test("what counts as changing a page", () => {
  assert.equal(changesPage("snapshot", {}), false);
  assert.equal(changesPage("screenshot", {}), false);
  assert.equal(changesPage("act", { steps: [{ do: "wait", ms: 10 }] }), false);
  assert.equal(changesPage("act", { steps: [{ do: "wait", ms: 10 }, { do: "click", ref: "e1" }] }), true);
  assert.equal(changesPage("navigate", { url: "x" }), true);
});

test("uploads only of the workdesk's files", async () => {
  const given: string[][] = [];
  const s = new BrowserService({
    context: async () => ({ exists: true, binding: managedBrowserBinding("p1"), webContentsId: 7, permission: { allowed: true } }),
    pageById: () => page(),
    hostWebContents: () => HOST,
    connected: async () => ({}),
    record: () => {},
    makeDriver: () => fakeDriver({ setFiles: async (_r, f) => void given.push([...f]) }),
    fileAllowed: (p) => p.startsWith("/work/"),
  });
  const bad = (await s.drive("browser-1", "act", { steps: [{ do: "upload", ref: "e3", paths: ["/etc/passwd"] }] }, "terminal:a")) as { ok: boolean; steps: Array<{ error?: string }> };
  assert.equal(bad.ok, false);
  assert.match(bad.steps[0].error!, /workdesk's folders/);
  await s.drive("browser-1", "act", { steps: [{ do: "upload", ref: "e3", paths: ["/work/a.pdf"] }] }, "terminal:a");
  assert.deepEqual(given, [["/work/a.pdf"]]);
});
