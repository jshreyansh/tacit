import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  listAgentAdapters,
  parseCliVersion,
  type AgentAdapter,
  type AgentDetection,
} from "../shared/agent-adapters";
import { getLoginShellEnv, resolveExecutable } from "./pty-launch";

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

export interface DetectDeps {
  env: Record<string, string>;
  resolve: (command: string, env: Record<string, string>) => string | null;
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
  const executable = deps.resolve(command, deps.env);
  if (!executable) {
    return {
      id: adapter.id,
      installed: false,
      path: null,
      version: null,
      reason: `${adapter.displayName} isn't installed: \`${command}\` was not found on your PATH.`,
    };
  }

  try {
    const output = await deps.runVersion(executable, adapter.versionArgs, deps.env);
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

function runVersion(
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

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
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
): Promise<AgentDetection[]> {
  const key = JSON.stringify(commandOverrides);
  if (cached && !refresh && key === cachedKey) return cached;
  cachedKey = key;
  cached = (async () => {
    const env = Object.fromEntries(
      Object.entries(await getLoginShellEnv()).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const deps: DetectDeps = {
      env,
      resolve: (command, searchEnv) =>
        resolveExecutable(command, searchEnv, {
          platform: process.platform,
          pathDelimiter: path.delimiter,
          existsSync: (file) => fs.existsSync(file),
          isExecutable,
        }),
      runVersion,
    };
    return Promise.all(
      listAgentAdapters().map((adapter) =>
        detectAgent(adapter, commandOverrides[adapter.id]?.trim() || adapter.command, deps),
      ),
    );
  })();
  return cached;
}
