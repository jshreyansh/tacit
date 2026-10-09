import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomically } from "../electron/agent-launch.ts";

// Antigravity's MCP config is shared with the person's other servers, whose
// keys it can hold. Replacing it must not make a private file readable.
test("replacing a config keeps its permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-write-"));
  try {
    const file = path.join(dir, "mcp_config.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o600);
    writeFileAtomically(file, '{"mcpServers":{}}');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf-8"), '{"mcpServers":{}}');

    fs.chmodSync(file, 0o644);
    writeFileAtomically(file, "{}");
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a config Tacit creates is private, and no staging file is left", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-write-"));
  try {
    const file = path.join(dir, "config", "settings.json");
    writeFileAtomically(file, "{}");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["settings.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
