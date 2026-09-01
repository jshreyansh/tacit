/**
 * Reading an agent's last words off disk.
 *
 * The renderer cannot do this — session transcripts are files, and files are
 * main's. So the renderer asks by session id and gets back either the reply or
 * a reason there isn't one, never a path and never a raw transcript: the whole
 * file is the agent's working history, and only the final message was ever
 * meant to leave the terminal.
 *
 * Only the tail is read. A long session is megabytes, this runs on every
 * turn-completion signal, and the decision only ever depends on the end.
 */

import fs from "fs";
import {
  extractFinalAssistantReply,
  isReplyTranscriptProvider,
  type ReplyExtraction,
} from "../shared/agent-reply.ts";
import { resolveSessionFile, type SessionType } from "./session-watcher.ts";

/**
 * How much of the end to read. Generous enough that a final message with a
 * long code block, and the tool calls before it that prove the task is over,
 * both fit — a tail too short to reach the previous message reads as
 * "no-reply" instead of as an answer.
 */
const TAIL_BYTES = 512 * 1024;

export type FinalReplyResult =
  | { status: "ready"; text: string }
  | { status: "mid-task" }
  | { status: "no-reply" }
  /** No transcript to read: unresolvable path, unreadable file, or opencode. */
  | { status: "unavailable"; reason: string };

function readTail(filePath: string): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return "";
    fd = fs.openSync(filePath, "r");
    const readSize = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    return buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do about a failed close of a read-only handle.
      }
    }
  }
}

export function readFinalAssistantReply(input: {
  sessionId: string;
  provider: string;
  cwd: string;
}): FinalReplyResult {
  if (!isReplyTranscriptProvider(input.provider)) {
    // opencode keeps its turns in a directory of per-message files rather than
    // one appended log, so there is no tail to read. Saying so beats guessing.
    return { status: "unavailable", reason: `unsupported-provider:${input.provider}` };
  }
  if (!input.sessionId) {
    return { status: "unavailable", reason: "no-session" };
  }

  const filePath = resolveSessionFile(
    input.sessionId,
    input.provider as SessionType,
    input.cwd,
  );
  if (!filePath) return { status: "unavailable", reason: "session-file-not-found" };

  const raw = readTail(filePath);
  if (raw === null) return { status: "unavailable", reason: "transcript-unreadable" };

  const extraction: ReplyExtraction = extractFinalAssistantReply(raw, input.provider);
  return extraction;
}
