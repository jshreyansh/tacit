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
 * Best-effort dev/packaged resolver for the tacit-bridge MCP server
 * built from ../../tacit-bridge (see that package's build.ts). Mirrors
 * the multi-candidate fallback pattern used elsewhere in this codebase
 * (e.g. getMacBlurHelperPath in electron/main.ts) rather than hard failing —
 * a terminal simply doesn't get tacit-bridge tools if none of these
 * resolve, which is a safe degradation, not a broken launch.
 */
function resolveTacitBridgeCliPath(): string | null {
  const dir = moduleDir();
  const candidates = [
    // Dev: cli/agent-shims/run.ts -> tacit-bridge/dist/tacit-bridge.js
    path.resolve(dir, "..", "..", "tacit-bridge", "dist", "tacit-bridge.js"),
    // Packaged, if bundled as a sibling of the shim's own output dir
    path.resolve(dir, "..", "tacit-bridge.js"),
    // Packaged, if bundled as a sibling of dist-cli/ itself
    path.resolve(dir, "..", "..", "tacit-bridge.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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
