import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { CHROME_HEIGHT, CHROME_TOP } from "../canvas/floatingChrome";
import { getRightPanelInset } from "../canvas/viewportBounds";
import { useLeftChromeInset, useLeftChromeShift } from "../stores/chromeLayout";
import { PANE_ASIDE_WIDTH, paneLayout, usePaneStore } from "../stores/paneStore";
import { useWindowSize } from "../utils/useWindowSize";
import { MOTION } from "../utils/motion";

/**
 * The frame every pane uses: it opens after whatever is docked on the left
 * and follows that edge, floats over the canvas (which never moves), and is
 * a panel like them: as wide as you dragged it, narrower only when the window
 * has no room. Its right edge resizes it; double-click resets it. "Canvas ›" in a
 * pane's header slides it aside to a tab; the tab brings it back.
 *
 * `glowKey`: what's in it. When that changes (something new opened in it),
 * a soft afterglow marks it for a moment.
 */
export function PaneFrame({
  label,
  title,
  glowKey,
  wide,
  children,
}: {
  label: string;
  /** Shown on the tab when it's slid aside. */
  title: string;
  glowKey: string;
  /** Opens as wide as there is room for, with a width of its own. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const left = useLeftChromeInset();
  const shift = useLeftChromeShift();
  const { width: windowWidth } = useWindowSize();
  const width = usePaneStore((s) => (wide ? s.wideWidth : s.width));
  const aside = usePaneStore((s) => s.aside);
  const resizing = usePaneStore((s) => s.resizing);
  const room = windowWidth - left - getRightPanelInset();
  const layout = paneLayout(room, width, aside);

  // Something new in it: it comes back from aside, and glows.
  const [glow, setGlow] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    usePaneStore.getState().setAside(false);
    if (first.current) {
      first.current = false;
      return;
    }
    setGlow((n) => n + 1);
  }, [glowKey]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = layout.width;
    const store = usePaneStore.getState();
    store.setResizing(true);
    const move = (ev: PointerEvent) => store.setWidth(Math.min(room, startWidth + ev.clientX - startX), wide);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      store.setResizing(false);
      store.commitWidth();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const transitions = [
    shift ? `left ${MOTION.move.ms}ms ${MOTION.move.ease}` : null,
    resizing ? null : `width ${MOTION.move.ms}ms ${MOTION.move.ease}`,
  ].filter(Boolean);

  if (aside) {
    return (
      <button
        type="button"
        className="tc-pane-enter tc-float fixed z-50 flex flex-col items-center gap-3 pt-3 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        style={{ top: CHROME_TOP, left, height: CHROME_HEIGHT, width: PANE_ASIDE_WIDTH, borderRadius: 14, transition: transitions.join(", ") || undefined }}
        onClick={() => usePaneStore.getState().setAside(false)}
        title={t.pane_bring_back(title)}
        aria-label={t.pane_bring_back(title)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
        <span className="max-h-[70%] overflow-hidden text-ellipsis whitespace-nowrap" style={{ writingMode: "vertical-rl" }}>
          {title}
        </span>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={label}
      className="tc-pane-enter tc-float fixed z-50 flex flex-col overflow-hidden"
      style={{ top: CHROME_TOP, left, height: CHROME_HEIGHT, width: layout.width, transition: transitions.join(", ") || undefined }}
    >
      {children}
      {glow > 0 && <span key={glow} aria-hidden="true" className="tc-afterglow" />}
      {(
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t.pane_resize}
          title={t.pane_resize}
          className="tc-pane-edge"
          onPointerDown={startResize}
          onDoubleClick={() => {
            const store = usePaneStore.getState();
            store.resetWidth(wide);
            store.commitWidth();
          }}
        />
      )}
    </div>
  );
}

/** "Canvas ›": slides the pane aside to a tab so the canvas shows. */
export function PaneAsideButton() {
  const t = useT();
  return (
    <button
      type="button"
      className="tc-sq-ctl inline-flex h-8 shrink-0 items-center gap-1 px-2.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      onClick={() => usePaneStore.getState().setAside(true)}
      title={t.pane_aside_hint}
    >
      {t.pane_aside}
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3.5L10.5 8 6 12.5" />
      </svg>
    </button>
  );
}
