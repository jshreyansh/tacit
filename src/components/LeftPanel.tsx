import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { TITLE_STRIP_HEIGHT } from "../toolbar/titleStripHeight";
import {
  useCanvasStore,
  CHROME_GAP,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
} from "../stores/canvasStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useSessionStore } from "../stores/sessionStore";
import { useCompletionSeenStore } from "../stores/completionSeenStore";
import { useT } from "../i18n/useT";
import { PanelCollapseButton } from "./PanelCollapseButton";
import { useSidebarDragStore } from "../stores/sidebarDragStore";
import { useViewportFocusStore } from "../stores/viewportFocusStore";
import { panToTerminal } from "../utils/panToTerminal";
import {
  PANEL_REVEAL_TRANSITION,
  PANEL_TRANSITION_DURATION_MS,
  PANEL_TRANSITION_EASING_FN,
} from "../utils/panelAnimation";
import { promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { buildProjectTree, type CanvasTerminalItem } from "./sessionPanelModel";
import { ProjectTree } from "./ProjectTree";
import { TerminalCard, HistorySection, StashedSection } from "./SessionsPanel";
import { PinDrawer } from "./PinDrawer";

/*
 * Left panel — project management + session history.
 *
 * Two tabbed surfaces:
 *   1. Sessions: live projects / worktrees / terminals. Click a
 *      terminal row to pan the canvas to it.
 *   2. History: past Claude/Codex sessions. Click a row to open
 *      the replay drawer.
 */


export function LeftPanel() {
  const t = useT();
  const collapsed = useCanvasStore((s) => s.leftPanelCollapsed);
  const width = useCanvasStore((s) => s.leftPanelWidth);
  const activeTab = useCanvasStore((s) => s.leftPanelActiveTab);
  const setCollapsed = useCanvasStore((s) => s.setLeftPanelCollapsed);
  const setWidth = useCanvasStore((s) => s.setLeftPanelWidth);

  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const liveSessions = useSessionStore((s) => s.liveSessions);
  const historySessions = useSessionStore((s) => s.historySessions);
  const loadReplay = useSessionStore((s) => s.loadReplay);
  const openSessions = useCanvasStore((s) => s.openSessionsOverlay);
  const seenTerminalIds = useCompletionSeenStore((s) => s.seenTerminalIds);
  const markCompletionSeen = useCompletionSeenStore((s) => s.markSeen);
  const syncActiveDoneIds = useCompletionSeenStore((s) => s.syncActiveDoneIds);

  const [addingProject, setAddingProject] = useState(false);

  const handleAddProject = useCallback(async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      await promptAndAddProjectToScene(t);
    } finally {
      setAddingProject(false);
    }
  }, [addingProject, t]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, (typeof liveSessions)[number]>();
    for (const session of [...historySessions, ...liveSessions]) {
      map.set(session.sessionId, session);
    }
    return map;
  }, [historySessions, liveSessions]);

  const telemetryByTerminalId = useMemo(() => {
    const map = new Map<
      string,
      (typeof runtimeTerminals)[string]["telemetry"]
    >();
    for (const [terminalId, snapshot] of Object.entries(runtimeTerminals)) {
      map.set(terminalId, snapshot.telemetry);
    }
    return map;
  }, [runtimeTerminals]);

  const projectTreeResult = useMemo(
    () =>
      buildProjectTree(
        projects,
        telemetryByTerminalId,
        sessionsById,
        seenTerminalIds,
      ),
    [projects, telemetryByTerminalId, sessionsById, seenTerminalIds],
  );
  const projectTree = projectTreeResult.projects;
  const stashedItems = projectTreeResult.stashed;
  const hasAnyProjects = projectTree.length > 0;

  useEffect(() => {
    const allTerminals = projectTree.flatMap((pg) =>
      pg.worktrees.flatMap((wt) => wt.terminals),
    );
    const doneIds = allTerminals
      .filter((t) => t.state === "done")
      .map((t) => t.terminalId);
    syncActiveDoneIds(doneIds);
  }, [projectTree, syncActiveDoneIds]);

  // Bug 5: mark seen when the focused terminal in LeftPanel is done.
  useEffect(() => {
    const allTerminals = projectTree.flatMap((pg) =>
      pg.worktrees.flatMap((wt) => wt.terminals),
    );
    const focusedDone = allTerminals.find(
      (t) => t.focused && t.state === "done",
    );
    if (focusedDone) {
      markCompletionSeen(focusedDone.terminalId);
    }
  }, [projectTree, markCompletionSeen]);

  // Scope for the history section — every absolute worktree path on
  // the canvas. Used to filter historical sessions to the current
  // workspace.
  const canvasProjectDirs = useMemo(
    () => projects.flatMap((p) => p.worktrees.map((w) => w.path)),
    [projects],
  );

  const handleOpenReplay = useCallback(
    (filePath: string) => {
      // `openSessionsOverlay` enforces canvas-gap mutual exclusion
      // (file editor + usage get evicted), then the drawer renders
      // whatever `sessionStore.loadReplay` produces.
      openSessions();
      loadReplay(filePath);
    },
    [openSessions, loadReplay],
  );

  /**
   * Keep the focused terminal framed while the panel animates.
   *
   * There is deliberately no branch for "nothing focused". An earlier version
   * offset the viewport by the panel's width to hold the scene still, which was
   * right when the canvas element's own left edge moved and the whole scene
   * really did slide. The canvas is full-bleed now and the panel floats over
   * it, so the scene already holds still — compensating moved it for no reason,
   * and only on this side, because the right panel never had the branch.
   *
   * `preserveScale` is the other half: `flyToBounds` refits the zoom by
   * default, so opening a list silently changed how far in you were zoomed.
   */
  const prevCollapsedRef = useRef(collapsed);
  useEffect(() => {
    if (prevCollapsedRef.current === collapsed) return;
    prevCollapsedRef.current = collapsed;

    const tid = projects
      .flatMap((p) => p.worktrees)
      .flatMap((w) => w.terminals)
      .find((term) => term.focused)?.id;
    if (!tid) return;

    panToTerminal(tid, {
      preserveScale: true,
      duration: PANEL_TRANSITION_DURATION_MS,
      easing: PANEL_TRANSITION_EASING_FN,
    });
  }, [collapsed, projects]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const handle = e.currentTarget as HTMLElement;
      const pid = e.pointerId;
      handle.setPointerCapture(pid);
      const startX = e.clientX;
      const origW = width;
      useSidebarDragStore.getState().setActive(true);
      const handleMove = (ev: PointerEvent) => {
        setWidth(Math.max(200, Math.min(600, origW + (ev.clientX - startX))));
      };
      const cleanup = () => {
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", cleanup);
        handle.removeEventListener("pointercancel", cleanup);
        handle.removeEventListener("lostpointercapture", cleanup);
        try {
          handle.releasePointerCapture(pid);
        } catch {}
        useSidebarDragStore.getState().setActive(false);
        const tid = useProjectStore
          .getState()
          .projects.flatMap((p) => p.worktrees)
          .flatMap((w) => w.terminals)
          .find((term) => term.focused)?.id;
        if (tid) {
          const inZoomFocus =
            useViewportFocusStore.getState().zoomedOutTerminalId === null;
          panToTerminal(tid, {
            immediate: true,
            preserveScale: !inZoomFocus,
          });
        }
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", cleanup);
      handle.addEventListener("pointercancel", cleanup);
      handle.addEventListener("lostpointercapture", cleanup);
    },
    [width, setWidth],
  );

  const dragging = useSidebarDragStore((s) => s.active);
  // Animate the outer width on expand/collapse; pause the transition
  // while the resize handle drags so width tracks the pointer 1:1.
  // The inner surface is conditionally rendered — only one of the
  // two states is ever in the DOM, so there are no persistent
  // compositor layers that can get stuck unpainted after a
  // foreground/background switch.
  // Collapsed is zero, not a strip. The rail to the left of this panel is the
  // handle that reopens it, and a second 32px strip beside the rail would be
  // exactly the edge-crowding the rail moved away from.
  const displayedWidth = collapsed ? 0 : width;
  const widthTransition = dragging ? undefined : PANEL_REVEAL_TRANSITION;

  const renderTerminal = useCallback(
    (item: CanvasTerminalItem) => (
      <TerminalCard
        key={item.terminalId}
        item={item}
        t={t}
        hideLocation
        unseenDone={
          item.state === "done" && !seenTerminalIds.has(item.terminalId)
        }
      />
    ),
    [t, seenTerminalIds],
  );

  return (
    <>
      <PinDrawer />
      {/* Floats beside the rail, over the canvas. Hidden rather than zero-width
          when collapsed: a glass box with a shadow still casts one at 0px. */}
      <div
        className="tc-float fixed z-40 overflow-hidden"
          style={{
          top: TITLE_STRIP_HEIGHT + CHROME_INSET,
          left: CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP,
          bottom: CHROME_INSET,
          width: displayedWidth,
        opacity: collapsed ? 0 : 1,
        pointerEvents: collapsed ? "none" : undefined,
          transition: widthTransition,
        }}
      >
        {/* Laid out at the user-configured width so content does not reflow
            while the outer width animates; the outer overflow-hidden clips it
            during the transition. */}
        <div
          className="absolute inset-y-0 left-0 flex flex-col"
          style={{ width }}
        >
          {/* No tab strip: the rail has a button per surface, and it is the
              only place that says which one you are on. Two ways to switch the
              same two tabs is the duplication the rail already removed once
              when it absorbed this panel's collapsed strip. */}
          <div className="shrink-0 px-2 pt-2 pb-2">
            <div className="flex items-center gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
              <div className="flex-1 min-w-0 truncate px-2 text-[11px] font-semibold text-[var(--text-primary)]">
                {activeTab === "sessions" ? t.left_panel_sessions : t.left_panel_history}
              </div>
              {/* Add-project belongs to Sessions, so it only appears there.
                  While a tab strip sat in this header it could switch you to
                  Sessions on the way; now the header names one surface, and a
                  control that silently moves you to the other one is a lie. */}
              {activeTab === "sessions" && (
                <button
                  className="tc-row-icon flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50 ml-0.5 shrink-0"
                  disabled={addingProject}
                  onClick={() => void handleAddProject()}
                  title={t.shortcut_add_project}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="shrink-0"
                  >
                    <path
                      d="M6 2V10M2 6H10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
              <PanelCollapseButton onCollapse={() => setCollapsed(true)} />
            </div>
          </div>

          <div className="tc-sidebar-tree-font flex-1 min-h-0 overflow-y-auto">
            {activeTab === "sessions" ? (
              <>
                <ProjectTree
                  projects={projectTree}
                  renderTerminal={renderTerminal}
                />
                {!hasAnyProjects && (
                  <div className="tc-label flex-1 px-4 py-6 text-center">
                    {t.sessions_no_canvas_items}
                  </div>
                )}
                <StashedSection items={stashedItems} t={t} />
              </>
            ) : (
              <HistorySection
                projectDirs={canvasProjectDirs}
                onOpen={handleOpenReplay}
                t={t}
                showHeader={false}
              />
            )}
          </div>

          <div
            className="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize group/resize"
            onPointerDown={handleResizeStart}
          >
            <div
              className="absolute right-0 top-0 w-px h-full bg-[var(--border)] group-hover/resize:bg-[var(--accent)] group-hover/resize:opacity-70"
              style={{
                transition:
                  "background-color var(--duration-quick) var(--ease-out-soft), opacity var(--duration-quick) var(--ease-out-soft)",
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
