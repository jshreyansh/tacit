import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { antigravityLogPath } from "../shared/agent-adapters";

/**
 * Which conversation an Antigravity CLI (`agy`) terminal is in, so a relaunch
 * can reopen it with `agy --conversation <id>` the way Claude and OpenCode
 * resume theirs.
 *
 * agy writes nothing Tacit can match on cwd and keeps no conversation file
 * open, but its log names the conversation ("Created conversation <id>",
 * "Resuming conversation <id>"). Its default log is named after the second it
 * started, so terminals restored together shared one file and a terminal was
 * handed another's conversation. The adapter therefore launches every agy
 * with a log of the terminal's own (`--log-file`), read here. Verified against
 * agy 1.2.12.
 */

const CONVERSATION_ID = /conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/**
 * The conversation a log names last, or null before the first message. Last,
 * not first: a relaunch appends to the same log, and a conversation started
 * inside agy later is the one to resume.
 */
export function conversationIdFromLog(text: string): string | null {
  let last: string | null = null;
  for (const match of text.matchAll(CONVERSATION_ID)) last = match[1];
  return last;
}

export interface AntigravitySessionDeps {
  readFile: (file: string) => string | null;
  exists: (file: string) => boolean;
  homeDir: string;
}

const defaultDeps: AntigravitySessionDeps = {
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
  terminalId: string,
  deps: AntigravitySessionDeps = defaultDeps,
): { sessionId: string; confidence: "strong" } | null {
  const text = deps.readFile(antigravityLogPath(deps.homeDir, terminalId));
  const id = text ? conversationIdFromLog(text) : null;
  // Only an id agy actually saved can be resumed.
  const saved = id
    ? deps.exists(path.join(deps.homeDir, ".gemini", "antigravity-cli", "conversations", `${id}.db`))
    : false;
  return id && saved ? { sessionId: id, confidence: "strong" } : null;
}
