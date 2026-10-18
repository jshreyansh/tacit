import type { ApprovalDecision } from "../../shared/chat-events";
import { useManagerChatStore } from "../stores/managerChatStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { findTerminal } from "./terminalLookup";

/**
 * Moving the workdesk manager between its terminal tile and the docked chat
 * (T6). The manager keeps its terminal: Tacit knows it by that id. In chat
 * mode the tile starts no process and the agent runs in its structured
 * protocol; only one of the two holds the session at a time, and each picks
 * up the other's session when it takes over.
 */

/** Agents with a chat mode so far. */
export function hasChatMode(type: string | null | undefined): type is "claude" | "codex" {
  return type === "claude" || type === "codex";
}

/**
 * Starts a terminal's chat agent, resuming the terminal's session: the
 * manager's, or a past session continued in chat.
 */
export async function startTerminalChat(terminalId: string): Promise<boolean> {
  const found = findTerminal(terminalId);
  if (!found || !hasChatMode(found.terminal.type)) return false;
  const result = await window.tacit.chat.start({
    terminalId,
    agent: found.terminal.type,
    cwd: found.worktree.path,
    sessionId: found.terminal.sessionId ?? null,
  });
  if (!result.ok) {
    useNotificationStore.getState().notify("warn", result.error ?? "The chat couldn't start the agent.");
    return false;
  }
  // Starting read the session's history from the agent's record: the chat
  // shows it, including what was said in the terminal.
  const snapshot = await window.tacit.chat.snapshot(terminalId);
  useManagerChatStore.getState().hydrate(terminalId, snapshot.events);
  return true;
}

/** Moves the manager out of its tile and into the chat. */
export async function moveManagerToChat(terminalId: string): Promise<void> {
  const found = findTerminal(terminalId);
  if (!found || !hasChatMode(found.terminal.type)) return;
  // Stopping the tile's process first, so one owner holds the session.
  useProjectStore.getState().setTerminalChatMode(found.project.id, found.worktree.id, terminalId, true);
  const ok = await startTerminalChat(terminalId);
  if (!ok) useProjectStore.getState().setTerminalChatMode(found.project.id, found.worktree.id, terminalId, false);
}

/** Moves the manager back into its tile, which resumes the chat's session. */
export async function moveManagerToTerminal(terminalId: string): Promise<void> {
  const found = findTerminal(terminalId);
  if (!found) return;
  await window.tacit.chat.stop(terminalId);
  const snapshot = await window.tacit.chat.snapshot(terminalId);
  useProjectStore
    .getState()
    .setTerminalChatMode(found.project.id, found.worktree.id, terminalId, false, snapshot.sessionId ?? found.terminal.sessionId);
}

/**
 * Asks to move the manager to the terminal or into the chat. While it's
 * mid-turn the move waits for the turn to end (the pill carries it out),
 * since moving stops the process the turn runs in; otherwise it moves now.
 */
export function requestManagerMove(terminalId: string, to: "terminal" | "chat", busy: boolean): void {
  if (busy) {
    useManagerChatStore.getState().setPendingMove(terminalId, to);
    return;
  }
  useManagerChatStore.getState().setPendingMove(terminalId, null);
  void (to === "terminal" ? moveManagerToTerminal(terminalId) : moveManagerToChat(terminalId));
}

/** Carries out a waiting move at once, stopping the turn. */
export function moveManagerNow(terminalId: string): void {
  const to = useManagerChatStore.getState().pendingMoves[terminalId];
  if (to) requestManagerMove(terminalId, to, false);
}

export function cancelManagerMove(terminalId: string): void {
  useManagerChatStore.getState().setPendingMove(terminalId, null);
}

/**
 * For a manager already in chat mode: catches up on the conversation and,
 * when its agent isn't running (the app just started), starts it again on
 * the same session.
 */
export async function ensureManagerChat(terminalId: string): Promise<void> {
  const snapshot = await window.tacit.chat.snapshot(terminalId);
  useManagerChatStore.getState().hydrate(terminalId, snapshot.events);
  if (!snapshot.running) await startTerminalChat(terminalId);
}

export function sendToManagerChat(terminalId: string, text: string): Promise<boolean> {
  return window.tacit.chat.send(terminalId, text);
}

export function interruptManagerChat(terminalId: string): Promise<void> {
  return window.tacit.chat.interrupt(terminalId);
}

export function answerManagerApproval(terminalId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
  return window.tacit.chat.answer(terminalId, requestId, decision);
}

/**
 * Feeds the engine's events into the store, and keeps the terminal's
 * session id in step with the chat's, so "Open in terminal" and the next
 * launch resume the right conversation.
 */
export function installManagerChatListener(): () => void {
  return window.tacit.chat.onEvent(({ terminalId, event }) => {
    useManagerChatStore.getState().apply(terminalId, event);
    if (event.kind === "session") {
      const found = findTerminal(terminalId);
      if (found && found.terminal.sessionId !== event.sessionId) {
        useProjectStore.getState().updateTerminalSessionId(found.project.id, found.worktree.id, terminalId, event.sessionId);
      }
    }
  });
}

export function answerChatQuestion(terminalId: string, requestId: string, answers: Record<string, string[]> | null): Promise<void> {
  return window.tacit.chat.answerQuestion(terminalId, requestId, answers);
}

export function configureChat(terminalId: string, settings: { model?: string | null; effort?: string | null; mode?: string | null }): Promise<void> {
  return window.tacit.chat.configure(terminalId, settings);
}
