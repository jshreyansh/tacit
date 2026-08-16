import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type AgentShimProvider = "claude" | "codex";

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
 * Best-effort dev/packaged resolver for the termcanvas-bridge MCP server
 * built from ../../termcanvas-bridge (see that package's build.ts). Mirrors
 * the multi-candidate fallback pattern used elsewhere in this codebase
 * (e.g. getMacBlurHelperPath in electron/main.ts) rather than hard failing —
 * a terminal simply doesn't get termcanvas-bridge tools if none of these
 * resolve, which is a safe degradation, not a broken launch.
 */
function resolveTermcanvasBridgeCliPath(): string | null {
  const dir = moduleDir();
  const candidates = [
    // Dev: cli/agent-shims/run.ts -> termcanvas-bridge/dist/termcanvas-bridge.js
    path.resolve(dir, "..", "..", "termcanvas-bridge", "dist", "termcanvas-bridge.js"),
    // Packaged, if bundled as a sibling of the shim's own output dir
    path.resolve(dir, "..", "termcanvas-bridge.js"),
    // Packaged, if bundled as a sibling of dist-cli/ itself
    path.resolve(dir, "..", "..", "termcanvas-bridge.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Writes a per-terminal MCP config granting this one Claude session access
 * to termcanvas-bridge, scoped by TERMCANVAS_TERMINAL_ID/TERMCANVAS_PORT_FILE
 * — deliberately NOT a global ~/.claude.json registration (see the removed
 * "Computer Use MCP" in electron/skill-manager.ts / CHANGELOG for why that
 * pattern was abandoned: it applied to every session forever and needed
 * careful cleanup). Returns the extra args to splice in, or [] if
 * termcanvas-bridge isn't available or this isn't a terminal Tacit
 * spawned (no TERMCANVAS_TERMINAL_ID set — e.g. a plain shell use of `claude`).
 */
function buildClaudeMcpArgs(): string[] {
  const terminalId = process.env.TERMCANVAS_TERMINAL_ID?.trim();
  if (!terminalId) return [];
  const serverPath = resolveTermcanvasBridgeCliPath();
  if (!serverPath) return [];

  const config = {
    mcpServers: {
      "termcanvas-bridge": {
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
        env: {
          TERMCANVAS_TERMINAL_ID: terminalId,
          ...(process.env.TERMCANVAS_PORT_FILE
            ? { TERMCANVAS_PORT_FILE: process.env.TERMCANVAS_PORT_FILE }
            : {}),
        },
      },
    },
  };

  try {
    const configPath = path.join(
      os.tmpdir(),
      `termcanvas-mcp-${terminalId}.json`,
    );
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
    return ["--mcp-config", configPath];
  } catch {
    return [];
  }
}

/**
 * `--mcp-config` (like other Claude variadic options) otherwise consumes
 * whatever positional value follows it — including a `--` separated
 * prompt — so it must land strictly before any `--` in argv, never after.
 */
function spliceArgsBeforeDoubleDash(args: string[], extra: string[]): string[] {
  if (extra.length === 0) return args;
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) return [...args, ...extra];
  return [
    ...args.slice(0, separatorIndex),
    ...extra,
    ...args.slice(separatorIndex),
  ];
}

export function runAgentShim(provider: AgentShimProvider): never {
  const realCommand = resolveRealCommand(provider);
  if (!realCommand) {
    console.error(`Tacit could not find the real ${provider} executable in PATH.`);
    process.exit(127);
  }

  let args = process.argv.slice(2);
  if (provider === "claude") {
    args = spliceArgsBeforeDoubleDash(args, buildClaudeMcpArgs());
  }
  // Codex's per-invocation MCP config override flag isn't wired up yet —
  // verify against the installed Codex CLI's --help before adding it here,
  // rather than guessing a flag that could break codex launches outright.

  const result = spawnSync(realCommand, args, {
    stdio: "inherit",
    env: process.env,
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
