import test from "node:test";
import assert from "node:assert/strict";

import { parseWireSendRequest } from "../electron/wire-send";
import { MAX_ENVELOPE_LENGTH } from "../shared/wire-envelope";

// What the main process accepts from Send on a wire's panel.

const good = {
  target: { terminalId: "t1", ptyId: 4, terminalType: "claude", worktreePath: "/w" },
  envelope: {
    from: { kind: "browser", id: "b1", title: "localhost:3000", role: "browser" },
    payload: "page",
    body: "Sign up\nEmail",
  },
};

test("a well-formed Send passes, and is never counted as an automatic hop", () => {
  const parsed = parseWireSendRequest(good);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.envelope.hop, 0);
    assert.equal(parsed.envelope.from.role, "browser");
    assert.equal(parsed.target.ptyId, 4);
  }
});

test("anything malformed is refused with a reason, before anything is typed", () => {
  const cases: Array<[string, unknown]> = [
    ["no target", { ...good, target: {} }],
    ["bad pty", { ...good, target: { ...good.target, ptyId: -1 } }],
    ["unknown source kind", { ...good, envelope: { ...good.envelope, from: { ...good.envelope.from, kind: "file" } } }],
    ["unknown role", { ...good, envelope: { ...good.envelope, from: { ...good.envelope.from, role: "robot" } } }],
    ["unknown payload", { ...good, envelope: { ...good.envelope, payload: "secrets" } }],
    ["empty body", { ...good, envelope: { ...good.envelope, body: "   " } }],
    ["too long", { ...good, envelope: { ...good.envelope, body: "x".repeat(MAX_ENVELOPE_LENGTH + 1) } }],
    ["nothing", null],
  ];
  for (const [name, request] of cases) {
    const parsed = parseWireSendRequest(request);
    assert.equal(parsed.ok, false, name);
    if (!parsed.ok) assert.ok(parsed.detail.length > 0, name);
  }
});
