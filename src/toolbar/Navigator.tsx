import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { chatListFits, CHAT_LIST_WIDTH, useChatDockStore } from "../stores/chatDockStore";
import { CHROME_INSET, LEFT_RAIL_WIDTH, CHROME_GAP } from "../stores/canvasStore";
import { useWindowSize } from "../utils/useWindowSize";
import { usePanelPresence } from "../utils/usePanelPresence";
import { panelContentStyle, PANEL_REVEAL_TRANSITION } from "../utils/panelAnimation";
import { TITLE_STRIP_CSS } from "./titleStripHeight";
import { ChatList } from "./ChatList";

/**
 * The navigator: the workdesk's chats, folders and tasks, as its own panel
 * beside the rail. It floats over the canvas like every panel, so opening or
 * folding it never moves the canvas. The manager's chat docks after it.
 *
 * Where the window is too narrow to dock it (or the manager's chat is full
 * screen), it folds into the rail; the rail's button then opens it over the
 * rest, and it closes again once you pick something.
 */
export function Navigator() {
  const t = useT();
  const listOpen = useChatDockStore((s) => s.listOpen);
  const chatOpen = useChatDockStore((s) => s.open);
  const placement = useChatDockStore((s) => s.placement);
  const overlay = useChatDockStore((s) => s.listOverlay);
  const listWidth = useChatDockStore((s) => s.listWidth);
  const [resizing, setResizing] = useState(false);
  const { width } = useWindowSize();
  const docked = listOpen && chatListFits(width, { open: chatOpen, placement });

  const showOverlay = overlay && !docked;
  const shown = docked || showOverlay;
  const { mounted, revealed } = usePanelPresence(shown);

  // The chat and the canvas or grid beside it make room on the very frame
  // it starts opening (and give it back the frame it starts folding), so
  // all of them move as one.
  const dockedNow = docked && revealed;
  useEffect(() => {
    useChatDockStore.getState().setListShown(dockedNow);
  }, [dockedNow]);
  const ref = useRef<HTMLElement>(null);

  // Over the rest: a click outside, or Escape, folds it back into the rail.
  useEffect(() => {
    if (!showOverlay) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest("[data-nav-toggle]")) return;
      useChatDockStore.getState().setListOverlay(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useChatDockStore.getState().setListOverlay(false);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [showOverlay]);

  if (!mounted) return null;
  return (
    <aside
      ref={ref}
      aria-label={t.chat_list_label}
      className={`tc-float tc-navigator fixed overflow-hidden ${showOverlay ? "z-[96] tc-navigator-over" : "z-[44]"}`}
      style={{
        top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`,
        bottom: CHROME_INSET,
        left: CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP,
        width: revealed ? listWidth : 0,
        opacity: revealed ? 1 : 0,
        pointerEvents: revealed ? undefined : "none",
        // While its edge is dragged it follows the pointer 1:1.
        transition: resizing ? undefined : PANEL_REVEAL_TRANSITION,
        borderRadius: 18,
      }}
      // Over the rest, picking something closes it: the row's own action runs first.
      onClickCapture={(e) => {
        if (!showOverlay) return;
        if ((e.target as HTMLElement).closest("[data-nav-pick]")) {
          requestAnimationFrame(() => useChatDockStore.getState().setListOverlay(false));
        }
      }}
    >
      <div className="absolute inset-y-0 left-0" style={{ width: listWidth, ...panelContentStyle(revealed) }}>
        <ChatList />
      </div>
      {/* Its right edge widens it, for deep file paths; double-click resets it. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.nav_resize}
        title={t.nav_resize}
        className="tc-pane-edge"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          const startWidth = listWidth;
          const store = useChatDockStore.getState();
          setResizing(true);
          store.setResizing(true);
          const move = (ev: PointerEvent) => store.setListWidth(startWidth + ev.clientX - startX);
          const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            setResizing(false);
            store.setResizing(false);
            store.commitListWidth();
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
          target.addEventListener("pointercancel", up);
        }}
        onDoubleClick={() => {
          const store = useChatDockStore.getState();
          store.setListWidth(CHAT_LIST_WIDTH);
          store.commitListWidth();
        }}
      />
    </aside>
  );
}
