import { useEffect } from "react";
import { useT } from "../i18n/useT";
import { useCanvasStore } from "../stores/canvasStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useSessionStore } from "../stores/sessionStore";
import { TasksView } from "../tasks/TasksView";
import { SessionReader } from "../toolbar/SessionReader";
import { PaneAsideButton, PaneFrame } from "./PaneFrame";
import { FolderToolView, folderToolTitle } from "./FolderToolView";
import { parseFolderToolId } from "../actions/folderTools";

/**
 * All tasks, a finished session, or a folder's changes, history or memory, in the pane: beside the panels on the
 * left, over the canvas (which never moves), never inside the manager's
 * chat. One thing at a time: opening a file replaces it, as it replaces a
 * file. In the grid the same things are tabs.
 */
export function CanvasPage() {
  const t = useT();
  const page = useCanvasPageStore((s) => s.page);
  const close = useCanvasPageStore((s) => s.close);
  const filePath = useCanvasStore((s) => s.fileEditorPath);
  const sessionId = useSessionStore((s) => s.replayTimeline?.sessionId ?? null);
  const toolId = useCanvasPageStore((s) => s.toolId);

  // A file opened: it takes the pane.
  useEffect(() => {
    if (filePath) useCanvasPageStore.getState().close();
  }, [filePath]);

  useEffect(() => {
    if (!page) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [page, close]);
  if (!page) return null;
  const title = page === "tasks" ? t.nav_all_tasks : page === "tool" ? folderToolTitle(toolId ? parseFolderToolId(toolId) : null, t) : t.nav_page_session;
  const glowKey = page === "tasks" ? "tasks" : page === "tool" ? `tool:${toolId ?? ""}` : `session:${sessionId ?? ""}`;
  return (
    <PaneFrame label={title} title={title} glowKey={glowKey}>
      {page === "tasks" || page === "tool" ? (
        <>
          <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border)] pl-4 pr-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--text-primary)]">{title}</span>
            <PaneAsideButton />
            <button
              type="button"
              className="tc-sq-ctl inline-flex h-8 w-8 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              onClick={close}
              title={`${t.close} (Esc)`}
              aria-label={t.close}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {page === "tasks" ? <TasksView /> : toolId && <FolderToolView key={toolId} toolId={toolId} />}
          </div>
        </>
      ) : (
        <SessionReader headerExtra={<PaneAsideButton />} />
      )}
    </PaneFrame>
  );
}
