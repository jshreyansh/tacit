import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareBridgeLaunch } from "../../electron/agent-launch";
import { applyLaunchArgs } from "../../shared/agent-adapters";

type AgentShimProvider = "claude" | "codex" | "opencode" | "gemini";

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function commandCandidates(command: string): string[] {
  if (process.platform !== "win32") return [command];

  const lower = command.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return [command];
  }
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function normalizePathEntry(entry: string): string {
  const normalized = path.resolve(entry);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRealCommand(command: string): string | null {
  const shimDir = normalizePathEntry(moduleDir());
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    if (normalizePathEntry(entry) === shimDir) continue;
    for (const candidateName of commandCandidates(command)) {
      const candidate = path.join(entry, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return null;
}

/**
 * Where the built tacit-bridge server may sit relative to this shim.
 *
 * The packaged candidate was missing: electron-builder puts the shims in
 * Resources/cli/agent-shims/ and the bridge in Resources/tacit-bridge/, and
 * none of the old guesses pointed there. So in an installed app, `claude` or
 * `codex` typed in a canvas shell never got Tacit's tools, silently. Pinned
 * by a test against both layouts.
 */
export function tacitBridgeCandidates(shimDir: string): string[] {
  return [
    // Packaged: Resources/cli/agent-shims -> Resources/tacit-bridge/tacit-bridge.js
    path.resolve(shimDir, "..", "..", "tacit-bridge", "tacit-bridge.js"),
    // Dev: dist-cli/agent-shims -> tacit-bridge/dist/tacit-bridge.js
    path.resolve(shimDir, "..", "..", "tacit-bridge", "dist", "tacit-bridge.js"),
  ];
}

/**
 * The bridge this shim hands to the agent, or null when it can't be found —
 * which runAgentShim reports in the terminal rather than ignoring.
 */
function resolveTacitBridgeCliPath(): string | null {
  return (
    tacitBridgeCandidates(moduleDir()).find((candidate) => fs.existsSync(candidate)) ??
    null
  );
}

export function runAgentShim(provider: AgentShimProvider): never {
  const realCommand = resolveRealCommand(provider);
  if (!realCommand) {
    console.error(`Tacit could not find the real ${provider} executable in PATH.`);
    process.exit(127);
  }

  let args = process.argv.slice(2);
  let env = process.env;
  // Only a terminal Tacit spawned carries TACIT_TERMINAL_ID. Without it this
  // is `claude` run somewhere else, which should launch untouched.
  const terminalId = process.env.TACIT_TERMINAL_ID?.trim();
  if (terminalId) {
    try {
      const plan = prepareBridgeLaunch({
        terminalType: provider,
        terminalId,
        serverPath: resolveTacitBridgeCliPath(),
        portFile: process.env.TACIT_PORT_FILE ?? "",
        inheritedEnv: process.env,
      });
      if (plan) {
        args = applyLaunchArgs(args, plan);
        env = { ...env, ...plan.env };
      }
    } catch (error) {
      // Still launch the agent, but say so in the terminal it is about to
      // take over — the only place the person can see it from here.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Tacit: workspace tools unavailable in this ${provider} session: ${reason}`);
    }
  }

  const result = spawnSync(realCommand, args, {
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error(`${provider} failed to start: ${result.error.message}`);
    process.exit(127);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}
