import test from "node:test";
import assert from "node:assert/strict";

import {
  findAgentAdapter,
  makeBridgeDescriptor,
  MEMORY_BRIEF_ENV,
  planBridgeLaunch,
  type LaunchContext,
} from "../shared/agent-adapters.ts";

const bridge = makeBridgeDescriptor({
  execPath: "/usr/bin/node",
  serverPath: "/app/tacit-bridge.js",
  terminalId: "t-1",
  portFile: "/tmp/port",
});

const BRIEF = '# Tacit memory\n\n- **Say "workdesk"**\n  not workspace';

function plan(agent: string, extra: Partial<LaunchContext> = {}) {
  const adapter = findAgentAdapter(agent)!;
  return planBridgeLaunch(adapter, bridge, {
    terminalId: "t-1",
    tempFile: (name) => `/tmp/${name}`,
    homeDir: "/home/me",
    readFile: () => null,
    version: "2.1.4",
    memoryBrief: BRIEF,
    ...extra,
  });
}

test("Claude Code gets the brief appended to its system prompt, from a file", () => {
  const p = plan("claude");
  const at = p.args.indexOf("--append-system-prompt-file");
  assert.ok(at >= 0, p.args.join(" "));
  assert.equal(p.args[at + 1], "/tmp/tacit-memory-t-1.md");
  assert.equal(p.files.find((f) => f.path === "/tmp/tacit-memory-t-1.md")?.contents, `${BRIEF}\n`);
  // A per-launch file, removed with the terminal.
  assert.equal(p.files.find((f) => f.path === "/tmp/tacit-memory-t-1.md")?.keep, undefined);
});

test("Codex gets it as developer instructions for this run, as a valid TOML string", () => {
  const p = plan("codex");
  const override = p.args.find((a) => a.startsWith("developer_instructions="));
  assert.ok(override, p.args.join(" "));
  assert.equal(JSON.parse(override!.slice("developer_instructions=".length)), BRIEF);
  assert.equal(p.env[MEMORY_BRIEF_ENV], undefined);
});

test("Codex instructions the person set themselves are never replaced; the brief goes through the bridge", () => {
  const p = plan("codex", { readFile: (f) => (f === "/home/me/.codex/config.toml" ? 'model = "x"\ndeveloper_instructions = "mine"\n' : null) });
  assert.equal(p.args.some((a) => a.startsWith("developer_instructions=")), false);
  assert.equal(p.env[MEMORY_BRIEF_ENV], "/tmp/tacit-memory-t-1.md");
});

test("a developer_instructions inside a Codex [table] isn't the person's top-level one", () => {
  const p = plan("codex", { readFile: () => '[profiles.work]\ndeveloper_instructions = "work only"\n' });
  assert.ok(p.args.some((a) => a.startsWith("developer_instructions=")));
});

test("OpenCode gets one more instructions file, keeping the person's own", () => {
  const p = plan("opencode", { inheritedEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["mine.md"] }) } });
  const launch = p.adaptLaunch!([]);
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.instructions, ["mine.md", "/tmp/tacit-memory-t-1.md"]);
  assert.ok(config.mcp.tacit, "the tools are still there");
});

test("Antigravity, with no way to take instructions at launch, gets it through the bridge", () => {
  const p = plan("antigravity");
  assert.equal(p.env[MEMORY_BRIEF_ENV], "/tmp/tacit-memory-t-1.md");
  assert.ok(p.files.some((f) => f.path === "/tmp/tacit-memory-t-1.md"));
});

test("no brief leaves the launch exactly as it was", () => {
  for (const agent of ["claude", "codex", "opencode", "antigravity"]) {
    const without = plan(agent, { memoryBrief: null });
    assert.equal(without.args.includes("--append-system-prompt-file"), false, agent);
    assert.equal(without.args.some((a) => a.startsWith("developer_instructions=")), false, agent);
    assert.equal(without.env[MEMORY_BRIEF_ENV], undefined, agent);
  }
});
