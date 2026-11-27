import test from "node:test";
import assert from "node:assert/strict";
import { chordEvents, charKey, typeEvents, KeyError, MOD } from "../shared/browser-keys";
import { capLines, diffLines, findLines, parseRef, snapshotLines, type FrameSnapshot } from "../shared/browser-snapshot";
import { validateSteps } from "../shared/browser-act";
import { DriverError, PageDriver, type DriverPage } from "../electron/browser-driver";

test("typing sends each character as a key press with its text: what Excel's grid takes", () => {
  const ev = typeEvents("Ab1");
  assert.deepEqual(ev.filter((e) => e.type === "keyDown").map((e) => [e.key, e.code, e.text, e.modifiers]), [
    ["A", "KeyA", "A", MOD.Shift],
    ["b", "KeyB", "b", 0],
    ["1", "Digit1", "1", 0],
  ]);
  assert.equal(ev.length, 6, "a keyup after each");
  assert.deepEqual(typeEvents("a\nb").filter((e) => e.type !== "keyUp").map((e) => e.key), ["a", "Enter", "b"]);
  assert.equal(charKey("é").code, "", "other characters still go in, as text");
});

test("a chord holds its modifiers around the key, and names macOS's editing command", () => {
  const ev = chordEvents("Meta+A", "darwin");
  assert.deepEqual(ev.map((e) => `${e.type}:${e.key}:${e.modifiers}`), ["rawKeyDown:Meta:4", "rawKeyDown:a:4", "keyUp:a:4", "keyUp:Meta:0"]);
  assert.deepEqual(ev[1].commands, ["selectAll"]);
  assert.equal(ev[1].text, undefined, "a command key types nothing");
  assert.deepEqual(chordEvents("Meta+V", "darwin")[1].commands, ["paste"]);
  assert.equal(chordEvents("Control+V", "linux")[1].commands, undefined);
  const enter = chordEvents("Enter");
  assert.deepEqual(enter.map((e) => e.type), ["keyDown", "keyUp"]);
  assert.equal(enter[0].text, "\r");
  assert.deepEqual(chordEvents("shift+tab").map((e) => e.key), ["Shift", "Tab", "Tab", "Shift"]);
  assert.throws(() => chordEvents("Hyper+A"), KeyError);
  assert.throws(() => chordEvents("Banana"), KeyError);
});

const frames: FrameSnapshot[] = [
  { prefix: "", entries: [
    { ref: "e1", depth: 0, role: "heading", level: "1", name: "Workbook", value: "", states: [] },
    { ref: "e2", depth: 0, role: "iframe", name: "grid", value: "", states: [], iframe: true },
    { ref: "e3", depth: 0, role: "button", name: "Save \"now\"", value: "", states: ["disabled"], offscreen: true },
  ] },
  { prefix: "f1", parentPrefix: "", ownerRef: "e2", entries: [{ ref: "e1", depth: 0, role: "textbox", name: "cell", value: "A1", states: ["focused"] }] },
];

test("frames sit under their <iframe> in one outline, refs naming their frame", () => {
  assert.deepEqual(snapshotLines(frames), [
    '- heading[1] "Workbook" [e1]',
    '- iframe "grid" [e2]',
    '  - textbox "cell": A1 [f1e1] (focused)',
    "- button \"Save 'now'\" [e3] (disabled) ↓",
  ]);
  const orphan = snapshotLines([frames[0], { ...frames[1], ownerRef: "gone" }]);
  assert.ok(orphan.includes("- iframe [f1]"), "a frame whose <iframe> wasn't shown still counts");
});

test("the outline keeps to its size in whole lines, and says what it left out", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `- button "B${i}" [e${i}]`);
  const c = capLines(lines, 200);
  assert.equal(c.truncated, true);
  assert.ok(c.text.length < 400);
  assert.match(c.text, /more lines not shown/);
});

test("what changed between two outlines, and finding lines by words", () => {
  const d = diffLines(['- button "Save" [e1]', '- text: "Draft" [e2]'], ['- button "Save" [e1]', '- text: "Saved" [e4]']);
  assert.deepEqual(d.added, ['- text: "Saved" [e4]']);
  assert.deepEqual(d.removed, ['- text: "Draft" [e2]']);
  assert.deepEqual(findLines(['- button "Save draft" [e1]', '- link "Help" [e2]'], "save"), ['- button "Save draft" [e1]']);
  assert.deepEqual(parseRef("f12e5"), { prefix: "f12", ref: "e5" });
  assert.equal(parseRef("button"), null);
});

test("steps are checked before any runs, and wrong ones say how to fix them", () => {
  assert.equal(validateSteps([{ do: "click", ref: "e1" }, { do: "type", text: "x" }, { do: "press", keys: ["Enter"] }]), null);
  assert.equal(validateSteps([{ do: "click", x: 10, y: 20, screenshot: "s1" }]), null);
  assert.match(validateSteps([])!, /one or more/);
  assert.match(validateSteps(Array.from({ length: 21 }, () => ({ do: "wait", ms: 1 })))!, /At most 20/);
  assert.match(validateSteps([{ do: "click" }])!, /needs a ref/);
  assert.match(validateSteps([{ do: "click", ref: "button.save" }])!, /isn't a ref/);
  assert.match(validateSteps([{ do: "fly" }])!, /isn't a step/);
  assert.match(validateSteps([{ do: "check", ref: "e1" }])!, /checked: true or false/);
  assert.match(validateSteps([{ do: "wait" }])!, /needs ms, text or gone/);
});

// A key the page doesn't take goes back to Tacit's window, to whatever has the keyboard
// there: an Escape sent while the person typed in an agent's terminal stopped that agent.
function fakePage() {
  const sent: Array<{ method: string; params: any }> = [];
  const page = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach: () => {},
      on: () => {},
      sendCommand: async (method: string, params: any) => { sent.push({ method, params }); return {}; },
    },
  };
  return { page, sent };
}

test("keys go only to a page that has the window's keyboard: otherwise nothing is sent", async () => {
  const { page, sent } = fakePage();
  const d = new PageDriver(page as unknown as DriverPage);
  d.keyboardHere = async () => false;
  await assert.rejects(d.press("Escape"), (e: unknown) => e instanceof DriverError && e.code === "no_keyboard");
  await assert.rejects(d.typeKeys("A2"), (e: unknown) => e instanceof DriverError && e.code === "no_keyboard");
  await assert.rejects(d.insertText("hello"), (e: unknown) => e instanceof DriverError && e.code === "no_keyboard");
  assert.deepEqual(sent, []);

  d.keyboardHere = async () => true;
  await d.press("Escape");
  assert.deepEqual(sent.map((s) => s.params.type), ["rawKeyDown", "keyUp"]);
});

test("the keyboard is checked at every press: taken away mid-way, the rest isn't sent and held keys go up", async () => {
  const { page, sent } = fakePage();
  const d = new PageDriver(page as unknown as DriverPage);
  let downs = 0;
  // The person clicks into a terminal after the first press of the chord (the modifier).
  d.keyboardHere = async () => downs === 0;
  const send = page.debugger.sendCommand;
  page.debugger.sendCommand = async (method: string, params: any) => {
    if (params?.type !== "keyUp") downs++;
    return send(method, params);
  };
  await assert.rejects(d.press("Meta+a"), (e: unknown) => e instanceof DriverError && e.code === "no_keyboard");
  assert.deepEqual(sent.map((s) => [s.params.type, s.params.key]), [["rawKeyDown", "Meta"], ["keyUp", "Meta"]]);
});

test("a click's handover is waited for a moment before keys are refused", async () => {
  const { page, sent } = fakePage();
  const d = new PageDriver(page as unknown as DriverPage);
  const from = Date.now();
  d.keyboardHere = async () => Date.now() - from > 60;
  await d.typeKeys("x");
  assert.ok(sent.some((s) => s.params.key === "x"));
});

// A clip makes Chromium stand in a viewport and wait for the page to draw at it; Excel never
// did, and that capture and every one after it timed out.
test("a screenshot is what's on screen, with no clip, brought to the page's size on white", async () => {
  const { page, sent } = fakePage();
  page.debugger.sendCommand = async (method: string, params: any) => {
    sent.push({ method, params });
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    if (method === "Page.captureScreenshot") return { data: "PNG" };
    return {};
  };
  const d = new PageDriver(page as unknown as DriverPage);
  await assert.rejects(d.screenshot(), (e: unknown) => e instanceof DriverError && e.code === "unsupported");
  const asked: Array<[string, number, number]> = [];
  d.jpegOf = (png, width, quality) => { asked.push([png, width, quality]); return { data: "JPEG", width, height: Math.round(width * 0.75) }; };
  const shot = await d.screenshot({ maxWidth: 400 });
  const capture = sent.find((s) => s.method === "Page.captureScreenshot")!;
  assert.deepEqual(capture.params, { format: "png" });
  assert.deepEqual(asked, [["PNG", 400, 70]]);
  assert.equal(shot.scale, 0.5);
  assert.deepEqual(d.pointFromShot(shot.id, 100, 50), { x: 200, y: 100 });
});
