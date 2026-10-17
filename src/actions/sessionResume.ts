import { createTerminal, useProjectStore } from "../stores/projectStore";
import { createTerminalInScene } from "./terminalSceneActions";
import { startTerminalChat } from "./managerChatMode";
import { useNotificationStore } from "../stores/notificationStore";
import { useSessionStore } from "../stores/sessionStore";
import { useCanvasStore } from "../stores/canvasStore";
import { panToTerminal } from "../utils/panToTerminal";
import type { ResumableAgent } from "../toolbar/sessionReaderModel";

/**
 * Picking a past session up again, from the reader: in chat (its own chat,
 * a node on the canvas with the conversation inside; the manager's seat is
 * not touched), in the agent's own terminal, or forked from a turn.
 */

export interface ResumeTarget {
  agent: ResumableAgent;
  sessionId: string;
  projectId: string;
  worktreeId: string;
  title: string;
}

/** The worktree on this canvas a session ran in, to resume it there. */
export function resumeTargetFor(
  agent: ResumableAgent | null,
  sessionId: string,
  projectDir: string,
  title: string,
): ResumeTarget | null {
  if (!agent) return null;
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      if (worktree.path === projectDir) return { agent, sessionId, projectId: project.id, worktreeId: worktree.id, title };
    }
  }
  return null;
}

/** A terminal on the canvas already holding this session, if one is. */
export function terminalHoldingSession(sessionId: string): string | null {
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((t) => t.sessionId === sessionId);
      if (terminal) return terminal.id;
    }
  }
  return null;
}

function newTerminal(target: ResumeTarget, sessionId: string, chatMode: boolean) {
  const base = createTerminal(target.agent, target.title.slice(0, 60) || undefined, undefined, undefined, "user");
  base.sessionId = sessionId;
  if (chatMode) base.chatMode = true;
  return createTerminalInScene({ projectId: target.projectId, worktreeId: target.worktreeId, terminal: base, origin: "user" });
}

/**
 * Continues the session as its own chat: a chat node on the canvas, shown
 * live in the reader. The tile starts no process; the chat agent resumes
 * the session.
 */
export async function continueSessionInChat(target: ResumeTarget): Promise<void> {
  const created = newTerminal(target, target.sessionId, true);
  useSessionStore.getState().openLiveChat(created.id);
  const ok = await startTerminalChat(created.id);
  if (!ok) {
    // It couldn't start: the node goes back to being a terminal that resumes it.
    useProjectStore.getState().setTerminalChatMode(target.projectId, target.worktreeId, created.id, false);
    useSessionStore.getState().exitReplay();
    useCanvasStore.getState().closeSessionsOverlay();
    panToTerminal(created.id);
  }
}

/** Resumes the session in the agent's own terminal on the canvas. */
export function resumeSessionInTerminal(target: ResumeTarget, notice: string): void {
  const created = newTerminal(target, target.sessionId, false);
  useSessionStore.getState().exitReplay();
  useCanvasStore.getState().closeSessionsOverlay();
  panToTerminal(created.id);
  useNotificationStore.getState().notify("info", notice);
}

/**
 * A new session made of this one up to a turn, resumed in a terminal: to
 * try that turn again, or go another way from it.
 */
export async function forkSessionAt(target: ResumeTarget, filePath: string, promptIndex: number, notice: string): Promise<void> {
  try {
    const { newSessionId } = await useSessionStore.getState().forkSession(filePath, promptIndex, target.agent);
    const created = newTerminal(target, newSessionId, false);
    useSessionStore.getState().exitReplay();
    useCanvasStore.getState().closeSessionsOverlay();
    panToTerminal(created.id);
    useNotificationStore.getState().notify("info", notice);
  } catch (err) {
    useNotificationStore.getState().notify("error", err instanceof Error ? err.message : String(err));
  }
}
