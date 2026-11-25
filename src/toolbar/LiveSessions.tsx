import { useMemo } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useCompletionSeenStore } from "../stores/completionSeenStore";
import { buildCanvasTerminalSections, buildProjectTree } from "../components/sessionPanelModel";
import { useWaitingAgents } from "../board/canvasRequests";
import { useWaitingHere } from "../attention/waiting";
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
  const waiting = useWaitingAgents();
  return useMemo(() => {
    const sessionsById = new Map<string, (typeof liveSessions)[number]>();
    for (const session of [...historySessions, ...liveSessions]) sessionsById.set(session.sessionId, session);
    const telemetry = new Map<string, (typeof runtimeTerminals)[string]["telemetry"]>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    const sections = buildCanvasTerminalSections(projects, telemetry, sessionsById);
    const tree = buildProjectTree(projects, telemetry, sessionsById, seenTerminalIds);
    // One that asked you to allow something waits on you, whatever its turn is doing.
    if (waiting.size) {
      for (const p of tree.projects)
        for (const w of p.worktrees)
          for (const item of w.terminals)
            if (waiting.has(item.terminalId) && item.state !== "attention") {
              item.state = "attention";
              item.attentionReason = "awaiting_input";
            }
    }
    return { attention: sections.attention, tree: tree.projects, stashed: tree.stashed, seenTerminalIds };
  }, [projects, runtimeTerminals, liveSessions, historySessions, seenTerminalIds, waiting]);
}

/**
 * What's waiting on you on this workdesk, for the chat button's dot: the
 * workdesk's number (attention/waiting.ts), and the notes in its memory
 * waiting for your approval, so nothing waits for you unseen.
 */
export function useNeedsYouCount(): number {
  const notes = useMemoryPendingCount(useCanvasRegistryStore((s) => s.activeCanvasId));
  return useWaitingHere() + notes;
}
