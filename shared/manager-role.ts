/**
 * Who held the workspace-manager role, and which conversation they held it in.
 *
 * Conversations are filed on disk by project, and nothing in a transcript says
 * "this one was the manager" — so without this log, "show me my past chats with
 * the manager" is unanswerable, and the Project Chat history list has nothing to
 * filter on. It is the one piece of this feature that cannot be reconstructed
 * afterwards: it has to be recorded while the work is happening.
 *
 * A tenure is (terminal, session) rather than just (terminal), because a session
 * can end and restart underneath a terminal that keeps the role the whole time —
 * `/clear` does exactly that, and a real canvas here has already done it once
 * (SessionEnd 21d4c3c4 → SessionStart bda486ee on an unchanged manager). Keying
 * on the terminal alone would silently glue two unrelated conversations into one
 * history entry.
 */

export const MANAGER_ROLE_SCHEMA_VERSION = 1;

export interface ManagerTenure {
  schema_version: typeof MANAGER_ROLE_SCHEMA_VERSION;
  /** The terminal that held the role. */
  terminalId: string;
  /**
   * The conversation it held the role in. Null when the role was assigned
   * before the agent reported a session — the id is filled in by a later
   * tenure record rather than mutated in place, since the log is append-only.
   */
  sessionId: string | null;
  /** claude | codex | gemini — which CLI, so history rows can be labelled. */
  cli: string | null;
  /**
   * Path to the conversation's transcript. Stored rather than looked up later
   * because the live session scan only covers a recent window — an older
   * tenure would still be listed but could not be opened.
   */
  sessionFile: string | null;
  canvasId: string | null;
  startedAt: string;
  /** Null while this tenure is still current. */
  endedAt: string | null;
  /**
   * Why the tenure ended. `reassigned` — a different terminal took the role.
   * `cleared` — same terminal, new conversation underneath it.
   * `unassigned` — the role was removed entirely.
   */
  endedBy?: "reassigned" | "cleared" | "unassigned";
}

/**
 * One row in the Project Chat history dropdown. Derived from the log rather
 * than stored, so a tenure whose session was only learned later still resolves.
 */
export interface ManagerSessionRow {
  terminalId: string;
  sessionId: string;
  sessionFile: string | null;
  cli: string | null;
  canvasId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** True for the tenure currently in force. */
  isCurrent: boolean;
}

/**
 * Collapse the append-only log into the history list.
 *
 * Tenures with no session are dropped — they cannot be opened or resumed, so a
 * row for one would be a dead entry in the menu. Repeated tenures of the same
 * conversation (assign → unassign → reassign the same terminal without a
 * `/clear` in between) merge into a single row spanning the whole period, which
 * is what a reader means by "that conversation", rather than three fragments.
 */
export function toSessionRows(tenures: ManagerTenure[]): ManagerSessionRow[] {
  // Two passes, because the file is append-only: opening a tenure writes a line
  // with `endedAt: null` and closing it writes a SECOND line for the same
  // tenure with the end time filled in. Merging straight to sessions would see
  // the lingering open line and call a long-finished conversation current.
  //
  // A tenure is identified by (session, startedAt) — the pair both of its lines
  // share — so the close can be matched to its open and win.
  const byTenure = new Map<string, ManagerTenure>();
  for (const tenure of tenures) {
    if (!tenure.sessionId) continue;
    const key = `${tenure.sessionId}\0${tenure.startedAt}`;
    const existing = byTenure.get(key);
    if (!existing) {
      byTenure.set(key, { ...tenure });
      continue;
    }
    if (tenure.endedAt !== null) {
      existing.endedAt =
        existing.endedAt === null || tenure.endedAt > existing.endedAt
          ? tenure.endedAt
          : existing.endedAt;
      existing.endedBy = tenure.endedBy ?? existing.endedBy;
    }
    existing.cli = existing.cli ?? tenure.cli;
  }

  const bySession = new Map<string, ManagerSessionRow>();
  for (const tenure of byTenure.values()) {
    const sessionId = tenure.sessionId!;
    const existing = bySession.get(sessionId);
    if (!existing) {
      bySession.set(sessionId, {
        terminalId: tenure.terminalId,
        sessionId,
        sessionFile: tenure.sessionFile,
        cli: tenure.cli,
        canvasId: tenure.canvasId,
        startedAt: tenure.startedAt,
        endedAt: tenure.endedAt,
        isCurrent: tenure.endedAt === null,
      });
      continue;
    }
    // Same conversation held more than once (assigned, unassigned, assigned
    // again with no /clear between): one row spanning the whole period, which
    // is what a reader means by "that conversation".
    if (tenure.startedAt < existing.startedAt) existing.startedAt = tenure.startedAt;
    if (tenure.endedAt === null) {
      existing.endedAt = null;
      existing.isCurrent = true;
    } else if (existing.endedAt !== null && tenure.endedAt > existing.endedAt) {
      existing.endedAt = tenure.endedAt;
    }
    existing.cli = existing.cli ?? tenure.cli;
    existing.sessionFile = existing.sessionFile ?? tenure.sessionFile;
  }

  return [...bySession.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

// One-time briefing injected into a terminal the moment it's assigned the
// workspace-manager role — this is what makes "swap the underlying agent,
// it picks up context" real: the new holder is told to read the
// continuity journal via get_workspace_summary rather than starting cold.
// Deliberately doesn't state a raw memory directory path — the MCP tools
// resolve that internally, so the agent never needs to know it.
//
// It names only the tools it gives an instruction about. The agent already
// receives the full list, with descriptions, from the `tacit` MCP server; a
// copy here is what drifted (it once named 10 of 17 and missed emit_event).
// tests/manager-briefing.test.ts fails if a tool named here stops existing.
export const WORKSPACE_MANAGER_BRIEFING = [
  "You've been assigned the workspace manager role for this canvas.",
  "Your tools come from the `tacit` MCP server; its tool list is the complete set, including the ones only a manager can use.",
  "Start by calling get_workspace_summary — it returns what's already on this canvas plus the most recent entries from the workspace's continuity journal, written by anyone who held this role before you (including a past version of you, if you're being reassigned back after being swapped out).",
  "Delegate by starting workers with spawn_terminal (give each its task as the prompt), then steer one worker at a time with send_prompt_to_node; emit_event reaches every node wired to you at once. Use wait_for_nodes to be told when workers finish or need a person, instead of checking on them repeatedly, and close workers and browsers you're finished with using close_node. To tell whether a worker is mid-task, read busy from get_node_state, not status. When you take on a new task, call start_run with its goal first, and end_run when it's done, so the record groups the work.",
  "Call log_activity after spawning/wiring nodes or making a real decision, so a future agent who picks up this role — even a different underlying CLI — can actually pick up where you left off instead of starting cold.",
].join(" ");

/**
 * Is this transcript line the handover briefing rather than something the user
 * wrote?
 *
 * It is delivered by typing into the agent's terminal, which is the only way to
 * talk to a CLI — so the transcript records it as `role: user`, and the chat
 * would render that wall of setup text as a message from the person reading it.
 * They did not write it. Recognising it is what lets the conversation show the
 * handover it actually represents.
 *
 * Matched on the opening sentence rather than the whole string: a transcript
 * may hold a truncated preview, and the tail of the briefing changes whenever
 * the tool list does.
 */
const BRIEFING_OPENER = "You've been assigned the workspace manager role";

export function isWorkspaceManagerBriefing(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith(BRIEFING_OPENER);
}
