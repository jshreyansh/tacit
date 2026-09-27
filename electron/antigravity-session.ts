import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which conversation an Antigravity CLI (`agy`) terminal is in, so a relaunch
 * can reopen it with `agy --conversation <id>` the way Claude and OpenCode
 * resume theirs.
 *
 * agy keeps no conversation file open and writes nothing Tacit can match on
 * cwd, but each agy process sends its output to a log of its own under
 * ~/.gemini/antigravity-cli/log/, and that log names the conversation
 * ("Created conversation <id>", then "found conversation <id>" as it works).
 * So: the terminal's process → the log it holds open → the id. Verified
 * against agy 1.2.12. Exact per process, so several agy terminals in one
 * folder can't be confused, which a newest-file guess would do.
 */

const CONVERSATION_ID = /conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

export function antigravityDataDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".gemini", "antigravity-cli");
}

/** The most recent conversation a log names, or null before the first message. */
export function conversationIdFromLog(text: string): string | null {
  let last: string | null = null;
  for (const match of text.matchAll(CONVERSATION_ID)) last = match[1];
  return last;
}

/** The files `lsof -Fn` lists, one per `n` line. */
export function openFilesFromLsof(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

export interface AntigravitySessionDeps {
  /** The paths of files the process holds open. */
  listOpenFiles: (pid: number) => string[];
  readFile: (file: string) => string | null;
  exists: (file: string) => boolean;
  homeDir: string;
}

function lsofOpenFiles(pid: number): string[] {
  try {
    return openFilesFromLsof(
      execFileSync("lsof", ["-a", "-p", String(pid), "-Fn"], {
        encoding: "utf8",
        timeout: 3000,
      }),
    );
  } catch {
    // The process is gone, or lsof is unavailable (Windows): nothing to find.
    return [];
  }
}

const defaultDeps: AntigravitySessionDeps = {
  listOpenFiles: lsofOpenFiles,
  readFile: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  exists: (file) => fs.existsSync(file),
  homeDir: os.homedir(),
};

export function findAntigravityConversation(
  pid: number,
  deps: AntigravitySessionDeps = defaultDeps,
): { sessionId: string; confidence: "strong" } | null {
  const dataDir = antigravityDataDir(deps.homeDir);
  const logDir = path.join(dataDir, "log") + path.sep;
  const logs = deps
    .listOpenFiles(pid)
    .filter((file) => file.startsWith(logDir) && file.endsWith(".log"));
  for (const log of new Set(logs)) {
    const text = deps.readFile(log);
    const id = text ? conversationIdFromLog(text) : null;
    // Only an id agy actually saved can be resumed.
    if (id && deps.exists(path.join(dataDir, "conversations", `${id}.db`))) {
      return { sessionId: id, confidence: "strong" };
    }
  }
  return null;
}
