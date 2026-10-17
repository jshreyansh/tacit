import { useCallback, useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { useSessionStore } from "../stores/sessionStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useCompletionSeenStore } from "../stores/completionSeenStore";
import { promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { ProjectTree } from "../components/ProjectTree";
import { StashedSection, TerminalCard } from "../components/SessionsPanel";
import { IconButton } from "../components/ui/IconButton";
import {
  buildCanvasTerminalSections,
  buildProjectTree,
  type CanvasTerminalItem,
} from "../components/sessionPanelModel";
import { filterLiveTerminals, treeTerminals } from "./liveSessionsModel";
import { findTerminal } from "../actions/terminalLookup";
import { useCanvasStore } from "../stores/canvasStore";

/**
 * A session continued in chat (not the manager) opens its chat beside the
 * manager's, in the reader; anything else shows on the canvas.
 */
function openChatSession(terminalId: string): (() => void) | undefined {
  const terminal = findTerminal(terminalId)?.terminal;
  if (!terminal?.chatMode) return undefined;
  return () => {
    useSessionStore.getState().openLiveChat(terminalId);
    useCanvasStore.getState().openSessionsOverlay();
  };
}

/**
 * What is on this workdesk now, at the top of the docked chat's Sessions
 * view: whoever needs you, then every project, worktree and terminal, with
 * the project and worktree actions the left bar's Sessions panel had. Past
 * sessions follow it in the same list (ChatHistory).
 */

function useLiveTree() {
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

/** How many terminals are waiting on you, for the dot on the Sessions icon. */
export function useNeedsYouCount(): number {
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  return useMemo(() => {
    const telemetry = new Map<string, (typeof runtimeTerminals)[string]["telemetry"]>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    return buildCanvasTerminalSections(projects, telemetry, new Map()).attention.length;
  }, [projects, runtimeTerminals]);
}

function Heading({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "amber" }) {
  return (
    <div
      className={`flex items-center gap-1.5 px-3.5 pb-1 pt-2.5 text-[10.5px] uppercase tracking-[0.06em] ${
        tone === "amber" ? "text-[var(--amber)]" : "text-[var(--text-muted)]"
      }`}
    >
      {children}
    </div>
  );
}

export function LiveSessions({ query }: { query: string }) {
  const t = useT();
  const { attention, tree, stashed, seenTerminalIds } = useLiveTree();
  const managerId = useCanvasRegistryStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.workspaceManagerTerminalId ?? null,
  );
  const [addingProject, setAddingProject] = useState(false);

  const addProject = useCallback(async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      await promptAndAddProjectToScene(t);
    } finally {
      setAddingProject(false);
    }
  }, [addingProject, t]);

  const card = (item: CanvasTerminalItem, hideLocation: boolean) => (
    <TerminalCard
      key={item.terminalId}
      item={item}
      t={t}
      hideLocation={hideLocation}
      unseenDone={item.state === "done" && !seenTerminalIds.has(item.terminalId)}
      onOpen={managerId === item.terminalId ? undefined : openChatSession(item.terminalId)}
    />
  );

  const searching = query.trim().length > 0;
  if (searching) {
    const matches = filterLiveTerminals(treeTerminals(tree), query);
    if (matches.length === 0) return null;
    return (
      <section aria-label={t.chat_sessions_on_workdesk}>
        <Heading>{t.chat_sessions_on_workdesk}</Heading>
        <div className="tc-sidebar-tree-font flex flex-col">{matches.map((item) => card(item, false))}</div>
      </section>
    );
  }

  return (
    <>
      {attention.length > 0 && (
        <section aria-label={t.chat_sessions_needs_you_heading}>
          <Heading tone="amber">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
            {t.chat_sessions_needs_you_heading}
          </Heading>
          <div className="tc-sidebar-tree-font flex flex-col">{attention.map((item) => card(item, false))}</div>
        </section>
      )}
      <section aria-label={t.chat_sessions_on_workdesk}>
        <div className="flex items-center pr-2">
          <Heading>{t.chat_sessions_on_workdesk}</Heading>
          <div className="flex-1" />
          <IconButton size="md" tone="neutral" label={t.shortcut_add_project} busy={addingProject} onClick={addProject}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0" aria-hidden="true">
              <path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
        <div className="tc-sidebar-tree-font">
          <ProjectTree projects={tree} renderTerminal={(item) => card(item, true)} />
          {tree.length === 0 && <div className="tc-label px-4 py-4 text-center">{t.sessions_no_canvas_items}</div>}
          <StashedSection items={stashed} t={t} />
        </div>
      </section>
    </>
  );
}
