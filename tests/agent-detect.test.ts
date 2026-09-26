import test from "node:test";
import assert from "node:assert/strict";

import { detectAgent, detectAgents, type DetectDeps } from "../electron/agent-detect.ts";
import { findAgentAdapter, listAgentAdapters, parseCliVersion } from "../shared/agent-adapters.ts";

test("versions are read from each CLI's own --version format", () => {
  // Real outputs from this machine, 26 Sep 2026.
  assert.equal(parseCliVersion("2.1.283 (Claude Code)\n"), "2.1.283");
  assert.equal(parseCliVersion("codex-cli 0.157.1\n"), "0.157.1");
  assert.equal(parseCliVersion("1.18.29\n"), "1.18.29");
  assert.equal(parseCliVersion("0.46.0\n"), "0.46.0");
  assert.equal(parseCliVersion("tool v3.2.0-beta.1"), "3.2.0-beta.1");
  assert.equal(parseCliVersion("no version here"), null);
});

function deps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    env: { PATH: "/usr/bin" },
    resolve: (command) => `/usr/local/bin/${command}`,
    runVersion: async () => "codex-cli 0.157.1",
    ...overrides,
  };
}

test("a CLI that isn't on PATH is reported missing, with the command named, and never throws", async () => {
  const result = await detectAgent(findAgentAdapter("codex")!, "codex", deps({ resolve: () => null }));
  assert.equal(result.installed, false);
  assert.equal(result.path, null);
  assert.equal(result.version, null);
  assert.match(result.reason ?? "", /Codex isn't installed: `codex` was not found/);
});

test("an installed CLI reports its path and version", async () => {
  const result = await detectAgent(findAgentAdapter("codex")!, "codex", deps());
  assert.deepEqual(result, {
    id: "codex",
    installed: true,
    path: "/usr/local/bin/codex",
    version: "0.157.1",
    reason: null,
  });
});

test("a CLI that fails --version is still offered, with the version unknown and why", async () => {
  const result = await detectAgent(
    findAgentAdapter("gemini")!,
    "gemini",
    deps({ runVersion: async () => { throw new Error("timed out"); } }),
  );
  assert.equal(result.installed, true);
  assert.equal(result.version, null);
  assert.match(result.reason ?? "", /timed out/);
});

test("the command overridden in Settings is the one looked up", async () => {
  const looked: string[] = [];
  await detectAgent(
    findAgentAdapter("claude")!,
    "/opt/claude-nightly/bin/claude",
    deps({ resolve: (command) => { looked.push(command); return command; } }),
  );
  assert.deepEqual(looked, ["/opt/claude-nightly/bin/claude"]);
});

test("every registered agent names a command and a way to print its version", () => {
  for (const adapter of listAgentAdapters()) {
    assert.ok(adapter.command, adapter.id);
    assert.ok(adapter.versionArgs.length > 0, adapter.id);
  }
});

test("detecting on this machine finds every agent the registry knows, without throwing", { timeout: 60_000 }, async () => {
  const results = await detectAgents({}, true);
  assert.deepEqual(
    results.map((r) => r.id).sort(),
    listAgentAdapters().map((a) => a.id).sort(),
  );
  for (const result of results) {
    if (result.installed) assert.ok(result.path, `${result.id} installed without a path`);
    else assert.ok(result.reason, `${result.id} missing without a reason`);
  }
});
