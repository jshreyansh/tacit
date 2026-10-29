import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Trust for the folders Hydra makes, so its workers don't stop at a question.
 *
 * Claude and Codex each ask whether to trust a folder the first time they
 * start in it, and every Hydra workbench is a new folder
 * (<repo>/.worktrees/workbench-…). Each worker sat at that question, out of
 * sight, while its wire said "working". Decided 29 Oct: Tacit marks such a
 * folder trusted for the agent, but only when the folder is inside the repo
 * the workbench belongs to and that agent already trusts that repo itself.
 * Anything else is left for the agent to ask.
 *
 *  - Claude keeps trust in ~/.claude.json, `projects[<folder>]`.
 *  - Codex keeps it in ~/.codex/config.toml, `[projects."<folder>"]`.
 *
 * Both files belong to the agents and are rewritten by them; each is read,
 * changed in the one place, and written whole (temporary file, then rename),
 * so it is never left half-written. An existing setting for the folder is
 * never overridden.
 */

export type TrustAgent = "claude" | "codex";

export type TrustOutcome =
  | { status: "trusted" }
  | { status: "already" }
  /** The agent doesn't trust the repo itself; it will ask, as it would. */
  | { status: "repo_not_trusted" }
  | { status: "not_inside_repo" }
  /** The user set something for this folder already; left as it is. */
  | { status: "left_alone" }
  | { status: "failed"; detail: string };

// ------------------------------------------------------------- Claude

/** Settings a worktree shares with its repo; not its history or costs. */
const CLAUDE_SHARED_FIELDS = [
  "allowedTools",
  "mcpContextUris",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
] as const;

type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export function claudeTrusts(config: ClaudeConfig, folder: string): boolean {
  return config.projects?.[folder]?.hasTrustDialogAccepted === true;
}

/**
 * The config with `folder` trusted, its settings copied from the repo's.
 * Null when there is nothing to do or it must be left alone.
 */
export function claudeWithTrust(config: ClaudeConfig, repo: string, folder: string): ClaudeConfig | null {
  const existing = config.projects?.[folder];
  if (existing?.hasTrustDialogAccepted === true) return null;
  // The user (or Claude) decided about this folder already: an explicit
  // false is a "no" and stays one.
  if (existing && existing.hasTrustDialogAccepted === false) return null;
  const fromRepo = config.projects?.[repo] ?? {};
  const shared = Object.fromEntries(
    CLAUDE_SHARED_FIELDS.filter((key) => key in fromRepo).map((key) => [key, structuredClone(fromRepo[key])]),
  );
  return {
    ...config,
    projects: {
      ...config.projects,
      [folder]: { allowedTools: [], mcpContextUris: [], mcpServers: {}, ...shared, ...existing, hasTrustDialogAccepted: true },
    },
  };
}

// ------------------------------------------------------------- Codex

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The trust_level line in the `[projects."<folder>"]` table, if there is one. */
export function codexTrustLevel(toml: string, folder: string): string | null | undefined {
  const lines = toml.split("\n");
  const header = `[projects.${tomlString(folder)}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith("[")) break;
    const match = line.match(/^trust_level\s*=\s*"([^"]*)"/);
    if (match) return match[1]!;
  }
  return null;
}

/** The config with `folder` trusted, or null when it is already or must be left alone. */
export function codexWithTrust(toml: string, folder: string): string | null {
  const level = codexTrustLevel(toml, folder);
  if (level === "trusted") return null;
  // A table for the folder exists already (with another level, or none):
  // someone decided something; it stays.
  if (level !== undefined) return null;
  const separator = toml === "" || toml.endsWith("\n\n") ? "" : toml.endsWith("\n") ? "\n" : "\n\n";
  return `${toml}${separator}[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`;
}

// ------------------------------------------------------------- files

function writeWhole(file: string, content: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  const temp = `${file}.tacit-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

function isInside(folder: string, repo: string): boolean {
  const relative = path.relative(repo, folder);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Before a Hydra worker starts in `folder`: trust it for `agent` when the
 * agent trusts `repo` and `folder` is inside it.
 */
export function trustHydraFolder(input: {
  agent: TrustAgent;
  repo: string;
  folder: string;
  home?: string;
}): TrustOutcome {
  const home = input.home ?? os.homedir();
  const repo = path.resolve(input.repo);
  const folder = path.resolve(input.folder);
  if (!isInside(folder, repo)) return { status: "not_inside_repo" };
  try {
    if (input.agent === "claude") {
      const file = path.join(home, ".claude.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeConfig;
      if (claudeTrusts(config, folder)) return { status: "already" };
      if (!claudeTrusts(config, repo)) return { status: "repo_not_trusted" };
      const next = claudeWithTrust(config, repo, folder);
      if (!next) return { status: "left_alone" };
      // As Claude writes it: two-space indent, no newline at the end.
      writeWhole(file, JSON.stringify(next, null, 2));
      return { status: "trusted" };
    }
    const file = path.join(home, ".codex", "config.toml");
    const toml = fs.readFileSync(file, "utf8");
    if (codexTrustLevel(toml, folder) === "trusted") return { status: "already" };
    if (codexTrustLevel(toml, repo) !== "trusted") return { status: "repo_not_trusted" };
    const next = codexWithTrust(toml, folder);
    if (next === null) return { status: "left_alone" };
    writeWhole(file, next);
    return { status: "trusted" };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
