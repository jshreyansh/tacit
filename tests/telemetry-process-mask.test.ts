import test from "node:test";
import assert from "node:assert/strict";
import { maskProcess } from "../electron/telemetry-service";

test("telemetry keeps a process's command line with its secrets masked", () => {
  const p = maskProcess({ pid: 42, command: 'codex -c mcp_servers.tacit.env.TACIT_TERMINAL_TOKEN="FhiUl-abcdefghijklmnopqrstuvwxyz012345" --key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', name: "codex" });
  assert.equal(p.pid, 42);
  assert.equal(p.name, "codex");
  assert.doesNotMatch(p.command, /FhiUl-abc|sk-ant-api03/);
});
