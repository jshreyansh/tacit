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
