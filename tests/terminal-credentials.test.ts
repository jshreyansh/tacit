import test from "node:test";
import assert from "node:assert/strict";
import { TerminalCredentials } from "../electron/terminal-credentials";

test("a terminal's credential proves that terminal and no other", () => {
  const creds = new TerminalCredentials(Buffer.alloc(32, 7));
  const token = creds.tokenFor("t1");
  assert.equal(creds.verify("t1", token), "t1");
  assert.equal(creds.verify("t2", token), null, "one terminal's credential doesn't speak for another");
  assert.equal(creds.verify("t1", token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
  assert.equal(creds.verify("t1", ""), null);
  assert.equal(creds.verify(undefined, token), null);
  assert.equal(creds.verify(["t1"], token), null, "a repeated header isn't a terminal");
  assert.equal(creds.verify("../t1", creds.tokenFor("../t1")), null, "ids are plain");
});

test("a new launch makes new credentials: an old one stops working", () => {
  const before = new TerminalCredentials();
  const after = new TerminalCredentials();
  assert.equal(after.verify("t1", before.tokenFor("t1")), null);
});
