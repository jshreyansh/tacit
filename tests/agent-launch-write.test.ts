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

test("two launches of one terminal get their own temp files, so the first one's exit can't remove the second's", async () => {
  const { launchTempFile } = await import("../electron/agent-launch.ts");
  const first = launchTempFile("/tmp");
  const second = launchTempFile("/tmp");
  const a = first("tacit-memory-t-1.md");
  const b = second("tacit-memory-t-1.md");
  assert.notEqual(a, b);
  assert.match(a, /^\/tmp\/tacit-memory-t-1-[0-9a-f]{8}\.md$/);
  // Within one launch, a name always maps to the same file.
  assert.equal(first("tacit-memory-t-1.md"), a);
  assert.equal(launchTempFile("/tmp", "ab12cd34")("tacit-mcp-t-1.json"), "/tmp/tacit-mcp-t-1-ab12cd34.json");
});
