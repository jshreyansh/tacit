import { useChatDockStore, chatDockOffset } from "../stores/chatDockStore";
import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import {
  useCanvasStore,
  CHROME_GAP,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
} from "../stores/canvasStore";
import { CODE_TABS, isCodeTab, RIGHT_TAB_CONFIG as TAB_CONFIG } from "./rightPanelTabs";
import { TITLE_STRIP_CSS } from "../toolbar/titleStripHeight";
import { useProjectStore } from "../stores/projectStore";
import { useT } from "../i18n/useT";
import { PanelCollapseButton } from "./PanelCollapseButton";
import { useNotificationStore } from "../stores/notificationStore";
import { FilesContent } from "./RightPanel/FilesContent";
import { DiffContent } from "./RightPanel/DiffContent";
import { GitContent } from "./RightPanel/GitContent";
import { MemoryContent } from "./RightPanel/MemoryContent";
import { panToTerminal } from "../utils/panToTerminal";
import {
  PANEL_REVEAL_TRANSITION,
  PANEL_TRANSITION_DURATION_MS,
  PANEL_TRANSITION_EASING_FN,
} from "../utils/panelAnimation";
import { useSidebarDragStore } from "../stores/sidebarDragStore";
import { useViewportFocusStore } from "../stores/viewportFocusStore";
import type { RightPanelTab } from "../stores/canvasStore";
import {
  resolveRepoContext,
  type RepoContextOption,
} from "./RightPanel/repoContext";
import { openFileInView } from "../actions/openSession";
import { promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { resolvePanelProject } from "./RightPanel/panelProject";
import {
  InstructionsPrompt,
  useInstructionsPromptStore,
} from "./RightPanel/InstructionsPrompt";
import {
  PanelNoProjects,
  PanelProjectChooser,
  PanelProjectHeader,
} from "./RightPanel/ProjectPicker";
import { panelContentStyle, panelTransition } from "../utils/panelAnimation";
import { usePanelPresence } from "../utils/usePanelPresence";

// ── Tab icon SVGs (14×14, matching the minimal aesthetic) ──


export function RightPanel() {
  const t = useT();
  const collapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const width = useCanvasStore((s) => s.rightPanelWidth);
  const activeTab = useCanvasStore((s) => s.rightPanelActiveTab);
  const setCollapsed = useCanvasStore((s) => s.setRightPanelCollapsed);
  const setWidth = useCanvasStore((s) => s.setRightPanelWidth);
  const setActiveTab = useCanvasStore((s) => s.setRightPanelActiveTab);
  const notify = useNotificationStore((s) => s.notify);

  const focusedWorktreeId = useProjectStore((s) => s.focusedWorktreeId);
  const panelWorktreeId = useProjectStore((s) => s.panelWorktreeId);
  const setPanelWorktree = useProjectStore((s) => s.setPanelWorktree);
  const projects = useProjectStore((s) => s.projects);
  const [directoryIsGitRepo, setDirectoryIsGitRepo] = useState(false);
  const [childRepos, setChildRepos] = useState<RepoContextOption[]>([]);
  const [selectedChildRepoPath, setSelectedChildRepoPath] = useState<string | null>(null);
  const [repoContextReadyPath, setRepoContextReadyPath] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const preferredRepoPathRef = useRef<Map<string, string>>(new Map());
  const repoContextCacheRef = useRef<
    Map<
      string,
      {
        childRepos: RepoContextOption[];
        directoryIsGitRepo: boolean;
        selectedRepoPath: string | null;
      }
    >
  >(new Map());
  const repoMenuRef = useRef<HTMLDivElement>(null);

  // When the panel collapses or expands, re-centre the focused
  // terminal in the canvas. Use the same duration / easing as the
  // panel width transition so the viewport pan stays in lockstep
  // with the CSS-animated panel + canvas edges.
  const prevCollapsedRef = useRef(collapsed);
  useEffect(() => {
    if (prevCollapsedRef.current === collapsed) return;
    prevCollapsedRef.current = collapsed;
    const tid = projects
      .flatMap((p) => p.worktrees)
      .flatMap((w) => w.terminals)
      .find((t) => t.focused)?.id;
    if (tid) {
      // preserveScale for the same reason the left panel does it: opening a
      // panel should reframe your focused work, not change your zoom level.
      panToTerminal(tid, {
        preserveScale: true,
        duration: PANEL_TRANSITION_DURATION_MS,
        easing: PANEL_TRANSITION_EASING_FN,
      });
    }
  }, [collapsed, projects]);

  // One project of this workdesk, never a folder left over from another
  // workdesk or from before focus was cleared (see panelProject.ts).
  const panelProject = useMemo(
    () => resolvePanelProject(projects, panelWorktreeId, focusedWorktreeId),
    [projects, panelWorktreeId, focusedWorktreeId],
  );
  const shownProject = panelProject.kind === "project" ? panelProject.project : null;
  const effectiveWorktreePath =
    panelProject.kind === "project" ? panelProject.worktree.path : null;
  const repoScopedTabs = activeTab === "diff" || activeTab === "git" || activeTab === "memory";

  useEffect(() => {
    if (!effectiveWorktreePath || !window.tacit) {
      setDirectoryIsGitRepo(false);
      setChildRepos([]);
      setSelectedChildRepoPath(null);
      setRepoContextReadyPath(null);
      return;
    }

    let cancelled = false;
    const preferredRepoPath =
      preferredRepoPathRef.current.get(effectiveWorktreePath) ?? null;
    const cached = repoContextCacheRef.current.get(effectiveWorktreePath);

    if (cached) {
      setDirectoryIsGitRepo(cached.directoryIsGitRepo);
      setChildRepos(cached.childRepos);
      setSelectedChildRepoPath(cached.selectedRepoPath);
      setRepoContextReadyPath(effectiveWorktreePath);
    } else {
      setDirectoryIsGitRepo(false);
      setChildRepos([]);
      setSelectedChildRepoPath(null);
      setRepoContextReadyPath(null);
    }

    Promise.all([
      window.tacit.git.isRepo(effectiveWorktreePath),
      window.tacit.project.listChildGitRepos(effectiveWorktreePath),
    ])
      .then(([isGitRepo, repos]) => {
        if (cancelled) return;
        setDirectoryIsGitRepo(isGitRepo);
        setChildRepos(repos);

        const resolution = resolveRepoContext({
          childRepos: repos,
          directoryIsGitRepo: isGitRepo,
          directoryPath: effectiveWorktreePath,
          preferredRepoPath,
        });
        setSelectedChildRepoPath(resolution.selectedRepoPath);
        repoContextCacheRef.current.set(effectiveWorktreePath, {
          childRepos: repos,
          directoryIsGitRepo: isGitRepo,
          selectedRepoPath: resolution.selectedRepoPath,
        });
        setRepoContextReadyPath(effectiveWorktreePath);
      })
      .catch(() => {
        if (cancelled) return;
        setDirectoryIsGitRepo(false);
        setChildRepos([]);
        setSelectedChildRepoPath(null);
        repoContextCacheRef.current.set(effectiveWorktreePath, {
          childRepos: [],
          directoryIsGitRepo: false,
          selectedRepoPath: null,
        });
        setRepoContextReadyPath(effectiveWorktreePath);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveWorktreePath]);

  const repoContext = useMemo(
    () =>
      resolveRepoContext({
        childRepos,
        directoryIsGitRepo,
        directoryPath: effectiveWorktreePath,
        preferredRepoPath: selectedChildRepoPath,
      }),
    [childRepos, directoryIsGitRepo, effectiveWorktreePath, selectedChildRepoPath],
  );
  const repoContextPath = repoScopedTabs
    ? repoContext.targetPath
    : effectiveWorktreePath;
  const repoContextResolved =
    !repoScopedTabs ||
    !effectiveWorktreePath ||
    repoContextReadyPath === effectiveWorktreePath;
  const showRepoContextPlaceholder = repoScopedTabs && !repoContextResolved;

  const handleSelectChildRepo = useCallback(
    (repoPath: string) => {
      if (!effectiveWorktreePath) return;
      preferredRepoPathRef.current.set(effectiveWorktreePath, repoPath);
      repoContextCacheRef.current.set(effectiveWorktreePath, {
        childRepos,
        directoryIsGitRepo,
        selectedRepoPath: repoPath,
      });
      setSelectedChildRepoPath(repoPath);
      setRepoMenuOpen(false);
    },
    [childRepos, directoryIsGitRepo, effectiveWorktreePath],
  );

  useEffect(() => {
    if (!repoMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (repoMenuRef.current?.contains(event.target as Node)) return;
      setRepoMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRepoMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [repoMenuOpen]);

  useEffect(() => {
    if (repoContext.selectorKind !== "dropdown") {
      setRepoMenuOpen(false);
    }
  }, [repoContext.selectorKind]);

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
        // The panel opens at the left edge now, so the handle sits on its
        // RIGHT side and drag follows the cursor: right grows, left shrinks.
        // Same direction as the sessions panel, which shares this edge.
        setWidth(Math.max(200, Math.min(600, origW + (ev.clientX - startX))));
      };
      const cleanup = () => {
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", cleanup);
        handle.removeEventListener("pointercancel", cleanup);
        handle.removeEventListener("lostpointercapture", cleanup);
        try { handle.releasePointerCapture(pid); } catch {}
        useSidebarDragStore.getState().setActive(false);
        const tid = useProjectStore.getState().projects
          .flatMap((p) => p.worktrees)
          .flatMap((w) => w.terminals)
          .find((t) => t.focused)?.id;
        if (tid) {
          // Only re-fit the viewport when we're in zoom-focus mode. In plain
          // (panned) focus mode the user has explicitly broken away from
          // fit-scale, so a sidebar resize must not yank them back into a
          // forced zoom.
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
    [width, setWidth]
  );

  const handleFileClick = useCallback(
    (filePath: string) => {
      // Files now open in the full-canvas FileEditorDrawer (Monaco),
      // not a preview tab. Keeps readable width and makes save/edit
      // first-class.
      // In the workdesk view's grid it opens as a tab instead.
      openFileInView(filePath);
    },
    []
  );

  // The Git tab's Hydra button: shows the instructions prompt for this
  // project, even after Not now or Don't ask here.
  const handleEnableHydra = useCallback(() => {
    if (shownProject) useInstructionsPromptStore.getState().request(shownProject.path);
  }, [shownProject]);

  const dragging = useSidebarDragStore((s) => s.active);
  // Animate the outer width on expand/collapse; pause the transition
  // while the resize handle drags so width tracks the pointer 1:1.
  // The inner surface is conditionally rendered — only one of the
  // two states is ever in the DOM, so there are no persistent
  // compositor layers that can get stuck unpainted after a
  // foreground/background switch.
  // Collapsed is zero, not a strip: the rail beside this panel is the handle
  // that reopens it, and a second strip next to the rail is exactly the
  // edge-crowding the rail exists to remove.
  const displayedWidth = collapsed ? 0 : width;
  const chatResizing = useChatDockStore((st) => st.resizing);
  // Unfolds like the others, and slides along when the chat beside it opens or closes.
  const widthTransition = panelTransition(dragging || chatResizing);
  // The contents stay through the fold, so it doesn't close as an empty box.
  const { mounted: contentMounted, revealed: contentRevealed } = usePanelPresence(!collapsed);

  const chatOffset = useChatDockStore((st) => chatDockOffset(st, CHROME_GAP));

  return (
    <>
    <div
      className="tc-float fixed z-40 overflow-hidden"
      style={{
        top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`,
        // Opens beside the LEFT rail, which now owns every panel button.
        // Opens to the right of the docked chat, never under it.
        left: CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + chatOffset,
        bottom: CHROME_INSET,
        width: displayedWidth,
        opacity: collapsed ? 0 : 1,
        pointerEvents: collapsed ? "none" : undefined,
        transition: widthTransition,
      }}
      onDragOver={(e) => {
        if (!collapsed) return;
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setActiveTab("files");
        setCollapsed(false);
      }}
    >
      {/* Both branches stay mounted — toggling display preserves the
          expanded surface's component state (FilesContent's tree model,
          expansion, scroll, ignored stream cache) across panel collapses,
          so re-expanding is instant rather than a fresh load. */}
      <div style={{ display: contentMounted ? "contents" : "none" }}>
        {/* Expanded surface — laid out at the user-configured width so
            content does not reflow while the outer width animates;
            the outer overflow-hidden clips it during the transition. */}
        <div
          className="absolute inset-y-0 left-0 flex flex-col"
          style={{ width, ...panelContentStyle(contentRevealed) }}
        >
      {/* Files, Diff and Git share one rail button, so their tabs sit here;
          Memory has its own button and just its name. */}
      <div className="shrink-0 px-2 pt-2 pb-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--bg)] p-0.5">
          {isCodeTab(activeTab) ? (
            <div role="tablist" aria-label={t.left_panel_code} className="flex min-w-0 flex-1 items-center gap-0.5">
              {CODE_TABS.map(({ id, icon: Icon, labelKey }) => {
                const on = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setActiveTab(id)}
                    className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] transition-colors duration-quick"
                    style={{
                      background: on ? "var(--surface-hover)" : "transparent",
                      color: on ? "var(--text-primary)" : "var(--text-muted)",
                      fontWeight: on ? 600 : 500,
                    }}
                  >
                    <Icon size={13} />
                    <span className="truncate">{t[labelKey]}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 min-w-0 truncate px-2 text-[11px] font-semibold text-[var(--text-primary)]">
              {t[TAB_CONFIG.find((tab) => tab.id === activeTab)?.labelKey ?? "left_panel_files"]}
            </div>
          )}
          <PanelCollapseButton
            onCollapse={() => setCollapsed(true)}
            className="ml-0.5"
          />
        </div>
      </div>

      {panelProject.kind === "project" && (
        <PanelProjectHeader
          project={panelProject.project}
          worktree={panelProject.worktree}
          projects={projects}
          onPick={setPanelWorktree}
        />
      )}

      {panelProject.kind === "project" && (
        <InstructionsPrompt projectPath={panelProject.project.path} projectName={panelProject.project.name} />
      )}

      {panelProject.kind === "choose" && (
        <PanelProjectChooser projects={panelProject.projects} onPick={setPanelWorktree} />
      )}
      {panelProject.kind === "none" && (
        <PanelNoProjects onAddFolder={() => void promptAndAddProjectToScene(t)} />
      )}

      <div
        className="flex-1 min-h-0 flex flex-col"
        style={{ display: panelProject.kind === "project" ? undefined : "none" }}
      >
        {repoScopedTabs && repoContext.selectorKind !== "none" && (
          <div className="shrink-0 px-2 pb-2">
            <div className="rounded-lg bg-[var(--bg)] px-2 py-2">
              <div className="tc-eyebrow tc-mono">
                {t.left_panel_repo}
              </div>
              {repoContext.selectorKind === "single" ? (
                <div
                  className="tc-meta tc-mono mt-2 truncate rounded-md border border-[var(--border)] px-2.5 py-1.5"
                  style={{ color: "var(--text-primary)" }}
                  title={childRepos[0]?.name}
                >
                  {childRepos[0]?.name}
                </div>
              ) : repoContext.selectorKind === "inline" ? (
                <div className="mt-2 flex items-center gap-1 rounded-md bg-[var(--surface)] p-1">
                  {childRepos.map((repo) => {
                    const isActive = repo.path === repoContext.targetPath;
                    return (
                      <button
                        key={repo.path}
                        className={`tc-row-icon tc-meta tc-mono min-w-0 flex-1 rounded-md px-2.5 py-1.5 ${
                          isActive
                            ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        }`}
                        onClick={() => handleSelectChildRepo(repo.path)}
                        title={repo.name}
                      >
                        <span className="block truncate">{repo.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="relative mt-2" ref={repoMenuRef}>
                  <button
                    className="tc-row-icon tc-meta tc-mono flex w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                    style={{ color: "var(--text-primary)" }}
                    onClick={() => setRepoMenuOpen((open) => !open)}
                    aria-label={t.left_panel_repo}
                    aria-haspopup="menu"
                    aria-expanded={repoMenuOpen}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">
                      {childRepos.find((repo) => repo.path === repoContext.targetPath)?.name}
                    </span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className={`shrink-0 text-[var(--text-faint)] ${
                        repoMenuOpen ? "rotate-180" : ""
                      }`}
                      style={{
                        transition:
                          "transform var(--duration-quick) var(--ease-out-soft)",
                      }}
                    >
                      <path
                        d="M2.2 3.5L5 6.3L7.8 3.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {repoMenuOpen && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)] shadow-lg">
                      {childRepos.map((repo) => {
                        const isActive = repo.path === repoContext.targetPath;
                        return (
                          <button
                            key={repo.path}
                            className={`tc-row-icon tc-meta tc-mono flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${
                              isActive
                                ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                                : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                            }`}
                            onClick={() => handleSelectChildRepo(repo.path)}
                            title={repo.name}
                          >
                            <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                            <span
                              className={`shrink-0 text-[10px] ${
                                isActive ? "text-[var(--accent)]" : "text-transparent"
                              }`}
                            >
                              ●
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {/* Always-mounted so the file tree's model state, expansion, scroll
            position and ignored stream survive Git/Diff tab toggles. The
            store-backed watcher keeps this in sync even while hidden, so
            switching back is instant rather than a fresh load. */}
        <div style={{ display: activeTab === "files" ? "contents" : "none" }}>
          <FilesContent
            worktreePath={effectiveWorktreePath}
            onFileClick={handleFileClick}
            active={!collapsed && activeTab === "files"}
          />
        </div>
        {showRepoContextPlaceholder ? (
          <div className="flex flex-1 items-center justify-center">
            <div
              className="h-4 w-4 animate-pulse rounded-full"
              style={{ backgroundColor: "var(--accent)" }}
              title={t.loading}
            />
          </div>
        ) : (
          <>
            {activeTab === "diff" && (
              <DiffContent
                worktreePath={repoContextPath}
                isGitRepo={directoryIsGitRepo || repoContext.selectedRepoPath !== null}
              />
            )}
            {activeTab === "git" && (
              <GitContent
                worktreePath={repoContextPath}
                onEnableHydra={shownProject ? handleEnableHydra : undefined}
              />
            )}
            {activeTab === "memory" && (
              <MemoryContent worktreePath={repoContextPath} onFileClick={handleFileClick} />
            )}
          </>
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
    </div>
    </>
  );
}
