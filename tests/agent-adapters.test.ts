import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentCapabilityError,
  applyLaunchArgs,
  findAgentAdapter,
  makeBridgeDescriptor,
  planBridgeLaunch,
  TACIT_MCP_SERVER_NAME,
  type AgentAdapter,
  type AgentLaunchPlan,
} from "../shared/agent-adapters.ts";
import {
  BridgeUnavailableError,
  prepareBridgeLaunch,
} from "../electron/agent-launch.ts";

const bridge = makeBridgeDescriptor({
  execPath: "/Applications/Tacit.app/Contents/MacOS/Tacit",
  serverPath: "/Applications/Tacit.app/Contents/Resources/tacit-bridge/tacit-bridge.js",
  terminalId: "term-1",
  portFile: "/Users/me/.tacit/port",
});
const context = {
  terminalId: "term-1",
  tempFile: (name: string) => `/tmp/${name}`,
};

function plan(args: string[], placement: AgentLaunchPlan["placement"]): AgentLaunchPlan {
  return { args, placement, env: {}, files: [] };
}

test("the bridge descriptor carries the three variables every agent needs", () => {
  assert.equal(bridge.command, "/Applications/Tacit.app/Contents/MacOS/Tacit");
  assert.deepEqual(bridge.args, [
    "/Applications/Tacit.app/Contents/Resources/tacit-bridge/tacit-bridge.js",
  ]);
  assert.deepEqual(bridge.env, {
    TACIT_TERMINAL_ID: "term-1",
    TACIT_PORT_FILE: "/Users/me/.tacit/port",
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("claude writes one config file and names it with --mcp-config", () => {
  const claude = findAgentAdapter("claude");
  assert.ok(claude);
  const result = planBridgeLaunch(claude, bridge, context);

  assert.deepEqual(result.args, ["--mcp-config", "/tmp/tacit-mcp-term-1.json"]);
  assert.equal(result.placement, "before-double-dash");
  assert.deepEqual(result.env, {});
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, "/tmp/tacit-mcp-term-1.json");
});

test("claude's config file is byte-identical to what main.ts wrote before the registry", () => {
  const claude = findAgentAdapter("claude")!;
  const [file] = planBridgeLaunch(claude, bridge, context).files;
  // The literal the old buildClaudeTacitBridgeArgs produced for these inputs.
  assert.equal(
    file.contents,
    '{"mcpServers":{"tacit":{"type":"stdio",' +
      '"command":"/Applications/Tacit.app/Contents/MacOS/Tacit",' +
      '"args":["/Applications/Tacit.app/Contents/Resources/tacit-bridge/tacit-bridge.js"],' +
      '"env":{"TACIT_TERMINAL_ID":"term-1","TACIT_PORT_FILE":"/Users/me/.tacit/port","ELECTRON_RUN_AS_NODE":"1"}}}}',
  );
});

test("the server is registered as `tacit`, so tools read mcp__tacit__*", () => {
  const claude = findAgentAdapter("claude")!;
  const config = JSON.parse(planBridgeLaunch(claude, bridge, context).files[0].contents);
  assert.deepEqual(Object.keys(config.mcpServers), [TACIT_MCP_SERVER_NAME]);
  assert.equal(TACIT_MCP_SERVER_NAME, "tacit");
});

test("injected arguments land before a user's -- separator", () => {
  assert.deepEqual(
    applyLaunchArgs(["--resume", "abc", "--", "fix the bug"], plan(["--mcp-config", "/tmp/x.json"], "before-double-dash")),
    ["--resume", "abc", "--mcp-config", "/tmp/x.json", "--", "fix the bug"],
  );
});

test("without a separator, before-double-dash appends", () => {
  assert.deepEqual(
    applyLaunchArgs(["--resume", "abc"], plan(["--mcp-config", "/tmp/x.json"], "before-double-dash")),
    ["--resume", "abc", "--mcp-config", "/tmp/x.json"],
  );
});

test("prepend puts the arguments ahead of a subcommand", () => {
  assert.deepEqual(
    applyLaunchArgs(["resume", "abc"], plan(["-c", "k=v"], "prepend")),
    ["-c", "k=v", "resume", "abc"],
  );
});

test("an empty plan leaves the arguments alone", () => {
  const args = ["--resume", "abc"];
  assert.equal(applyLaunchArgs(args, plan([], "prepend")), args);
});

test("terminal types that are not agents have no adapter", () => {
  for (const id of ["shell", "lazygit", "tmux", undefined]) {
    assert.equal(findAgentAdapter(id), null, String(id));
  }
});

test("an agent with no way to receive tools throws instead of returning nothing", () => {
  const mute: AgentAdapter = { id: "mute", displayName: "Mute CLI", mcpInjection: null };
  assert.throws(
    () => planBridgeLaunch(mute, bridge, context),
    (error: unknown) =>
      error instanceof AgentCapabilityError &&
      error.agentId === "mute" &&
      error.capability === "mcpInjection" &&
      error.message.includes("Mute CLI"),
  );
});

const launchBase = {
  terminalType: "claude",
  terminalId: "term-1",
  serverPath: "/srv/tacit-bridge.js",
  portFile: "/Users/me/.tacit/port",
  execPath: "/usr/local/bin/node",
  tempFile: (name: string) => `/tmp/${name}`,
};

test("prepareBridgeLaunch writes the plan's files and returns the plan", () => {
  const written = new Map<string, string>();
  const result = prepareBridgeLaunch({
    ...launchBase,
    writeFile: (file, contents) => written.set(file, contents),
  });
  assert.ok(result);
  assert.deepEqual(result.args, ["--mcp-config", "/tmp/tacit-mcp-term-1.json"]);
  assert.deepEqual([...written.keys()], ["/tmp/tacit-mcp-term-1.json"]);
  assert.equal(
    JSON.parse(written.get("/tmp/tacit-mcp-term-1.json")!).mcpServers.tacit.command,
    "/usr/local/bin/node",
  );
});

test("prepareBridgeLaunch returns null for a terminal that is not an agent", () => {
  const written: string[] = [];
  const result = prepareBridgeLaunch({
    ...launchBase,
    terminalType: "shell",
    writeFile: (file) => written.push(file),
  });
  assert.equal(result, null);
  assert.deepEqual(written, []);
});

test("a missing bridge build is an error with a way to fix it", () => {
  assert.throws(
    () => prepareBridgeLaunch({ ...launchBase, serverPath: null, writeFile: () => {} }),
    (error: unknown) =>
      error instanceof BridgeUnavailableError && error.message.includes("build"),
  );
});

test("a missing port file is an error, not a server that cannot reach Tacit", () => {
  assert.throws(
    () => prepareBridgeLaunch({ ...launchBase, portFile: "", writeFile: () => {} }),
    (error: unknown) =>
      error instanceof BridgeUnavailableError && error.message.includes("TACIT_PORT_FILE"),
  );
});

test("a failed write names the file and the cause", () => {
  assert.throws(
    () =>
      prepareBridgeLaunch({
        ...launchBase,
        writeFile: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    (error: unknown) =>
      error instanceof BridgeUnavailableError &&
      error.message.includes("/tmp/tacit-mcp-term-1.json") &&
      error.message.includes("EACCES"),
  );
});
