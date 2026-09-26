/**
 * How each agent CLI is handed Tacit's workspace tools.
 *
 * Every agent Tacit launches — the workspace manager, a worker dropped on the
 * canvas, a worker the manager spawns — gets the same MCP server, the bridge.
 * What differs is only how each CLI is told about it: Claude reads a config
 * file named by a flag, Codex takes dotted overrides on the command line,
 * OpenCode reads an env var. This module is that per-agent knowledge in one
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
export type McpInjection = "config-file-flag" | "config-overrides";

export interface AgentAdapter {
  /** Matches the terminal type (src/types TerminalType). */
  id: string;
  displayName: string;
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

const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  // Codex has no --mcp-config; each `-c` overrides one dotted key of
  // ~/.codex/config.toml for this run only. The file is never written, and
  // the user's own mcp_servers entries load alongside (verified against
  // codex-cli 0.153.4 with `codex mcp list`).
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

const ADAPTERS: readonly AgentAdapter[] = [claude, codex];

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
