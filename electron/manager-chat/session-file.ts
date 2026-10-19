import fs from "node:fs";
import path from "node:path";

/**
 * Where an agent keeps a session's record, found from the session id: for
 * Claude, `~/.claude/projects/<project>/<id>.jsonl`; for Codex, a rollout
 * file under `~/.codex/sessions/YYYY/MM/DD/` whose name ends in the id.
 * The id comes from the renderer, so only an id's own characters are taken,
 * and only those two folders are looked in.
 */

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

function dirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function findSessionFile(agent: "claude" | "codex", sessionId: string, homeDir: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  if (agent === "claude") {
    const root = path.join(homeDir, ".claude", "projects");
    for (const project of dirs(root)) {
      const file = path.join(root, project, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }
  const root = path.join(homeDir, ".codex", "sessions");
  const newestFirst = (names: string[]) => names.sort().reverse();
  for (const year of newestFirst(dirs(root))) {
    for (const month of newestFirst(dirs(path.join(root, year)))) {
      for (const day of newestFirst(dirs(path.join(root, year, month)))) {
        const folder = path.join(root, year, month, day);
        let names: string[];
        try {
          names = fs.readdirSync(folder);
        } catch {
          continue;
        }
        const match = names.find((name) => name.startsWith("rollout-") && name.endsWith(`-${sessionId}.jsonl`));
        if (match) return path.join(folder, match);
      }
    }
  }
  return null;
}

/**
 * Where the agents keep their sessions' records, which Tacit lists as past
 * sessions: Claude's projects, Codex's sessions and archived sessions, and
 * Kimi's sessions.
 */
export function sessionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, ".claude", "projects"),
    path.join(homeDir, ".codex", "sessions"),
    path.join(homeDir, ".codex", "archived_sessions"),
    path.join(homeDir, ".kimi", "sessions"),
  ];
}

/**
 * Whether a path from the renderer is an agent's session record: a
 * `.jsonl` file inside one of the session folders, once links and `..` are
 * resolved, so a path can't step out of them.
 */
export function isSessionFile(filePath: unknown, homeDir: string): filePath is string {
  if (typeof filePath !== "string" || !filePath.endsWith(".jsonl")) return false;
  let real: string;
  try {
    real = fs.realpathSync(filePath);
    if (!fs.statSync(real).isFile()) return false;
  } catch {
    return false;
  }
  return sessionRoots(homeDir).some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return false;
    }
    const rel = path.relative(realRoot, real);
    return rel !== "" && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
  });
}
