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
import { EmptyState, SectionHeader } from "../components/ui/parts";
import {
  buildCanvasTerminalSections,
  buildProjectTree,
  type CanvasTerminalItem,
} from "../components/sessionPanelModel";
import { filterLiveTerminals, treeTerminals } from "./liveSessionsModel";
import { useTasksNeedingYou } from "../tasks/useTasksNeedingYou";
import { openPinFull } from "../tasks/TasksView";
import type { Pin } from "../types";
import { findTerminal } from "../actions/terminalLookup";
import { openLiveChatSession } from "../actions/openSession";

/**
 * A session continued in chat (not the manager) opens its chat beside the
 * manager's, in the reader; anything else shows on the canvas.
 */
function openChatSession(terminalId: string): (() => void) | undefined {
  const terminal = findTerminal(terminalId)?.terminal;
  if (!terminal?.chatMode) return undefined;
  return () => openLiveChatSession(terminalId);
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

/** What's waiting on you (terminals, and tasks an agent asked about), for the amber dots. */
export function useNeedsYouCount(): number {
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const tasks = useTasksNeedingYou().length;
  const terminals = useMemo(() => {
    const telemetry = new Map<string, (typeof runtimeTerminals)[string]["telemetry"]>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    return buildCanvasTerminalSections(projects, telemetry, new Map()).attention.length;
  }, [projects, runtimeTerminals]);
  return terminals + tasks;
}

/** A task an agent asked you about: its question, opening the task. */
function TaskNeedsRow({ task }: { task: Pin }) {
  return (
    <button
      type="button"
      className="tc-row-icon mx-1 flex w-[calc(100%-8px)] items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--sidebar-hover)]"
      onClick={() => openPinFull(task)}
    >
      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--amber)]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[var(--text-primary)]" style={{ fontSize: "var(--text-sm)" }}>
          {task.title}
        </span>
        <span className="tc-caption truncate" style={{ color: "var(--amber)" }}>
          {task.ask?.reason}
        </span>
      </span>
    </button>
  );
}

function Heading({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "amber" }) {
  return (
    <div
      className="tc-eyebrow flex items-center gap-1.5 px-4 pb-1.5 pt-4"
      style={tone === "amber" ? { color: "var(--amber)" } : undefined}
    >
      {children}
    </div>
  );
}

export function LiveSessions({ query }: { query: string }) {
  const t = useT();
  const { attention, tree, stashed, seenTerminalIds } = useLiveTree();
  const waitingTasks = useTasksNeedingYou();
  const managerId = useCanvasRegistryStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.workspaceManagerTerminalId ?? null,
  );
  const [addingProject, setAddingProject] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const running = treeTerminals(tree);

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
      {(attention.length > 0 || waitingTasks.length > 0) && (
        <section aria-label={t.chat_sessions_needs_you_heading}>
          <Heading tone="amber">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
            {t.chat_sessions_needs_you_heading}
          </Heading>
          <div className="tc-sidebar-tree-font flex flex-col">
            {attention.map((item) => card(item, false))}
            {waitingTasks.map((task) => (
              <TaskNeedsRow key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}
      {/* Everything running on this workdesk, flat: one row per agent or
          terminal, with where it runs in its meta line. */}
      <section aria-label={t.chat_sessions_running}>
        <SectionHeader label={t.chat_sessions_running} count={running.length} />
        {running.map((item) => card(item, false))}
        {running.length === 0 && <EmptyState>{t.chat_sessions_none_running}</EmptyState>}
      </section>
      {/* The folders and their branches, with their actions (new worktree,
          remove, delete from disk). Folded away: you reach for it rarely. */}
      <section aria-label={t.folder_bar_label}>
        <div className="flex items-center pr-2">
          <button
            type="button"
            aria-expanded={foldersOpen}
            onClick={() => setFoldersOpen((open) => !open)}
            className="flex flex-1 items-center gap-1.5 px-4 pb-1.5 pt-4 text-left"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" className={`shrink-0 text-[var(--text-secondary)] transition-transform duration-quick ${foldersOpen ? "rotate-90" : ""}`} aria-hidden="true">
              <path d="M3 2l4 3-4 3z" fill="currentColor" />
            </svg>
            <span className="tc-eyebrow">{t.folder_bar_label}</span>
            <span className="tc-count">{tree.length}</span>
          </button>
          <IconButton size="md" tone="neutral" label={t.shortcut_add_project} busy={addingProject} onClick={addProject}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0" aria-hidden="true">
              <path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
        {foldersOpen && (
          <div className="tc-sidebar-tree-font">
            <ProjectTree projects={tree} renderTerminal={(item) => card(item, true)} />
            {tree.length === 0 && <EmptyState>{t.sessions_no_canvas_items}</EmptyState>}
          </div>
        )}
        <StashedSection items={stashed} t={t} />
      </section>
    </>
  );
}
