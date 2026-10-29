import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EMPTY_WIRE_STATE, WIRE_STATE_VERSION, WireStateFile, parseWireState, type WireState } from "../electron/wire-state";

// What the wires are waiting on, kept on disk across a restart.

const state: WireState = {
  version: WIRE_STATE_VERSION,
  mail: [
    {
      id: "m1", terminalId: "cx", text: "[From Claude] review the diff", from: "terminal:cl", preview: "review the diff", at: 1,
      target: { ptyId: 4, terminalType: "codex", worktreePath: "/w" },
    },
    // Queued by a restart's follow-up: no address yet.
    { id: "m2", terminalId: "cl", text: "[Codex was restarted…]", from: "terminal:cx", preview: "restarted", at: 2 },
  ],
  asks: {
    queued: [{ id: "q1", askerId: "cl", askerTitle: "Claude", targetId: "oc", targetTitle: "OpenCode", question: "2+2?", cwd: "/w", at: 3 }],
    active: [{ id: "q2", askerId: "cl", askerTitle: "Claude", targetId: "cx", targetTitle: "Codex", question: "why?", cwd: "/w", at: 4, before: "5" }],
  },
  handoffs: [{ id: "h1", senderId: "cl", senderTitle: "Claude", targetId: "cx", targetTitle: "Codex", dir: "/w/.hydra/handoffs/h1", startedAt: 5 }],
};

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wire-state-")), "wire-state.json");
}

test("saved state loads back exactly", () => {
  const file = tempFile();
  const store = new WireStateFile(file);
  store.save(state);
  assert.deepEqual(store.load(), { state });
});

test("the file is readable only by the user, and written whole", () => {
  const file = tempFile();
  new WireStateFile(file).save(state);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["wire-state.json"], "no temporary file left behind");
});

test("nothing pending removes the file; no file loads as nothing pending", () => {
  const file = tempFile();
  const store = new WireStateFile(file);
  store.save(state);
  store.save(EMPTY_WIRE_STATE);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.load(), { state: EMPTY_WIRE_STATE });
});

test("a file that can't be used is moved aside and the user is told", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ not json");
  const loaded = new WireStateFile(file).load();
  assert.deepEqual(loaded.state, EMPTY_WIRE_STATE);
  assert.match(loaded.problem ?? "", /^Tacit couldn't use what its wires were waiting on before it closed \(not JSON\), so nothing was kept\. The file is at .*wire-state\.json\.unreadable-\d+\.$/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("unreadable")).length, 1);
});

test("a malformed entry or another version isn't used", () => {
  assert.deepEqual(parseWireState(JSON.stringify({ ...state, version: 2 })), { ok: false, reason: "unknown version" });
  const badMail = { ...state, mail: [{ ...state.mail[0], text: 42 }] };
  assert.deepEqual(parseWireState(JSON.stringify(badMail)), { ok: false, reason: "a malformed entry in mail" });
  const relativeDir = { ...state, handoffs: [{ ...state.handoffs[0], dir: "handoffs/h1" }] };
  assert.deepEqual(parseWireState(JSON.stringify(relativeDir)), { ok: false, reason: "a malformed entry in handoffs" });
  const noAsks = { ...state, asks: undefined };
  assert.deepEqual(parseWireState(JSON.stringify(noAsks)), { ok: false, reason: "queued is missing" });
});
