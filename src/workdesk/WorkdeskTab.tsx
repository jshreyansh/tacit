import { CanvasAskStrip } from "../board/CanvasAskCard";
import { useLayoutEffect, useState } from "react";
import { StartedWithMemory } from "../components/StartedWithMemory";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { NotePage } from "../tasks/NotePage";
import { Undo2 } from "lucide-react";
import { useT } from "../i18n/useT";
import { FolderToolView } from "../components/FolderToolView";
import { borrowTerminalView, fitTerminalRuntime, useTerminalRuntimeStore, useTerminalViewHolder } from "../terminal/terminalRuntimeStore";
import { AgentModeSwitch, PendingSwitchLine, usePendingSwitch } from "../components/AgentModeSwitch";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { hasChatMode } from "../actions/managerChatMode";
import type { BrowserCard, TabCard, TerminalCard } from "./workdeskModel";
import { PastSessionTab } from "../toolbar/SessionReader";
import { TasksView } from "../tasks/TasksView";
import { FileEditorDrawer } from "../components/FileEditorDrawer";
import { SessionChatBody } from "../toolbar/chat/SessionChat";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { useTurnUndo } from "../terminal/useTurnUndo";
import { BypassBadge } from "../terminal/BypassBadge";

/**
 * One node full size in the workdesk view's tabs (T7, G2). A terminal's
 * live view moves in from its tile, to read and type in, and goes back when
 * the tab closes; a browser shows a live picture of its page; a note opens
 * to edit.
 */

type Dict = ReturnType<typeof useT>;

/** The app's own text size: a terminal in a tab reads like the chat beside it. */
const TAB_FONT_SIZE = 13;

const footButton =
  "tc-rail-btn h-7 shrink-0 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]";

/**
 * The tab's top line: the agent's Terminal | Chat (its own, the same as on
 * its canvas tile), and a switch waiting for the turn to end.
 */
function ViewSwitch({ card, busy, t, extra }: { card: TerminalCard; busy: boolean; t: Dict; extra?: React.ReactNode }) {
  const pending = usePendingManagerMove(card.id);
  const openChat = useChatDockStore((s) => s.setOpen);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
      {pending ? (
        <PendingSwitchLine terminalId={card.id} className="min-w-0 flex-1" />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">{card.subtitle}</span>
      )}
      <BypassBadge terminal={card.launch} />
      {extra}
      <AgentModeSwitch
        terminalId={card.id}
        type={card.type}
        chatMode={card.chatMode}
        busy={busy}
        // The manager's chat lives in the panel.
        onPicked={(to) => {
          if (to === "chat" && card.isManager) openChat(true);
        }}
      />
    </div>
  );
}

function TerminalTab({ card, t }: { card: TerminalCard; t: Dict }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [borrowed, setBorrowed] = useState(true);
  const openChat = useChatDockStore((s) => s.setOpen);
  const transcript = useManagerTranscript(card.chatMode ? card.id : null);
  const switchable = hasChatMode(card.type);
  const busy = card.chatMode ? transcript.running : card.state === "active";
  // Undo, as on the tile (T10).
  const turnUndo = useTurnUndo(card.id, card.chatMode);
  const { undoState, unavailable } = turnUndo;
  const undoButton = unavailable ? (
    // Why there's no undo, where the button would be.
    <span className="min-w-0 shrink truncate text-[12px] text-[var(--text-muted)]" title={unavailable.hint}>
      {unavailable.line}
    </span>
  ) : (undoState.kind === "ready" || undoState.kind === "running") && (
    <button
      type="button"
      className={`${footButton} flex items-center gap-1.5 disabled:opacity-40`}
      title={undoState.kind === "running" ? t["turnUndo.buttonRunning"] : undefined}
      disabled={undoState.kind === "running"}
      onClick={turnUndo.undoLast}
    >
      <Undo2 size={12} strokeWidth={1.8} aria-hidden="true" />
      {t["turnUndo.button"]}
    </button>
  );
  // A switch asked for mid-turn happens when the turn ends.
  usePendingSwitch(card.id, card.chatMode, busy);
  // The manager's terminal, shown in the manager panel for now.
  const holder = useTerminalViewHolder(card.chatMode ? null : card.id);
  const [reborrow, setReborrow] = useState(0);

  // A runtime built after the tab opened (a terminal just added), or rebuilt
  // under it, is borrowed again, as the tile re-attaches (TerminalTile).
  const runtimeEpoch = useTerminalRuntimeStore((s) => s.terminals[card.id]?.epoch ?? 0);
  useLayoutEffect(() => {
    if (!container || card.chatMode) return;
    const preferred = usePreferencesStore.getState().terminalFontSize;
    const giveBack = borrowTerminalView(card.id, container, Math.min(preferred, TAB_FONT_SIZE), "tab");
    setBorrowed(giveBack !== null);
    if (!giveBack) return;
    const fit = () => fitTerminalRuntime(card.id);
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => {
      observer.disconnect();
      giveBack();
    };
  }, [container, card.id, card.chatMode, runtimeEpoch, reborrow]);

  return (
    <>
      {switchable ? (
        <ViewSwitch
          card={card}
          busy={busy}
          t={t}
          extra={
            <>
              {!card.chatMode && <StartedWithMemory terminalId={card.id} variant="tile" />}
              {undoButton}
            </>
          }
        />
      ) : (
        (undoButton || findAgentAdapter(card.type)) && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">{card.subtitle}</span>
            <StartedWithMemory terminalId={card.id} variant="tile" />
            {undoButton}
          </div>
        )
      )}
      {turnUndo.dialog}
      {!card.chatMode && <CanvasAskStrip terminalId={card.id} />}
      {card.chatMode ? (
        card.isManager ? (
          // The manager's chat is the docked one.
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="text-[13px] text-[var(--text-primary)]">{t.workdesk_in_chat}</div>
            <button type="button" className={footButton} onClick={() => openChat(true)}>
              {t.chat_mode_show_chat}
            </button>
          </div>
        ) : (
          <div className="mx-auto flex min-h-0 w-full max-w-[780px] flex-1 flex-col">
            <SessionChatBody terminalId={card.id} agent={card.type} />
          </div>
        )
      ) : (
        <div className="relative min-h-0 flex-1 bg-[var(--bg)]">
          <div ref={setContainer} className="absolute inset-0 m-2" />
          {!borrowed && (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--text-muted)]">
              {t.workdesk_terminal_canvas_only}
            </div>
          )}
          {borrowed && holder === "panel" && (
            // Its live terminal is in the manager panel; one place draws it at a time.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg)] text-center">
              <div className="text-[13px] text-[var(--text-primary)]">{t.term_shown_in_panel}</div>
              <button type="button" className={footButton} onClick={() => setReborrow((n) => n + 1)}>
                {t.term_show_here}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The browser itself, usable: its tile is laid over this window at full
 * scale (CanvasCardLayer), address bar and profile included, and clicks
 * pass through to it. The tile never moves in the page, which would reload it.
 */
function BrowserTab({ card, t }: { card: BrowserCard; t: Dict }) {
  const [hole, setHole] = useState<HTMLDivElement | null>(null);
  const setProjection = useWorkdeskViewStore((s) => s.setProjection);
  useLayoutEffect(() => {
    if (!hole) return;
    const publish = () => {
      const box = hole.getBoundingClientRect();
      setProjection({ cardId: card.id, rect: { x: box.left, y: box.top, w: box.width, h: box.height } });
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(hole);
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      setProjection(null);
    };
  }, [hole, card.id, setProjection]);
  return (
    <>
      <div ref={setHole} className="pointer-events-none min-h-0 flex-1" />
    </>
  );
}

export function WorkdeskTab({ card }: { card: TabCard }) {
  const t = useT();
  if (card.kind === "session") return <PastSessionTab key={card.id} filePath={card.id} />;
  if (card.kind === "tasks") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TasksView />
      </div>
    );
  }
  if (card.kind === "tool") {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 flex-col">
        <FolderToolView key={card.id} toolId={card.id} />
      </div>
    );
  }
  if (card.kind === "file") {
    return (
      <FileEditorDrawer
        key={card.id}
        embedded={{
          path: card.id,
          onClose: () => {
            const view = useWorkdeskViewStore.getState();
            view.closeFile(card.id);
            view.setOpenNode(null);
          },
        }}
      />
    );
  }
  if (card.kind === "terminal") return <TerminalTab key={card.id} card={card} t={t} />;
  if (card.kind === "browser") return <BrowserTab key={card.id} card={card} t={t} />;
  return <NotePage key={card.id} id={card.id} />;
}
