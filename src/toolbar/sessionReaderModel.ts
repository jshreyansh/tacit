import type { TimelineEvent } from "../../shared/sessions";
import { isWorkspaceManagerBriefing } from "../../shared/manager-role";
import { chatTitle, type ChatTitle } from "./chatHistoryModel";

/**
 * What the past-session reader shows, apart from the conversation itself:
 * its name, the turns to jump through, how to resume it, and terminals
 * named in its text as chips. Pure, so it is tested without a DOM.
 */

export type ResumableAgent = "claude" | "codex";

/** Which agent wrote a session file, from where the agent keeps them. */
export function agentOfSessionFile(filePath: string): ResumableAgent | null {
  const p = filePath.replace(/\\/g, "/");
  if (p.includes("/.claude/projects/")) return "claude";
  if (p.includes("/.codex/sessions/")) return "codex";
  return null;
}

/** The command that resumes a session in the agent's own terminal. */
export function resumeCommand(agent: ResumableAgent, sessionId: string): string {
  return agent === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
}

export interface ReaderTurn {
  /** The thread message this turn starts with (its user message). */
  messageId: string;
  at: string;
  /** The prompt's first line; empty for the manager's briefing. */
  text: string;
  briefing: boolean;
  /** Zero-based count of user prompts, which forking counts by. */
  promptIndex: number;
}

/**
 * Every prompt in the session, in order, keyed to the chat message it
 * opens (the same ids timelineToChatEvents gives them).
 */
export function turnsOf(events: readonly TimelineEvent[], idPrefix: string): ReaderTurn[] {
  const turns: ReaderTurn[] = [];
  for (const ev of events) {
    if (ev.type !== "user_prompt") continue;
    const briefing = isWorkspaceManagerBriefing(ev.textPreview);
    const title = chatTitle(ev.textPreview);
    turns.push({
      messageId: `${idPrefix}u${ev.index}`,
      at: ev.timestamp,
      text: briefing ? "" : title.kind === "text" ? title.text : ev.textPreview.replace(/\s+/g, " ").trim(),
      briefing,
      promptIndex: turns.length,
    });
  }
  return turns;
}

/** Turns whose prompt contains every word of the query, any case. */
export function filterTurns(turns: readonly ReaderTurn[], query: string): ReaderTurn[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...turns];
  return turns.filter((turn) => words.every((word) => turn.text.toLowerCase().includes(word)));
}

/** How many messages the session holds: prompts and replies. */
export function messageCount(events: readonly TimelineEvent[]): number {
  return events.filter((ev) => ev.type === "user_prompt" || ev.type === "assistant_text").length;
}

/** The session's name, as its row in Sessions gives it. */
export function readerTitle(events: readonly TimelineEvent[]): ChatTitle {
  const first = events.find((ev) => ev.type === "user_prompt");
  return chatTitle(first?.textPreview);
}

/** A Tacit terminal id as agents write it: creation time in ms, then a count. */
export const TERMINAL_ID_PATTERN = /`?\b(1\d{12}-\d{1,4})\b`?/g;

export interface NodeDescription {
  label: string;
  /** Still on the canvas. */
  open: boolean;
}

/** Where a node chip points; the chat turns clicks on it into Show on canvas. */
export const NODE_CHIP_HREF = "#tacit-node=";

function escapeLabel(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

/**
 * Terminal ids in an agent's text become links that read as the terminal's
 * name, which the chat draws as chips. Fenced code is left alone.
 */
export function linkNodeIds(text: string, describe: (id: string) => NodeDescription | null): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((segment, i) => {
      if (i % 2 === 1) return segment;
      return segment.replace(TERMINAL_ID_PATTERN, (match, id: string) => {
        const node = describe(id);
        if (!node) return match;
        return `[${escapeLabel(node.label)}](${NODE_CHIP_HREF}${id} "${node.open ? id : `${id} (closed)`}")`;
      });
    })
    .join("");
}
