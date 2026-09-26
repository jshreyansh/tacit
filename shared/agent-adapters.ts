/**
 * How each agent CLI is handed Tacit's workspace tools.
 *
 * Every agent Tacit launches — the workspace manager, a worker dropped on the
 * canvas, a worker the manager spawns — gets the same MCP server, the bridge.
 * What differs is only how each CLI is told about it: Claude reads a config
 * file named by a flag, Codex takes dotted overrides on the command line,
 * OpenCode reads an env var, Gemini a system settings file. This module is that per-agent knowledge in one
 * place, so a new agent is one entry here and nothing else.
 *
 * It used to be two hand-written copies — electron/main.ts for terminals made
 * from the dock, cli/agent-shims/run.ts for `claude` typed in a plain shell —
 * and they had already drifted: one registered the server as `tacit`, the
 * other as `tacit-bridge`, so the same agent saw differently named tools
 * depending on how it was started.
 *
 * Pure on purpose: nothing here touches the filesystem or the process. An
 * adapter returns a plan (arguments, env, files to write) and the caller
 * carries it out — electron/agent-launch.ts in the app, the shim in a shell.
 * That keeps it importable from the renderer, which needs the capabilities
 * for the roster, and testable without a disk.
 *
 * The user's own MCP servers are never touched. Every injection either adds
 * to what the agent already loads or works on a private copy.
 */

/**
 * The key the bridge is registered under. It becomes the prefix on every tool
 * name the agent sees (mcp__tacit__spawn_browser). Deliberately not the
 * workspace directory's name, `tacit-bridge`: the packaged resource path is
 * keyed on the directory, and renaming it is churn nobody can see.
 */
export const TACIT_MCP_SERVER_NAME = "tacit";

/** One MCP server as every agent format needs it: what to run, with what. */
export interface BridgeDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function makeBridgeDescriptor(options: {
  /** The binary that runs the bridge script. */
  execPath: string;
  /** Absolute path to the built tacit-bridge.js. */
  serverPath: string;
  terminalId: string;
  portFile: string;
}): BridgeDescriptor {
  return {
    command: options.execPath,
    args: [options.serverPath],
    env: {
      TACIT_TERMINAL_ID: options.terminalId,
      TACIT_PORT_FILE: options.portFile,
      // In the app, execPath is the Electron binary, and a PACKAGED Electron
      // app ignores an app path in argv — it boots its own bundled asar. So
      // without this every terminal would silently start a second copy of
      // Tacit instead of the MCP server. Unpackaged Electron happens to honour
      // argv[1], which is why dev never caught it. Harmless under plain node,
      // which is what the shim runs on.
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

/** A file an adapter needs on disk before the agent starts. */
export interface LaunchFile {
  path: string;
  contents: string;
}

export interface AgentLaunchPlan {
  /** Arguments to add to the agent's own. */
  args: string[];
  /**
   * Where they go. `before-double-dash` keeps them ahead of a `--` the user
   * typed, so they are read as options rather than passed through; `prepend`
   * puts them first, for CLIs whose first positional word is a subcommand
   * that global options must precede.
   */
  placement: "prepend" | "before-double-dash";
  /** Environment to set for the agent process. */
  env: Record<string, string>;
  /** Files the caller must write before launching. */
  files: LaunchFile[];
}

/**
 * How an agent learns about an extra MCP server at launch, or null when it
 * has no per-launch way to be told — that agent cannot be given workspace
 * tools, and asking it to be is an error rather than a quiet no-op.
 */
export type McpInjection =
  | "config-file-flag"
  | "config-overrides"
  | "env-config"
  | "system-settings-file";

export interface AgentAdapter {
  /** Matches the terminal type (src/types TerminalType). */
  id: string;
  displayName: string;
  /** The executable Tacit launches for this agent, unless Settings overrides it. */
  command: string;
  /** Prints the CLI's version, for detection. */
  versionArgs: readonly string[];
  mcpInjection: McpInjection | null;
  planBridgeLaunch?: (
    bridge: BridgeDescriptor,
    context: LaunchContext,
  ) => AgentLaunchPlan;
}

export interface LaunchContext {
  terminalId: string;
  /** A path in the temp directory for a file of this name. */
  tempFile: (name: string) => string;
  /**
   * The environment the agent would otherwise start with, for adapters that
   * add to a variable the person may already set rather than replace it.
   */
  inheritedEnv?: Record<string, string | undefined>;
  /** The OS the agent runs on, for adapters whose defaults differ by OS. */
  platform?: string;
  /**
   * Reads a file an adapter must merge rather than replace, or null when it
   * does not exist. Any other failure throws.
   */
  readFile?: (path: string) => string | null;
}

/** A request for something an agent cannot do. Never swallowed. */
export class AgentCapabilityError extends Error {
  constructor(
    readonly agentId: string,
    readonly capability: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentCapabilityError";
  }
}

const claude: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  command: "claude",
  versionArgs: ["--version"],
  // Claude Code merges --mcp-config with the servers the user already has, so
  // this adds the bridge without hiding anything. The file is per terminal
  // rather than a global ~/.claude.json registration — see the removed
  // "Computer Use MCP" (electron/skill-manager.ts history) for why the global
  // pattern was abandoned.
  mcpInjection: "config-file-flag",
  planBridgeLaunch(bridge, { terminalId, tempFile }) {
    const configPath = tempFile(`tacit-mcp-${terminalId}.json`);
    const config = {
      mcpServers: {
        [TACIT_MCP_SERVER_NAME]: {
          type: "stdio",
          command: bridge.command,
          args: bridge.args,
          env: bridge.env,
        },
      },
    };
    return {
      args: ["--mcp-config", configPath],
      // --mcp-config is variadic and consumes whatever positional value
      // follows it, including a `--`-separated initial prompt (see
      // getTerminalPromptArgs in src/terminal/cliConfig.ts), so it must land
      // strictly before any `--`, never after.
      placement: "before-double-dash",
      env: {},
      files: [{ path: configPath, contents: JSON.stringify(config) }],
    };
  },
};

/**
 * A TOML basic string. JSON's string escapes (\" \\ \n \uXXXX …) are all
 * valid TOML, so JSON.stringify produces one exactly — including for a path
 * with spaces, quotes or backslashes. Quoting is not optional: Codex falls
 * back to the raw text when a value fails to parse as TOML, so an unquoted
 * value that happens to parse as something else would silently change type.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Env names become bare TOML keys, which allow only these characters. */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Tacit tools that still ask the person before Codex runs them. Codex asks
 * before every MCP tool call by default, which makes a workspace manager —
 * calling tools constantly — unusable. The canvas tools only touch Tacit's
 * own canvas, and browser profiles already pass Tacit's own permission check,
 * so they run without asking. browser_eval runs arbitrary JavaScript in a
 * page you may be signed in to; that one keeps a human yes.
 *
 * Applies to Tacit's server only: the user's own MCP servers keep whatever
 * approval they have. Emptying this list approves all of Tacit's tools.
 */
export const CODEX_TOOLS_REQUIRING_APPROVAL: readonly string[] = ["browser_eval"];

const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  command: "codex",
  versionArgs: ["--version"],
  // Codex has no --mcp-config; each `-c` overrides one dotted key of
  // ~/.codex/config.toml for this run only. The file is never written, and
  // the user's own mcp_servers entries load alongside (verified against
  // codex-cli 0.153.4 and 0.157.1 with `codex mcp list`).
  mcpInjection: "config-overrides",
  planBridgeLaunch(bridge) {
    const key = `mcp_servers.${TACIT_MCP_SERVER_NAME}`;
    const overrides = [
      `${key}.command=${tomlString(bridge.command)}`,
      `${key}.args=[${bridge.args.map(tomlString).join(", ")}]`,
      ...Object.entries(bridge.env).map(([name, value]) => {
        if (!TOML_BARE_KEY.test(name)) {
          throw new AgentCapabilityError(
            "codex",
            "mcpInjection",
            `Environment variable name ${JSON.stringify(name)} cannot be passed to Codex as a config key.`,
          );
        }
        return `${key}.env.${name}=${tomlString(value)}`;
      }),
      // Codex applies a per-tool approval_mode over the server default.
      `${key}.default_tools_approval_mode=${tomlString("approve")}`,
      ...CODEX_TOOLS_REQUIRING_APPROVAL.map(
        (tool) => `${key}.tools.${tool}.approval_mode=${tomlString("prompt")}`,
      ),
    ];
    return {
      args: overrides.flatMap((override) => ["-c", override]),
      // Global options must come before a subcommand: `codex resume <id>`.
      placement: "prepend",
      env: {},
      files: [],
    };
  },
};

/**
 * A config the person already has, parsed so ours can be added to it. One
 * that can't be read as a JSON object is refused rather than replaced:
 * overwriting it would silently drop their configuration.
 */
function parseExistingConfig(
  text: string,
  agentId: string,
  what: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentCapabilityError(
      agentId,
      "mcpInjection",
      `${what} could not be read as JSON, so Tacit's tools were not added rather than risk replacing it.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentCapabilityError(
      agentId,
      "mcpInjection",
      `${what} is not a JSON object, so Tacit's tools were not added to it.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** A nested object from a parsed config, or an empty one. */
function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const opencode: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  command: "opencode",
  versionArgs: ["--version"],
  // OpenCode merges OPENCODE_CONFIG_CONTENT over its config files, so the
  // bridge rides in the environment and nothing is written. Verified against
  // opencode 1.18.29 with `opencode mcp list`, which starts the server:
  // "tacit connected". OpenCode runs MCP tools without asking by default.
  mcpInjection: "env-config",
  planBridgeLaunch(bridge, { inheritedEnv }) {
    const existing = inheritedEnv?.OPENCODE_CONFIG_CONTENT?.trim();
    // Someone who sets this themselves keeps everything in it; only our one
    // server is added.
    let config = existing
      ? parseExistingConfig(existing, "opencode", "OPENCODE_CONFIG_CONTENT")
      : {};
    const mcp = objectOrEmpty(config.mcp);
    config = {
      ...config,
      mcp: {
        ...mcp,
        [TACIT_MCP_SERVER_NAME]: {
          type: "local",
          command: [bridge.command, ...bridge.args],
          enabled: true,
          environment: bridge.env,
        },
      },
    };
    return {
      args: [],
      placement: "prepend",
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      files: [],
    };
  },
};

/** Where Gemini CLI looks for its system settings when nothing overrides it. */
function geminiDefaultSystemSettingsPath(platform: string | undefined): string {
  if (platform === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  if (platform === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  return "/etc/gemini-cli/settings.json";
}

function dirnameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut <= 0 ? file.slice(0, cut + 1) : file.slice(0, cut);
}

function joinTo(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

const gemini: AgentAdapter = {
  id: "gemini",
  displayName: "Gemini CLI",
  command: "gemini",
  versionArgs: ["--version"],
  // Gemini has no per-run MCP flag, but it merges MCP servers by name across
  // its settings layers, and GEMINI_CLI_SYSTEM_SETTINGS_PATH names the
  // system layer. So the bridge goes in a system settings file of our own,
  // and ~/.gemini/settings.json is never touched (verified against gemini
  // 0.46.0: `gemini mcp list` shows the user's servers and tacit together).
  //
  // Two things the env var would otherwise break, both handled here:
  // - It replaces the system file an administrator may have set to enforce
  //   policy. Whatever is there is copied in, and our server added to it.
  // - Gemini derives the system-defaults path from that file's folder, so
  //   moving the file would silently move the defaults too. The original
  //   defaults path is pinned explicitly.
  //
  // `trust: true` skips Gemini's per-call confirmation for Tacit's tools.
  // Gemini can only trust a whole server, not one tool, so unlike Codex this
  // includes browser_eval (chosen by the user, 26 Sep). Gemini's own
  // folder-trust gate still applies: in a folder the person has not trusted,
  // Gemini disables every MCP server, theirs and ours.
  mcpInjection: "system-settings-file",
  planBridgeLaunch(bridge, { terminalId, tempFile, inheritedEnv, platform, readFile }) {
    const systemPath =
      inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
      geminiDefaultSystemSettingsPath(platform);
    const defaultsPath =
      inheritedEnv?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      joinTo(dirnameOf(systemPath), "system-defaults.json");

    const existing = readFile?.(systemPath);
    let settings =
      existing != null && existing.trim()
        ? parseExistingConfig(existing, "gemini", `Gemini's system settings at ${systemPath}`)
        : {};
    const servers = objectOrEmpty(settings.mcpServers);
    settings = {
      ...settings,
      mcpServers: {
        ...servers,
        [TACIT_MCP_SERVER_NAME]: {
          command: bridge.command,
          args: bridge.args,
          env: bridge.env,
          trust: true,
        },
      },
    };

    const file = tempFile(`tacit-gemini-system-${terminalId}.json`);
    return {
      args: [],
      placement: "prepend",
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: file,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaultsPath,
      },
      files: [{ path: file, contents: JSON.stringify(settings) }],
    };
  },
};

const ADAPTERS: readonly AgentAdapter[] = [claude, codex, opencode, gemini];

/** The adapter for a terminal type, or null for one that is not an agent. */
export function findAgentAdapter(id: string | undefined): AgentAdapter | null {
  if (!id) return null;
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

export function listAgentAdapters(): readonly AgentAdapter[] {
  return ADAPTERS;
}

/**
 * The launch plan that gives this agent the bridge. Throws for an agent with
 * no way to receive it, so a caller cannot mistake "no tools" for success.
 */
export function planBridgeLaunch(
  adapter: AgentAdapter,
  bridge: BridgeDescriptor,
  context: LaunchContext,
): AgentLaunchPlan {
  if (!adapter.mcpInjection || !adapter.planBridgeLaunch) {
    throw new AgentCapabilityError(
      adapter.id,
      "mcpInjection",
      `${adapter.displayName} has no way to receive Tacit's workspace tools at launch.`,
    );
  }
  return adapter.planBridgeLaunch(bridge, context);
}

/** The agent's arguments with the plan's folded in where it says. */
export function applyLaunchArgs(args: string[], plan: AgentLaunchPlan): string[] {
  if (plan.args.length === 0) return args;
  if (plan.placement === "prepend") return [...plan.args, ...args];
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) return [...args, ...plan.args];
  return [
    ...args.slice(0, separatorIndex),
    ...plan.args,
    ...args.slice(separatorIndex),
  ];
}

/**
 * The version number in a CLI's `--version` output, whatever surrounds it:
 * "2.1.283 (Claude Code)", "codex-cli 0.157.1", "1.18.29". Null when there is
 * none, so a CLI that prints something unexpected is recorded as unknown
 * rather than as a made-up version.
 */
export function parseCliVersion(output: string): string | null {
  // Not `\b` at the start: it finds no boundary in "v3.2.0" and would skip
  // to "2.0". A version may follow a letter, just not a digit or a dot.
  const match = output.match(/(?<![\d.])(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/** Whether an agent CLI is on this machine, and which version. */
export interface AgentDetection {
  id: string;
  installed: boolean;
  /** Absolute path of the executable that would be launched. */
  path: string | null;
  version: string | null;
  /** Why it counts as unavailable, or why the version could not be read. */
  reason: string | null;
}
