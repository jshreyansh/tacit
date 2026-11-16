import { create } from "zustand";
import { workspaceManagerBriefing } from "../../shared/manager-role";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { getTranslations } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useProjectStore } from "../stores/projectStore";
import type { ProjectData, TerminalData, TerminalType, WorktreeData } from "../types";
import { createTerminalInScene } from "./terminalSceneActions";
import { waitForTerminalReady } from "./sceneConnectionActions";
import { getLivePtyId } from "./terminalLookup";
import { ensureManagerChat, hasChatMode, sendToManagerChat } from "./managerChatMode";

/**
 * Who runs a workdesk: seating a manager, starting a new one, and taking the
 * seat away. One place for it, so the setup card, the Assign control and the
 * Manager panel behave the same.
 */

interface Located {
  project: ProjectData;
  worktree: WorktreeData;
  terminal: TerminalData;
}

function locate(terminalId: string): Located | null {
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((x) => x.id === terminalId);
      if (terminal) return { project, worktree, terminal };
    }
  }
  return null;
}

function activeCanvasId(): string | null {
  const { activeCanvasId: id, canvases } = useCanvasRegistryStore.getState();
  return id ?? canvases[0]?.id ?? null;
}

export function currentManagerId(): string | null {
  const { activeCanvasId: id, canvases } = useCanvasRegistryStore.getState();
  return canvases.find((c) => c.id === id)?.workspaceManagerTerminalId ?? null;
}

/** Anything running on the workdesk besides the given terminal: a late manager is caught up. */
export function workdeskHasWork(exceptId?: string): boolean {
  return useProjectStore
    .getState()
    .projects.some((p) => p.worktrees.some((w) => w.terminals.some((t) => !t.stashed && t.id !== exceptId)));
}

export interface ManagerCandidate {
  id: string;
  type: TerminalType;
  /** Where it runs: folder, and branch when there's one. */
  where: string;
}

/** Agents already running on the workdesk that could take the seat, keeping their conversation. */
export function managerCandidates(projects: readonly ProjectData[], managerId: string | null): ManagerCandidate[] {
  const out: ManagerCandidate[] = [];
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (terminal.stashed || terminal.id === managerId) continue;
        if (!findAgentAdapter(terminal.type)) continue;
        const name = terminal.customTitle || project.name;
        out.push({ id: terminal.id, type: terminal.type, where: worktree.name ? `${name} · ${worktree.name}` : name });
      }
    }
  }
  return out;
}

const BRIEF_FAILED =
  "Couldn't brief the new manager. It still has the role; just ask it to call get_workspace_summary directly.";

async function sendBriefing(terminalId: string, briefing: string): Promise<void> {
  const notify = useNotificationStore.getState().notify;
  // A tile in chat mode runs no shell to type into: the briefing is a
  // message in its chat, as it is for a new manager.
  if (locate(terminalId)?.terminal.chatMode) {
    try {
      await ensureManagerChat(terminalId);
      if (await sendToManagerChat(terminalId, briefing)) return;
    } catch {
      // Warned about below.
    }
    notify("warn", BRIEF_FAILED);
    return;
  }
  const found = await waitForTerminalReady(terminalId);
  const ptyId = found ? getLivePtyId(terminalId) : null;
  if (!found || ptyId == null) {
    notify("warn", BRIEF_FAILED);
    return;
  }
  const result = await window.tacit.browser.notifyWired(
    { terminalId, ptyId, terminalType: found.terminal.type, worktreePath: found.worktree.path },
    briefing,
  );
  if (!result.ok) notify("warn", `Couldn't brief the new manager: ${result.detail ?? result.error}. It still has the role; just ask it to call get_workspace_summary directly.`);
}

function agentName(type: string): string {
  return findAgentAdapter(type)?.displayName ?? type;
}

/** Opens the Manager panel on its chat, where the new manager is talked to. */
function openChat(): void {
  useChatDockStore.getState().showFace("chat");
}

/**
 * Gives the seat to an agent already on the workdesk. It keeps its own
 * conversation; it's briefed unless it was briefed when it started.
 */
export function seatManager(terminalId: string, options?: { briefedAtLaunch?: boolean }): void {
  const canvasId = activeCanvasId();
  if (!canvasId) return;
  const outgoingId = currentManagerId();
  const outgoing = outgoingId ? locate(outgoingId)?.terminal : null;
  const incoming = locate(terminalId)?.terminal ?? null;
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, terminalId);
  useManagerSetupStore.getState().done(canvasId);
  if (incoming) usePreferencesStore.getState().setLastManagerAgent(incoming.type);
  openChat();
  // Say plainly whether the conversation survives the handover. Two agents
  // of the same CLI read the same transcript format, so it does; across
  // CLIs it cannot, and the new holder picks up from the journal instead.
  if (outgoing && incoming && outgoing.id !== incoming.id) {
    const t = getTranslations();
    useNotificationStore
      .getState()
      .notify(
        "info",
        outgoing.type === incoming.type
          ? t.project_chat_handover_keeps
          : t.project_chat_handover_drops(agentName(outgoing.type), agentName(incoming.type)),
      );
  }
  if (!options?.briefedAtLaunch) void sendBriefing(terminalId, workspaceManagerBriefing(workdeskHasWork(terminalId)));
}

/** Where a new manager starts: the given folder, the focused one, or the busiest. */
function managerHome(start?: { projectId: string; worktreeId: string }): { projectId: string; worktreeId: string } | null {
  if (start) return start;
  const { focusedProjectId, focusedWorktreeId, projects } = useProjectStore.getState();
  if (focusedProjectId && focusedWorktreeId) return { projectId: focusedProjectId, worktreeId: focusedWorktreeId };
  // Nothing focused yet: the worktree with the most running terminals is
  // the best guess at where you're working; the first one otherwise.
  let best: { projectId: string; worktreeId: string; count: number } | null = null;
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const count = worktree.terminals.filter((x) => !x.stashed).length;
      if (!best || count > best.count) best = { projectId: project.id, worktreeId: worktree.id, count };
    }
  }
  return best;
}

/**
 * Starts a new agent as the manager. The briefing is its launch prompt (or
 * its chat's first message), so nothing is typed into a process that isn't
 * reading yet. Returns false when there's no folder to start it in.
 */
export function startManager(
  type: TerminalType,
  start?: { projectId: string; worktreeId: string; firstMessage?: string },
): boolean {
  const home = managerHome(start);
  if (!home) {
    useNotificationStore.getState().notify("warn", getTranslations().manager_needs_folder);
    return false;
  }
  const briefing = workspaceManagerBriefing(workdeskHasWork());
  const firstMessage = start?.firstMessage;
  if (hasChatMode(type)) {
    // Managers whose agent has a chat start in it: the tile starts no
    // process, and the briefing is the chat's first message.
    const terminal = createTerminalInScene({ ...home, type });
    useProjectStore.getState().setTerminalChatMode(home.projectId, home.worktreeId, terminal.id, true);
    seatManager(terminal.id, { briefedAtLaunch: true });
    void ensureManagerChat(terminal.id)
      .then(() => sendToManagerChat(terminal.id, briefing))
      .then(() => (firstMessage ? sendToManagerChat(terminal.id, firstMessage) : undefined));
    return true;
  }
  const terminal = createTerminalInScene({
    ...home,
    type,
    initialPrompt: firstMessage ? `${briefing}\n\nThe user's first request:\n${firstMessage}` : briefing,
  });
  seatManager(terminal.id, { briefedAtLaunch: true });
  return true;
}

/** Takes the seat away. The agent and the workers it started keep running. */
export function removeManager(): void {
  const canvasId = activeCanvasId();
  if (canvasId) useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, null);
}

/**
 * Workdesks that should ask "Who runs this workdesk?": set when a first
 * folder lands on a workdesk without a manager, cleared on an answer (a
 * manager, or Skip). In memory only: after a restart, the Assign control
 * at the bottom is the way in.
 */
interface ManagerSetupStore {
  asking: Record<string, true>;
  ask: (canvasId: string) => void;
  done: (canvasId: string) => void;
}

export const useManagerSetupStore = create<ManagerSetupStore>((set) => ({
  asking: {},
  ask: (canvasId) => set((s) => (s.asking[canvasId] ? s : { asking: { ...s.asking, [canvasId]: true } })),
  done: (canvasId) =>
    set((s) => {
      if (!s.asking[canvasId]) return s;
      const asking = { ...s.asking };
      delete asking[canvasId];
      return { asking };
    }),
}));

/** Called when a folder lands on a workdesk that had none. */
export function askWhoRunsIt(): void {
  const canvasId = activeCanvasId();
  if (canvasId && !currentManagerId()) useManagerSetupStore.getState().ask(canvasId);
}

/** Skip: this workdesk runs without a manager for now. */
export function skipManager(): void {
  const canvasId = activeCanvasId();
  if (canvasId) useManagerSetupStore.getState().done(canvasId);
}
