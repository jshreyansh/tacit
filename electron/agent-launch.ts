import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findAgentAdapter,
  makeBridgeDescriptor,
  parseCliVersion,
  planBridgeLaunch,
  type AgentLaunchPlan,
} from "../shared/agent-adapters";

/**
 * Carries out an agent adapter's launch plan: resolves the bridge, writes the
 * files the plan names, and hands back what to add to the launch.
 *
 * Shared by the two places an agent is started — the app's own terminals
 * (electron/main.ts) and `claude`/`codex` typed in a plain shell
 * (cli/agent-shims/run.ts, which esbuild bundles on its own, so nothing here
 * may import Electron).
 *
 * Failures throw with a reason a person can act on. Both callers used to
 * catch and return nothing, and the agent then started with no workspace
 * tools and no sign anything had gone wrong — the manager role handed out
 * with nothing behind it.
 */

export class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export interface BridgeLaunchOptions {
  terminalType: string | undefined;
  terminalId: string;
  /** The built tacit-bridge.js, or null when none could be found. */
  serverPath: string | null;
  portFile: string;
  execPath?: string;
  tempFile?: (name: string) => string;
  /** What the agent would start with; see LaunchContext.inheritedEnv. */
  inheritedEnv?: Record<string, string | undefined>;
  platform?: string;
  readFile?: (file: string) => string | null;
  writeFile?: (file: string, contents: string) => void;
  homeDir?: string;
  /** The executable the launch runs, when it isn't the adapter's command (a Settings override, the shim's real one). */
  command?: string;
  /** The output of `command` run with these arguments; throws when it can't run. */
  runVersion?: (command: string, args: readonly string[], env: Record<string, string | undefined>) => string;
}

const VERSION_TIMEOUT_MS = 5_000;

function runVersionSync(command: string, args: readonly string[], env: Record<string, string | undefined>): string {
  return execFileSync(command, [...args], { env, timeout: VERSION_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A file's contents, or null when it does not exist. Other errors throw. */
function readFileIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Written beside the target and renamed over it, so an agent (or the
 * person's other tools) reading a shared config never sees half a file.
 *
 * The replacement keeps the file's permissions. A shared config can hold
 * other MCP servers' keys, and a new file gets the umask's default
 * (readable by everyone), so a file the person had made private would
 * otherwise become readable by other users. A file Tacit creates is private.
 */
export function writeFileAtomically(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = `${file}.tacit-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(staging, contents, { encoding: "utf-8", mode });
    // The umask can narrow `mode` on creation; set it exactly.
    fs.chmodSync(staging, mode);
    fs.renameSync(staging, file);
  } catch (error) {
    fs.rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * The plan for giving this terminal the bridge, with its files written, or
 * null when the terminal is not an agent Tacit wires (a shell, lazygit).
 */
export function prepareBridgeLaunch(
  options: BridgeLaunchOptions,
): AgentLaunchPlan | null {
  const adapter = findAgentAdapter(options.terminalType);
  if (!adapter) return null;

  if (!options.serverPath) {
    throw new BridgeUnavailableError(
      "the tacit-bridge server was not found — in development, build it with `pnpm --filter @tacit/tacit-bridge build`",
    );
  }

  if (!options.portFile) {
    throw new BridgeUnavailableError(
      "TACIT_PORT_FILE is not set, so the tools would have no way to reach Tacit",
    );
  }

  const bridge = makeBridgeDescriptor({
    execPath: options.execPath ?? process.execPath,
    serverPath: options.serverPath,
    terminalId: options.terminalId,
    portFile: options.portFile,
  });
  let version: string | undefined;
  if (adapter.launchDependsOnVersion) {
    // Read at each launch, not from the dock's cached detection: an upgrade
    // in a terminal changes it. It takes about 40 ms for OpenCode.
    const command = options.command ?? adapter.command;
    let output: string;
    try {
      output = (options.runVersion ?? runVersionSync)(command, adapter.versionArgs, options.inheritedEnv ?? process.env);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BridgeUnavailableError(`could not read the ${adapter.displayName} version: ${reason}`);
    }
    version = parseCliVersion(output) ?? undefined;
    if (!version) {
      throw new BridgeUnavailableError(`\`${command} ${adapter.versionArgs.join(" ")}\` printed no version number`);
    }
  }

  const plan = planBridgeLaunch(adapter, bridge, {
    terminalId: options.terminalId,
    tempFile: options.tempFile ?? ((name) => path.join(os.tmpdir(), name)),
    inheritedEnv: options.inheritedEnv,
    platform: options.platform ?? process.platform,
    readFile: options.readFile ?? readFileIfPresent,
    homeDir: options.homeDir ?? os.homedir(),
    version,
  });

  const writeFile = options.writeFile ?? writeFileAtomically;
  for (const file of plan.files) {
    try {
      writeFile(file.path, file.contents);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BridgeUnavailableError(
        `could not write ${file.path}: ${reason}`,
      );
    }
  }
  return plan;
}
