import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findAgentAdapter,
  makeBridgeDescriptor,
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
  writeFile?: (file: string, contents: string) => void;
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
  const plan = planBridgeLaunch(adapter, bridge, {
    terminalId: options.terminalId,
    tempFile: options.tempFile ?? ((name) => path.join(os.tmpdir(), name)),
    inheritedEnv: options.inheritedEnv,
  });

  const writeFile =
    options.writeFile ??
    ((file: string, contents: string) =>
      fs.writeFileSync(file, contents, "utf-8"));
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
