import { useMemo } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useCompletionSeenStore } from "../stores/completionSeenStore";
import { buildCanvasTerminalSections, buildProjectTree } from "../components/sessionPanelModel";
import { useTasksNeedingYou } from "../tasks/taskStore";
import { useMemoryPendingCount } from "../components/MemoryView";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";

/**
 * What is on this workdesk now: whoever needs you, then every project,
 * worktree and terminal. Read by the list of chats beside the manager's
 * (ChatList) and by the amber dots.
 */
export function useLiveTree() {
  const liveSessions = useSessionStore((s) => s.liveSessions);
  const historySessions = useSessionStore((s) => s.historySessions);
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const seenTerminalIds = useCompletionSeenStore((s) => s.seenTerminalIds);
  return useMemo(() => {
    const sessionsById = new Map<string, (typeof liveSessions)[number]>();
    for (const session of [...historySessions, ...liveSessions]) sessionsById.set(session.sessionId, session);
    const telemetry = new Map<string, (typeof runtimeTerminals)[string]["telemetry"]>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    const sections = buildCanvasTerminalSections(projects, telemetry, sessionsById);
    const tree = buildProjectTree(projects, telemetry, sessionsById, seenTerminalIds);
    return { attention: sections.attention, tree: tree.projects, stashed: tree.stashed, seenTerminalIds };
  }, [projects, runtimeTerminals, liveSessions, historySessions, seenTerminalIds]);
}

/** What's waiting on you (terminals, and tasks an agent asked about), for the amber dots. */
export function useNeedsYouCount(): number {
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const tasks = useTasksNeedingYou().length;
  // Notes waiting for approval count too: nothing waits for you unseen.
  const notes = useMemoryPendingCount(useCanvasRegistryStore((s) => s.activeCanvasId));
  const terminals = useMemo(() => {
    const telemetry = new Map<string, (typeof runtimeTerminals)[string]["telemetry"]>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    return buildCanvasTerminalSections(projects, telemetry, new Map()).attention.length;
  }, [projects, runtimeTerminals]);
  return terminals + tasks + notes;
}
