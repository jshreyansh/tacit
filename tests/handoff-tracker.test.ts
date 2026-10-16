import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HandoffTracker,
  describeDroppedFile,
  fileDropEvent,
  isAgentHarness,
  keyedFingerprint,
  loadHandoffKey,
  pinDropEvent,
} from "../electron/handoff-tracker.ts";
import { isGuestCopyChord } from "../electron/browser-guest-shortcuts.ts";
import { CaptureService } from "../electron/capture-service.ts";
import type { CaptureEntry } from "../shared/capture.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const T = "terminal:codex-1";
const B = "browser:browser-1";
const N = "note:idea-ab12";

/** A tracker on a clock the test moves; the window starts focused on the canvas. */
function setup(startClipboard: string | null = "old clipboard") {
  let nowMs = Date.parse("2026-10-16T10:00:00.000Z");
  const tracker = new HandoffTracker(KEY, () => new Date(nowMs));
  tracker.windowFocusChanged(true, startClipboard);
  return {
    tracker,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function handoffOf(result: ReturnType<HandoffTracker["pasted"]>) {
  assert.ok(result, "a paste with text is recorded");
  assert.equal(result.event.kind, "handoff");
  return result.event as Extract<typeof result.event, { kind: "handoff" }>;
}

test("a copy Tacit saw in a browser tile, pasted into an agent, is observed from that tile", () => {
  const { tracker, advance } = setup();
  tracker.nodeFocusChanged(B, "old clipboard");
  tracker.copied(B, "a paragraph from the page");
  advance(5_000);
  tracker.nodeFocusChanged(T, "a paragraph from the page");
  const handoff = handoffOf(tracker.pasted(T, "a paragraph from the page"));
  assert.equal(handoff.from, B);
  assert.equal(handoff.to, T);
  assert.equal(handoff.via, "paste");
  assert.equal(handoff.attribution, "observed");
  assert.equal(handoff.copied_at, "2026-10-16T10:00:00.000Z");
  assert.equal(handoff.length, "a paragraph from the page".length);
  assert.equal(handoff.fingerprint, keyedFingerprint(KEY, "a paragraph from the page"));
});

test("a clipboard change found only by a checkpoint is inferred from the node that had focus", () => {
  const { tracker } = setup();
  tracker.nodeFocusChanged(N, "old clipboard");
  // Selected and copied in the note: no copy command reached Tacit.
  tracker.nodeFocusChanged(T, "text from the note");
  const handoff = handoffOf(tracker.pasted(T, "text from the note"));
  assert.equal(handoff.from, N);
  assert.equal(handoff.attribution, "inferred");
});

test("a copy made in another app while a tile had focus is external, not the tile", () => {
  const { tracker } = setup();
  tracker.nodeFocusChanged(B, "old clipboard");
  // Alt-tab to Notes, copy there, come back: the change happened while
  // Tacit was in the background.
  tracker.windowFocusChanged(false, "old clipboard");
  tracker.windowFocusChanged(true, "copied in Notes");
  tracker.nodeFocusChanged(T, "copied in Notes");
  const handoff = handoffOf(tracker.pasted(T, "copied in Notes"));
  assert.equal(handoff.from, "external");
  assert.equal(handoff.attribution, "inferred");
});

test("a clipboard changed in the background while a tile has focus is inferred, never observed", () => {
  const { tracker, advance } = setup();
  tracker.nodeFocusChanged(B, "old clipboard");
  // A clipboard manager or Universal Clipboard changes it; no copy command.
  tracker.nodeFocusChanged(T, "from the phone");
  assert.equal(handoffOf(tracker.pasted(T, "from the phone")).attribution, "inferred");

  // Later, ⌘C in the tile with nothing selected leaves the clipboard as it
  // was: that's not a copy, and doesn't make the earlier change observed.
  advance(10_000);
  tracker.nodeFocusChanged(B, "from the phone");
  tracker.copied(B, "from the phone");
  tracker.nodeFocusChanged(T, "from the phone");
  const again = handoffOf(tracker.pasted(T, "from the phone"));
  assert.equal(again.from, B);
  assert.equal(again.attribution, "inferred");
});

test("a copy reported just after a checkpoint saw it in the same node stays observed", () => {
  const { tracker, advance } = setup();
  tracker.nodeFocusChanged(B, "old clipboard");
  // ⌘C, then a click into the terminal before the copy's report arrives.
  tracker.nodeFocusChanged(T, "quick copy");
  advance(200);
  tracker.copied(B, "quick copy");
  assert.equal(handoffOf(tracker.pasted(T, "quick copy")).attribution, "observed");
});

test("whatever was on the clipboard before Tacit looked is external and unmatched", () => {
  const { tracker } = setup("from yesterday");
  tracker.nodeFocusChanged(T, "from yesterday");
  const handoff = handoffOf(tracker.pasted(T, "from yesterday"));
  assert.equal(handoff.from, "external");
  assert.equal(handoff.attribution, "unmatched");
  assert.equal(handoff.copied_at, undefined);
  assert.equal(tracker.pasted(T, null), null, "an image paste has no text and isn't recorded");
});

test("a copy and paste inside the same terminal is attributed to it", () => {
  const { tracker } = setup();
  tracker.nodeFocusChanged(T, "old clipboard");
  tracker.copied(T, "an error line");
  assert.equal(handoffOf(tracker.pasted(T, "an error line")).from, T);
});

test("fingerprints are keyed: they depend on the key and aren't a plain hash", () => {
  const otp = "482913";
  const fingerprint = keyedFingerprint(KEY, otp);
  assert.match(fingerprint, /^hmac:[0-9a-f]{32}$/);
  assert.equal(keyedFingerprint(KEY, otp), fingerprint, "the same on this Mac, so paste joins copy");
  assert.notEqual(keyedFingerprint(OTHER_KEY, otp), fingerprint, "different under another install's key");
  const plain = createHash("sha256").update(otp).digest("hex");
  assert.ok(!plain.startsWith(fingerprint.slice("hmac:".length)), "not the guessable SHA-256 of the text");
  assert.ok(!fingerprint.includes(otp));
});

test("the key is made once, readable only by this user, and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-handoff-key-"));
  try {
    const first = loadHandoffKey(dir);
    assert.equal(first.length, 32);
    assert.equal(fs.statSync(path.join(dir, "handoff-key")).mode & 0o777, 0o600);
    assert.deepEqual(loadHandoffKey(dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt that contains a paste points to it; one that doesn't, or a later prompt, doesn't", () => {
  const { tracker } = setup();
  tracker.nodeFocusChanged(T, "old clipboard");
  const pasted = tracker.pasted(T, "line one\r\nline two of the stack trace");
  assert.ok(pasted);
  // The agent's prompt has its own line endings and the person's words around it.
  assert.deepEqual(tracker.promptRefs(T, "why does this fail?\nline one\nline two of the stack trace"), [pasted.eventId]);
  assert.deepEqual(tracker.promptRefs(T, "line one line two of the stack trace"), [], "a paste links to one prompt only");

  tracker.pasted(T, "deleted before sending");
  assert.deepEqual(tracker.promptRefs(T, "something else entirely"), []);
  assert.deepEqual(tracker.promptRefs("terminal:other", "deleted before sending"), [], "another terminal's prompt");
});

test("a very short paste links only when it is the whole prompt", () => {
  const { tracker } = setup();
  tracker.nodeFocusChanged(T, "old clipboard");
  tracker.pasted(T, "y");
  assert.deepEqual(tracker.promptRefs(T, "yes, try it"), []);
  const exact = tracker.pasted(T, "y");
  assert.ok(exact);
  assert.deepEqual(tracker.promptRefs(T, " y "), [exact.eventId]);
});

test("a dropped pin is an observed handoff from its note, and its prompt points to it", () => {
  const { tracker } = setup();
  assert.deepEqual(pinDropEvent("fix-login-ab12", T), {
    kind: "handoff",
    from: "note:fix-login-ab12",
    to: T,
    via: "drop",
    attribution: "observed",
    by: "user",
  });
  tracker.awaitPrompt(T, "pin-event-1", "Fix login\n\nThe session expires too early.");
  assert.deepEqual(tracker.promptRefs(T, "Fix login\n\nThe session expires too early. Start with auth.ts"), ["pin-event-1"]);
});

test("dropped files are named relative to the project or home, with size and a keyed content fingerprint", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-handoff-home-"));
  try {
    const project = path.join(home, "work", "app");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(home, "notes.txt"), "export const a = 1;\n");
    fs.writeFileSync(path.join(project, "big.bin"), Buffer.alloc(64));
    const options = { key: KEY, projectRoot: project, home };

    const inProject = await describeDroppedFile(path.join(project, "src", "a.ts"), options);
    assert.equal(inProject.path, path.join("src", "a.ts"));
    assert.equal(inProject.size, 20);
    assert.match(inProject.fingerprint ?? "", /^hmac:[0-9a-f]{32}$/);

    const underHome = await describeDroppedFile(path.join(home, "notes.txt"), options);
    assert.equal(underHome.path, "~/notes.txt", "the account name stays out");
    assert.equal(underHome.fingerprint, inProject.fingerprint, "same contents, known again under another name");

    const big = await describeDroppedFile(path.join(project, "big.bin"), { ...options, maxBytes: 32 });
    assert.deepEqual(big, { path: "big.bin", size: 64, fingerprint: null });

    assert.deepEqual(await describeDroppedFile(path.join(project, "gone.ts"), options), { path: "gone.ts", size: null, fingerprint: null });
    assert.deepEqual(await describeDroppedFile(path.join(project, "src"), options), { path: "src", size: null, fingerprint: null });
    assert.equal((await describeDroppedFile("/etc/hosts", options)).path, "/etc/hosts");

    const event = fileDropEvent([inProject], T, true);
    assert.equal(event.kind === "handoff" && event.from, "app");
    assert.equal(fileDropEvent([inProject], T, false).kind === "handoff" && fileDropEvent([inProject], T, false).from, "external");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("only agent terminals count, and ⌘C in a page is recognised without taking other chords", () => {
  for (const harness of ["claude", "codex", "opencode"]) assert.equal(isAgentHarness(harness), true, harness);
  for (const harness of ["shell", "lazygit", "tmux", null]) assert.equal(isAgentHarness(harness), false, String(harness));

  const key = (over: Partial<Parameters<typeof isGuestCopyChord>[0]>) => ({
    type: "keyDown", key: "c", control: false, meta: true, shift: false, alt: false, ...over,
  });
  assert.equal(isGuestCopyChord(key({}), "darwin"), true);
  assert.equal(isGuestCopyChord(key({ type: "keyUp" }), "darwin"), false);
  assert.equal(isGuestCopyChord(key({ shift: true }), "darwin"), false);
  assert.equal(isGuestCopyChord(key({ key: "v" }), "darwin"), false);
  assert.equal(isGuestCopyChord(key({ meta: false, control: true }), "darwin"), false);
  assert.equal(isGuestCopyChord(key({ meta: false, control: true }), "linux"), true);
});

test("the record keeps a handoff's links and id, and no pasted text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-handoff-record-"));
  try {
    const capture = new CaptureService(dir);
    const { tracker } = setup();
    tracker.nodeFocusChanged(B, "old clipboard");
    tracker.copied(B, "my password is hunter2 and the code is 482913");
    const pasted = tracker.pasted(T, "my password is hunter2 and the code is 482913");
    assert.ok(pasted);
    capture.record(pasted.event, "canvas-1", new Date(), {
      method: "renderer",
      eventId: pasted.eventId,
      inputRefs: [{ ref: B, kind: "node" }],
      outputRefs: [{ ref: T, kind: "node" }],
    });
    capture.record(
      fileDropEvent([{ path: "~/cb?key=sk-ant-abcdefghijklmnopqrstuvwxyz0123/f.txt", size: 1, fingerprint: null }], T, false),
      "canvas-1",
    );

    const file = fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"));
    assert.ok(file);
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    assert.doesNotMatch(raw, /hunter2|482913|sk-ant-abcdefghij/);
    const [entry, drop] = raw.trim().split("\n").map((line) => JSON.parse(line) as CaptureEntry);
    assert.equal(entry.event_id, pasted.eventId);
    assert.equal(entry.node_ref, T);
    assert.equal(entry.actor_identity.kind, "user");
    assert.deepEqual(entry.input_refs, [{ ref: B, kind: "node" }]);
    assert.deepEqual(entry.output_refs, [{ ref: T, kind: "node" }]);
    assert.equal(drop.kind === "handoff" && drop.files?.[0].path.includes("[masked"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
