import { useEffect } from "react";
import { useT } from "../i18n/useT";
import { CHROME_HEIGHT, CHROME_TOP } from "../canvas/floatingChrome";
import { getRightPanelInset } from "../canvas/viewportBounds";
import { useCanvasStore } from "../stores/canvasStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useLeftChromeInset, useLeftChromeShift } from "../stores/chromeLayout";
import { TasksView } from "../tasks/TasksView";
import { SessionReader } from "../toolbar/SessionReader";
import { PANEL_TRANSITION_DURATION_MS, PANEL_TRANSITION_EASING_CSS } from "../utils/panelAnimation";

/**
 * All tasks, or a finished session, as a page over the canvas: it opens
 * after whatever is on the left (the sheet with the list and the manager's
 * chat, a panel, the Hub) and follows that edge, as the file editor does.
 * The sheet itself only ever holds the list and the manager's chat.
 */
export function CanvasPage() {
  const t = useT();
  const page = useCanvasPageStore((s) => s.page);
  const close = useCanvasPageStore((s) => s.close);
  const left = useLeftChromeInset();
  const shift = useLeftChromeShift();
  const rightPanelCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const rightPanelWidth = useCanvasStore((s) => s.rightPanelWidth);
  useEffect(() => {
    if (!page) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [page, close]);
  if (!page) return null;
  const right = getRightPanelInset(rightPanelCollapsed, rightPanelWidth);
  const gap = `calc(100vw - ${left}px - ${right}px)`;
  return (
    <div
      role="dialog"
      aria-label={page === "tasks" ? t.nav_all_tasks : t.nav_page_session}
      className="tc-enter-fade-up tc-float fixed z-50 flex flex-col overflow-hidden"
      style={{
        top: CHROME_TOP,
        left,
        height: CHROME_HEIGHT,
        width: `min(720px, ${gap})`,
        transition: shift ? `left ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}` : undefined,
      }}
    >
      {page === "tasks" ? (
        <>
          <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border)] pl-4 pr-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--text-primary)]">{t.nav_all_tasks}</span>
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
            <TasksView />
          </div>
        </>
      ) : (
        <SessionReader />
      )}
    </div>
  );
}
