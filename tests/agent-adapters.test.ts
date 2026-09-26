import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentCapabilityError,
  applyLaunchArgs,
  findAgentAdapter,
  makeBridgeDescriptor,
  planBridgeLaunch,
  CODEX_TOOLS_REQUIRING_APPROVAL,
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
  const mute: AgentAdapter = {
    id: "mute",
    displayName: "Mute CLI",
    command: "mute",
    versionArgs: ["--version"],
    mcpInjection: null,
  };
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

// ── Codex ───────────────────────────────────────────────────────────────

test("codex passes the bridge as -c overrides, ahead of any subcommand", () => {
  const codex = findAgentAdapter("codex");
  assert.ok(codex);
  const result = planBridgeLaunch(codex, bridge, context);

  assert.equal(result.placement, "prepend");
  assert.deepEqual(result.files, [], "codex needs no file on disk");
  assert.deepEqual(result.env, {});
  assert.deepEqual(result.args, [
    "-c", 'mcp_servers.tacit.command="/Applications/Tacit.app/Contents/MacOS/Tacit"',
    "-c", 'mcp_servers.tacit.args=["/Applications/Tacit.app/Contents/Resources/tacit-bridge/tacit-bridge.js"]',
    "-c", 'mcp_servers.tacit.env.TACIT_TERMINAL_ID="term-1"',
    "-c", 'mcp_servers.tacit.env.TACIT_PORT_FILE="/Users/me/.tacit/port"',
    "-c", 'mcp_servers.tacit.env.ELECTRON_RUN_AS_NODE="1"',
    "-c", 'mcp_servers.tacit.default_tools_approval_mode="approve"',
    "-c", 'mcp_servers.tacit.tools.browser_eval.approval_mode="prompt"',
  ]);
  assert.deepEqual(
    applyLaunchArgs(["resume", "abc"], result).slice(-2),
    ["resume", "abc"],
  );
});

test("codex quotes values so a path with spaces, quotes and backslashes survives", () => {
  const codex = findAgentAdapter("codex")!;
  const tricky = makeBridgeDescriptor({
    execPath: '/Users/Jane "J" Doe/Tacit.app/bin\\tacit',
    serverPath: "/tmp/with space/tacit-bridge.js",
    terminalId: "t-1",
    portFile: "/tmp/port",
  });
  const args = planBridgeLaunch(codex, tricky, context).args;
  assert.ok(args.includes('mcp_servers.tacit.command="/Users/Jane \\"J\\" Doe/Tacit.app/bin\\\\tacit"'));
  assert.ok(args.includes('mcp_servers.tacit.args=["/tmp/with space/tacit-bridge.js"]'));
});

test("codex refuses an env name that cannot be a TOML key, instead of mangling it", () => {
  const codex = findAgentAdapter("codex")!;
  const odd = { ...bridge, env: { ...bridge.env, "BAD.NAME": "x" } };
  assert.throws(() => planBridgeLaunch(codex, odd, context), AgentCapabilityError);
});

const codexBinary = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

test(
  "the real codex CLI parses the overrides into exactly the bridge descriptor",
  { skip: codexBinary ? false : "codex is not installed" },
  () => {
    const codex = findAgentAdapter("codex")!;
    const tricky = makeBridgeDescriptor({
      execPath: '/opt/Jane "J" Doe/node',
      serverPath: "/tmp/with space/tacit-bridge.js",
      terminalId: "term-42",
      portFile: "/tmp/port",
    });
    const { args } = planBridgeLaunch(codex, tricky, context);
    // An empty CODEX_HOME: the test reads nothing of the machine's own config.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-codex-home-"));
    const out = execFileSync(codexBinary!, [...args, "mcp", "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: home },
    });
    const servers = JSON.parse(out) as Array<{
      name: string;
      transport: { command?: string; args?: string[]; env?: Record<string, string> };
    }>;
    const tacit = servers.find((server) => server.name === "tacit");
    assert.ok(tacit, `tacit missing from ${out}`);
    assert.equal(tacit.transport.command, tricky.command);
    assert.deepEqual(tacit.transport.args, tricky.args);
    assert.deepEqual(tacit.transport.env, tricky.env);
  },
);

test("codex auto-approves Tacit's tools except the ones that must ask", () => {
  assert.deepEqual([...CODEX_TOOLS_REQUIRING_APPROVAL], ["browser_eval"]);
  const args = planBridgeLaunch(findAgentAdapter("codex")!, bridge, context).args;
  const approvals = args.filter((arg) => arg.includes("approval_mode"));
  assert.deepEqual(approvals, [
    'mcp_servers.tacit.default_tools_approval_mode="approve"',
    'mcp_servers.tacit.tools.browser_eval.approval_mode="prompt"',
  ]);
  // Only Tacit's server: nothing touches another server's approval.
  assert.ok(approvals.every((arg) => arg.startsWith("mcp_servers.tacit.")));
});

/**
 * Asks the real codex CLI whether it recognises every config key in `args`.
 *
 * Codex silently ignores unknown keys, so a misspelled approval setting
 * would leave a tool auto-approved with no error. `exec --strict-config`
 * rejects them instead — the only subcommand that honours it. It points at
 * a local address that refuses connections, so nothing goes online, and is
 * stopped as soon as its banner prints, which happens only after the config
 * has been validated.
 */
function codexStrictConfigCheck(args: string[]): Promise<"accepted" | string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-codex-strict-"));
  const offline = [
    "-c", 'model_provider="tacit_offline"',
    "-c", 'model_providers.tacit_offline.name="offline"',
    "-c", 'model_providers.tacit_offline.base_url="http://127.0.0.1:9/v1"',
    "-c", 'model_providers.tacit_offline.wire_api="responses"',
    "-c", "model_providers.tacit_offline.request_max_retries=0",
    "-c", "model_providers.tacit_offline.stream_max_retries=0",
  ];
  return new Promise((resolve) => {
    const child = spawn(codexBinary!, ["exec", "--strict-config", ...offline, ...args, "noop"], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => finish(`no answer from codex: ${output}`), 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/unknown configuration field/.test(output)) finish(output);
      else if (/workdir:/.test(output)) finish("accepted");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => finish(output || "codex exited without output"));
  });
}

test(
  "the real codex CLI recognises every approval key, and would reject a misspelling",
  { skip: codexBinary ? false : "codex is not installed" },
  async () => {
    const { args } = planBridgeLaunch(findAgentAdapter("codex")!, bridge, context);
    assert.equal(await codexStrictConfigCheck(args), "accepted");
    // The check itself has teeth: Codex silently ignores unknown keys without
    // strict mode, so prove strict mode catches one.
    const misspelled = await codexStrictConfigCheck([
      "-c",
      'mcp_servers.tacit.command="/usr/bin/true"',
      "-c",
      'mcp_servers.tacit.tools.browser_eval.aproval_mode="prompt"',
    ]);
    assert.match(misspelled, /unknown configuration field `mcp_servers\.tacit\.tools\.browser_eval\.aproval_mode`/);
  },
);

// ── OpenCode ────────────────────────────────────────────────────────────

function opencodeConfig(inheritedEnv?: Record<string, string | undefined>) {
  const plan = planBridgeLaunch(findAgentAdapter("opencode")!, bridge, { ...context, inheritedEnv });
  return { plan, config: JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT) };
}

test("opencode gets the bridge through OPENCODE_CONFIG_CONTENT, with no args or files", () => {
  const { plan, config } = opencodeConfig();
  assert.deepEqual(plan.args, []);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(config, {
    mcp: {
      tacit: {
        type: "local",
        command: [bridge.command, ...bridge.args],
        enabled: true,
        environment: bridge.env,
      },
    },
  });
});

test("opencode keeps everything already in the person's OPENCODE_CONFIG_CONTENT", () => {
  const { config } = opencodeConfig({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "anthropic/claude-sonnet-5",
      mcp: { mine: { type: "local", command: ["my-server"] }, tacit: { stale: true } },
    }),
  });
  assert.equal(config.model, "anthropic/claude-sonnet-5");
  assert.deepEqual(config.mcp.mine, { type: "local", command: ["my-server"] });
  assert.equal(config.mcp.tacit.stale, undefined, "our entry replaces an old one");
  assert.equal(config.mcp.tacit.type, "local");
});

test("opencode refuses to overwrite an OPENCODE_CONFIG_CONTENT it cannot read", () => {
  for (const value of ["{not json", "[1,2]", '"text"']) {
    assert.throws(
      () => opencodeConfig({ OPENCODE_CONFIG_CONTENT: value }),
      (error: unknown) => error instanceof AgentCapabilityError && /OPENCODE_CONFIG_CONTENT/.test(error.message),
      value,
    );
  }
});

const opencodeBinary = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();
const builtBridge = path.resolve("tacit-bridge/dist/tacit-bridge.js");

test(
  "the real opencode starts the bridge from the generated config and connects",
  {
    skip: !opencodeBinary
      ? "opencode is not installed"
      : !fs.existsSync(builtBridge)
        ? "tacit-bridge is not built"
        : false,
    timeout: 90_000,
  },
  () => {
    const real = makeBridgeDescriptor({
      execPath: process.execPath,
      serverPath: builtBridge,
      terminalId: "test-opencode",
      portFile: path.join(os.tmpdir(), "tacit-test-port"),
    });
    const { env } = planBridgeLaunch(findAgentAdapter("opencode")!, real, context);
    const out = execFileSync(opencodeBinary!, ["mcp", "list"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    }).replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(out, /✓ tacit\s+connected/, out);
  },
);

// ── Gemini ──────────────────────────────────────────────────────────────

function geminiPlan(options: {
  inheritedEnv?: Record<string, string | undefined>;
  platform?: string;
  files?: Record<string, string>;
} = {}) {
  const read: string[] = [];
  const plan = planBridgeLaunch(findAgentAdapter("gemini")!, bridge, {
    ...context,
    inheritedEnv: options.inheritedEnv,
    platform: options.platform ?? "darwin",
    readFile: (file) => {
      read.push(file);
      return options.files?.[file] ?? null;
    },
  });
  const settings = JSON.parse(plan.files[0].contents);
  return { plan, settings, read };
}

test("gemini gets the bridge in a system settings file of its own, trusted, with no args", () => {
  const { plan, settings } = geminiPlan();
  assert.deepEqual(plan.args, []);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, "/tmp/tacit-gemini-system-term-1.json");
  assert.equal(plan.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "/tmp/tacit-gemini-system-term-1.json");
  assert.deepEqual(settings, {
    mcpServers: {
      tacit: { command: bridge.command, args: bridge.args, env: bridge.env, trust: true },
    },
  });
});

test("gemini pins the system-defaults path where it was, since Gemini derives it from the settings folder", () => {
  assert.equal(
    geminiPlan({ platform: "darwin" }).plan.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    "/Library/Application Support/GeminiCli/system-defaults.json",
  );
  assert.equal(
    geminiPlan({ platform: "linux" }).plan.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    "/etc/gemini-cli/system-defaults.json",
  );
  assert.equal(
    geminiPlan({ platform: "win32" }).plan.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    "C:\\ProgramData\\gemini-cli\\system-defaults.json",
  );
  assert.equal(
    geminiPlan({ inheritedEnv: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/corp/defaults.json" } }).plan.env
      .GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    "/corp/defaults.json",
  );
  assert.equal(
    geminiPlan({ inheritedEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/corp/gemini/settings.json" } }).plan.env
      .GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    "/corp/gemini/system-defaults.json",
  );
});

test("gemini keeps an administrator's system settings and adds tacit to them", () => {
  const adminPath = "/Library/Application Support/GeminiCli/settings.json";
  const { settings, read } = geminiPlan({
    files: {
      [adminPath]: JSON.stringify({
        security: { auth: { enforcedType: "oauth-personal" } },
        mcpServers: { corp: { command: "corp-server" } },
      }),
    },
  });
  assert.deepEqual(read, [adminPath]);
  assert.deepEqual(settings.security, { auth: { enforcedType: "oauth-personal" } });
  assert.deepEqual(settings.mcpServers.corp, { command: "corp-server" });
  assert.equal(settings.mcpServers.tacit.trust, true);
});

test("gemini reads an inherited system settings path, not the default", () => {
  const { read } = geminiPlan({ inheritedEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/corp/settings.json" } });
  assert.deepEqual(read, ["/corp/settings.json"]);
});

test("gemini refuses to replace system settings it cannot read", () => {
  const adminPath = "/Library/Application Support/GeminiCli/settings.json";
  for (const contents of ["{ // comment\n}", "[1]"]) {
    assert.throws(
      () => geminiPlan({ files: { [adminPath]: contents } }),
      (error: unknown) => error instanceof AgentCapabilityError && error.message.includes(adminPath),
    );
  }
});

test("every agent the workspace-manager roster offers can be given Tacit's tools", async () => {
  const source = fs.readFileSync(path.resolve("src/toolbar/WorkspaceManagerPill.tsx"), "utf8");
  const match = source.match(/WORKSPACE_MANAGER_AGENT_TYPES = \[([^\]]*)\]/);
  assert.ok(match, "roster list not found");
  const roster = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(roster.length > 0);
  for (const id of roster) {
    const adapter = findAgentAdapter(id);
    assert.ok(adapter, `${id} is offered as manager but has no adapter`);
    assert.ok(adapter.mcpInjection, `${id} is offered as manager but cannot receive tools`);
  }
});

const geminiBinary = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v gemini"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

test(
  "the real gemini lists the person's own servers and tacit together",
  { skip: geminiBinary ? false : "gemini is not installed", timeout: 120_000 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-gemini-"));
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { mine: { command: "/usr/bin/true" } } }),
    );
    const written = new Map<string, string>();
    const plan = prepareBridgeLaunch({
      terminalType: "gemini",
      terminalId: "term-g",
      serverPath: "/tmp/tacit-bridge.js",
      portFile: "/tmp/port",
      tempFile: (name) => path.join(root, name),
      readFile: () => null,
      writeFile: (file, contents) => {
        written.set(file, contents);
        fs.writeFileSync(file, contents);
      },
    })!;
    // Gemini writes the list to stderr.
    const result = spawnSync(geminiBinary!, ["mcp", "list"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ...plan.env },
      timeout: 90_000,
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /mine:/, out);
    assert.match(out, /tacit:.*tacit-bridge\.js/, out);
  },
);
