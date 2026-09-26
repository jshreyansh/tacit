import { execFile } from "node:child_process";
import os from "node:os";
import {
  listAgentAdapters,
  parseCliVersion,
  type AgentAdapter,
  type AgentDetection,
} from "../shared/agent-adapters";
import { buildLaunchSpec, PtyLaunchError } from "./pty-launch";

/**
 * Which agent CLIs are installed, found the same way a launch would find
 * them: on the login shell's PATH, honouring a command overridden in
 * Settings. The dock and the manager roster use this to show an agent as
 * unavailable, with the reason, instead of offering it and failing at
 * launch with "executable not found".
 *
 * The version is kept too, so a bug report or a record entry can name the
 * CLI version it happened on.
 */

const VERSION_TIMEOUT_MS = 5_000;

export interface LocatedCommand {
  /** The executable a launch would run. */
  path: string;
  /** Arguments a launch puts before the CLI's own (Windows `cmd.exe /c x.cmd`). */
  prefixArgs: string[];
  env: Record<string, string>;
}

export interface DetectDeps {
  /**
   * Where `command` would be launched from, and the environment it would get,
   * or null when it can't be found. In the app this is buildLaunchSpec itself,
   * so "installed" means exactly "a launch would find it".
   */
  locate: (command: string) => Promise<LocatedCommand | null>;
  runVersion: (
    executable: string,
    args: readonly string[],
    env: Record<string, string>,
  ) => Promise<string>;
}

export async function detectAgent(
  adapter: AgentAdapter,
  command: string,
  deps: DetectDeps,
): Promise<AgentDetection> {
  const located = await deps.locate(command);
  if (!located) {
    return {
      id: adapter.id,
      installed: false,
      path: null,
      version: null,
      reason: `${adapter.displayName} isn't installed: \`${command}\` was not found on your PATH.`,
    };
  }

  const executable = located.path;
  try {
    const output = await deps.runVersion(
      executable,
      [...located.prefixArgs, ...adapter.versionArgs],
      located.env,
    );
    const version = parseCliVersion(output);
    return {
      id: adapter.id,
      installed: true,
      path: executable,
      version,
      reason: version
        ? null
        : `\`${command} ${adapter.versionArgs.join(" ")}\` printed no version number.`,
    };
  } catch (error) {
    // Found but would not report a version: still offered, since launching
    // may well work — the version is just unknown, and says why.
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: adapter.id,
      installed: true,
      path: executable,
      version: null,
      reason: `Could not read the ${adapter.displayName} version: ${message}`,
    };
  }
}

export function runVersion(
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { env, timeout: VERSION_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        // Some CLIs print their version to stderr.
        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

/**
 * Resolves a command exactly as a terminal launch would (buildLaunchSpec:
 * login-shell PATH, Tacit's CLI folder, Windows launchers), or null when the
 * launch would fail to find it.
 */
export async function locateCommand(
  command: string,
  extraPathEntries: string[] = [],
): Promise<LocatedCommand | null> {
  try {
    const spec = await buildLaunchSpec({ cwd: os.homedir(), shell: command, extraPathEntries });
    return { path: spec.file, prefixArgs: spec.args, env: spec.env };
  } catch (error) {
    if (error instanceof PtyLaunchError && error.code === "executable-not-found") {
      return null;
    }
    throw error;
  }
}

let cached: Promise<AgentDetection[]> | null = null;
let cachedKey = "";

/**
 * Detects every agent in the registry. Cached for the app's lifetime, since
 * running four CLIs costs a second or two; `refresh` re-runs it, and a change
 * to the Settings overrides re-runs it too.
 */
export function detectAgents(
  commandOverrides: Record<string, string | undefined> = {},
  refresh = false,
  /** The same folders an agent launch adds to PATH (Tacit's CLI folder). */
  extraPathEntries: string[] = [],
): Promise<AgentDetection[]> {
  const key = JSON.stringify([commandOverrides, extraPathEntries]);
  if (cached && !refresh && key === cachedKey) return cached;
  cachedKey = key;
  const deps: DetectDeps = {
    locate: (command) => locateCommand(command, extraPathEntries),
    runVersion,
  };
  cached = Promise.all(
    listAgentAdapters().map((adapter) =>
      detectAgent(adapter, commandOverrides[adapter.id]?.trim() || adapter.command, deps),
    ),
  );
  return cached;
}
