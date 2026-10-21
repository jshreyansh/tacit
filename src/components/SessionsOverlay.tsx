import { useEffect } from "react";
import { CHROME_HEIGHT, CHROME_TOP } from "../canvas/floatingChrome";
import { CHROME_GAP, useCanvasStore } from "../stores/canvasStore";
import { leftChromeInset, useLeftChromeInset, useLeftChromeShift } from "../stores/chromeLayout";
import { chatDockOffset, useChatDockStore } from "../stores/chatDockStore";
import { useWindowSize } from "../utils/useWindowSize";
import { readerLeft } from "../toolbar/sessionReaderModel";
import { PANEL_TRANSITION_DURATION_MS, PANEL_TRANSITION_EASING_CSS } from "../utils/panelAnimation";
import {
  getRightPanelInset,
} from "../canvas/viewportBounds";
import { useT } from "../i18n/useT";
import { SessionReader } from "../toolbar/SessionReader";

/*
 * The session reader's drawer, beside the docked chat.
 *
 * The list of past sessions is the manager chat's Sessions view: clicking
 * one calls openSessionsOverlay + loadReplay, and this drawer opens to the
 * right of the left chrome (the chat, and the Files / Diff / Git / Memory
 * panel or the Hub when open) to show it.
 *
 * It used to hide itself below 520px of room, which with the chat widened
 * or a panel open meant a click on a session did nothing visible. The
 * reader now reads down to 360px (its turns fold away, its actions turn
 * into icons), and when even that doesn't fit after the panel it opens over
 * the panel, then over the chat's edge: a session you click always opens.
 *
 * Sits in the same canvas-gap "slot" as Usage and FileEditorDrawer —
 * canvasStore enforces mutual exclusion so opening one closes the
 * others.
 */

export function SessionsOverlay() {
  const open = useCanvasStore((s) => s.sessionsOverlayOpen);
  const close = useCanvasStore((s) => s.closeSessionsOverlay);
  const rightPanelCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const rightPanelWidth = useCanvasStore((s) => s.rightPanelWidth);
  // It opens to the right of the docked chat, and follows its edge while
  // you drag it.
  const chromeLeft = useLeftChromeInset();
  // Where it would start with no side panel open: when there's no room after
  // the panel, it opens over it.
  const chat = useChatDockStore((s) => chatDockOffset(s, CHROME_GAP));
  const afterChat = leftChromeInset({ chat, codePanelCollapsed: true, codePanelWidth: 0, hubOpen: false });
  const { width: viewport } = useWindowSize();
  const leftShift = useLeftChromeShift();
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The reader's turns popover folds first; it handles its own Esc.
      if (e.key === "Escape" && !document.querySelector("[data-reader-popover]")) {
        // The list lives in the chat's Sessions view and stays put.
        // Esc just closes the replay.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;

  const rightInset = getRightPanelInset(rightPanelCollapsed, rightPanelWidth);
  const leftInset = readerLeft({ viewport, afterPanels: chromeLeft, afterChat, right: rightInset });

  return (
    <div
      className="tc-float fixed z-[55] flex flex-col overflow-hidden usage-overlay-enter"
      style={{
        top: CHROME_TOP,
        left: leftInset,
        height: CHROME_HEIGHT,
        width: `calc(100vw - ${leftInset}px - ${rightInset}px)`,
        transition: leftShift ? `${leftShift}, width ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}` : undefined,
      }}
      role="dialog"
      aria-modal="false"
      aria-label={t.sessions_tab}
    >
      {/* The reader draws its own header: the session's name and what you
          can do with it, then close. */}
      <div className="flex-1 min-h-0">
        <SessionReader />
      </div>
    </div>
  );
}
