import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { focusInitialDialogTarget, trapDialogTabKey } from "../components/ui/ConfirmDialog";
import { useManagerTranscript } from "../stores/managerChatStore";
import { useT } from "../i18n/useT";
import { useSessionStore } from "../stores/sessionStore";
import { useProjectStore } from "../stores/projectStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useNotificationStore } from "../stores/notificationStore";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { timelineToChatEvents } from "../../shared/chat-history";
import { replayChat } from "../../shared/chat-transcript";
import type { ReplayTimeline } from "../../shared/sessions";
import { panToTerminal } from "../utils/panToTerminal";
import { findTerminal } from "../actions/terminalLookup";
import { loadHiddenSessions, persistHiddenSessions } from "../components/SessionsPanel";
import { agentIcon } from "./agentIcons";
import { ChatThread } from "./chat/ChatThread";
import { SessionChatBody } from "./chat/SessionChat";
import { projectName, stamp } from "./chatHistoryModel";
import {
  READER_TWO_COLUMN_MIN,
  agentOfSessionFile,
  filterTurns,
  messageCount,
  readerLayout,
  readerTitle,
  resumeCommand,
  turnsOf,
} from "./sessionReaderModel";
import {
  closeChatSession,
  continueChatSessionInTerminal,
  continueSessionInChat,
  forkSessionAt,
  resumeSessionInTerminal,
  resumeTargetFor,
  terminalHoldingSession,
} from "../actions/sessionResume";

/**
 * A past session, beside the docked chat: named as its row is, in the
 * chat's own look (folded steps, worker cards, terminals as chips), with
 * its turns to jump through. Continue in chat picks it up as its own chat,
 * a node on the canvas, without touching the manager's seat; Resume in
 * terminal brings it back in the agent's own terminal. Continued, the
 * reader shows that chat live.
 */

type Dict = ReturnType<typeof useT>;

const ID_PREFIX = "r";

const iconButton =
  "tc-rail-btn inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]";

function AgentTile({ agent }: { agent: string }) {
  const icon = agentIcon(agent);
  return (
    <span className="tc-icon-shell shrink-0" style={{ width: 32, height: 32 }}>
      {icon && <img src={icon} alt="" className="h-[18px] w-[18px] object-contain" draggable={false} />}
    </span>
  );
}

function CloseButton({ onClose, t }: { onClose: () => void; t: Dict }) {
  return (
    <button type="button" className={iconButton} onClick={onClose} title={`${t.reader_close} (Esc)`} aria-label={t.reader_close}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}

/** The element's own width, measured before paint so the first frame is laid out right. */
function useOwnWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** The turns column folded away while there was room for it: the viewer's, per browser. */
const TURNS_HIDDEN_KEY = "tacit.reader.turnsHidden.v1";

function loadTurnsHidden(): boolean {
  try {
    return localStorage.getItem(TURNS_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveTurnsHidden(hidden: boolean): void {
  try {
    localStorage.setItem(TURNS_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Storage blocked: it stays folded for this session only.
  }
}

function TurnsGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="3.5" />
      <path d="M9.2 9.2l2.3 2.3M2.5 13.5h5" />
    </svg>
  );
}

/**
 * Closing a session continued in chat asks what you mean: go on in its
 * terminal (the chat view closes, the session keeps going there), or end
 * it (the node closes; it joins the past sessions).
 */
function CloseSessionDialog({ running, onTerminal, onEnd, onCancel, t }: { running: boolean; onTerminal: () => void; onEnd: () => void; onCancel: () => void; t: Dict }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const id = window.setTimeout(() => focusInitialDialogTarget(dialog, null), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      trapDialogTabKey(dialog, e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onCancel]);
  const choice = "tc-rail-btn flex w-full flex-col items-start gap-0.5 border border-[var(--border)] px-3 py-2.5 text-left hover:border-[var(--border-hover)]";
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t.reader_close_title} className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--scrim)]" onClick={onCancel}>
      <div className="tc-float flex w-[400px] max-w-[90vw] flex-col gap-3 p-4" style={{ borderRadius: 14 }} onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-semibold text-[var(--text-primary)]">{t.reader_close_title}</div>
        {running && <div className="text-[12px] text-[var(--amber)]">{t.reader_close_running}</div>}
        <button type="button" className={choice} onClick={onTerminal} autoFocus>
          <span className="text-[13px] text-[var(--text-primary)]">{t.reader_continue_terminal}</span>
          <span className="text-[11.5px] text-[var(--text-muted)]">{t.reader_continue_terminal_hint}</span>
        </button>
        <button type="button" className={`${choice} hover:border-[color-mix(in_srgb,var(--red)_45%,transparent)]`} onClick={onEnd}>
          <span className="text-[13px] text-[var(--red)]">{t.reader_close_fully}</span>
          <span className="text-[11.5px] text-[var(--text-muted)]">{t.reader_close_fully_hint}</span>
        </button>
        <div className="flex justify-end">
          <button type="button" className="tc-rail-btn h-8 px-3 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MoreMenu({ timeline, agent, t, onHidden }: { timeline: ReplayTimeline; agent: "claude" | "codex" | null; t: Dict; onHidden: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => useNotificationStore.getState().notify("info", t.reader_copied));
    setOpen(false);
  };
  const item = "flex w-full items-start gap-2.5 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]";
  return (
    <div ref={ref} className="relative">
      <button type="button" className={iconButton} data-on={open ? "" : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t.reader_more} aria-label={t.reader_more}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={t.reader_more} className="tc-float absolute right-0 top-9 z-10 w-[280px] p-1.5" style={{ borderRadius: 12 }}>
          {agent && (
            <button type="button" role="menuitem" className={item} onClick={() => copy(resumeCommand(agent, timeline.sessionId))}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{t.reader_copy_resume}</span>
                <span className="tc-mono truncate text-[10.5px] text-[var(--text-muted)]">{resumeCommand(agent, timeline.sessionId)}</span>
              </span>
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={() => copy(timeline.sessionId)}>
            {t.reader_copy_id}
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              void window.tacit.fs.reveal(timeline.filePath);
              setOpen(false);
            }}
          >
            {t.reader_show_file}
          </button>
          <div className="mx-1 my-1 h-px bg-[var(--border)]" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              const hidden = loadHiddenSessions();
              hidden.add(timeline.sessionId);
              persistHiddenSessions(hidden);
              window.dispatchEvent(new CustomEvent("tacit:history-hidden"));
              setOpen(false);
              onHidden();
            }}
          >
            <span className="flex flex-col gap-0.5">
              <span>{t.reader_hide}</span>
              <span className="text-[10.5px] text-[var(--text-muted)]">{t.reader_hide_hint}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * `onLive`: read in a tab of the workdesk view. Continuing, resuming or
 * forking it hands the tab to the live agent, and a session already held by
 * a terminal opens that terminal's tab; the tab's own × closes it.
 */
function PastSession({ timeline, onClose, onLive }: { timeline: ReplayTimeline; onClose: () => void; onLive?: (terminalId: string) => void }) {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const managerTerminalId = (canvases.find((c) => c.id === activeCanvasId) ?? canvases[0])?.workspaceManagerTerminalId ?? null;
  const [query, setQuery] = useState("");
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
  // Its turns sit beside the conversation while there's room; narrower, they
  // open over it from the header, and the header's actions become icons.
  const [rootRef, width] = useOwnWidth<HTMLDivElement>();
  const [turnsHidden, setTurnsHidden] = useState(loadTurnsHidden);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const layout = readerLayout(width, turnsHidden);
  const turnsPopoverRef = useRef<HTMLDivElement>(null);
  const turnsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (layout.turnsBeside) setTurnsOpen(false);
  }, [layout.turnsBeside]);
  useEffect(() => {
    if (!turnsOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (turnsPopoverRef.current?.contains(target) || turnsButtonRef.current?.contains(target)) return;
      setTurnsOpen(false);
    };
    // Esc folds the turns before it closes the reader (the drawer's own Esc
    // stands aside while a [data-reader-popover] is open).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setTurnsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [turnsOpen]);
  const foldTurns = (hidden: boolean) => {
    setTurnsHidden(hidden);
    saveTurnsHidden(hidden);
  };

  const agent = agentOfSessionFile(timeline.filePath);
  const agentName = agent ? (findAgentAdapter(agent)?.displayName ?? agent) : "";
  const title = readerTitle(timeline.events);
  const manager = title.kind === "manager";
  const titleText =
    title.kind === "manager"
      ? t.chat_history_manager_session
      : title.kind === "pasted"
        ? t.chat_history_pasted
        : title.kind === "untitled"
          ? t.chat_history_untitled
          : title.text;

  const transcript = useMemo(() => replayChat(timelineToChatEvents(timeline.events, ID_PREFIX)), [timeline]);
  const turns = useMemo(() => turnsOf(timeline.events, ID_PREFIX), [timeline]);
  const shownTurns = useMemo(() => filterTurns(turns, query), [turns, query]);
  const messages = useMemo(() => messageCount(timeline.events), [timeline]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => resumeTargetFor(agent, timeline.sessionId, timeline.projectDir, titleText), [timeline, projects, titleText]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const holding = useMemo(() => terminalHoldingSession(timeline.sessionId), [timeline, projects]);
  const holdingTerminal = holding ? findTerminal(holding)?.terminal : null;

  const meta = [
    agentName,
    projectName(timeline.projectDir),
    `${stamp(timeline.startedAt)} – ${stamp(timeline.endedAt)}`,
    t.chat_history_msgs(messages),
  ]
    .filter(Boolean)
    .join(" · ");

  // In a tab, the tab takes the session's name.
  useEffect(() => {
    if (onLive) useWorkdeskViewStore.getState().nameSession(timeline.filePath, titleText, agent);
  }, [onLive, timeline.filePath, titleText, agent]);

  const jumpTo = (messageId: string) => {
    setActiveTurn(messageId);
    setReveal((r) => ({ id: messageId, seq: (r?.seq ?? 0) + 1 }));
  };

  const primary = `tc-rail-btn inline-flex h-8 shrink-0 items-center justify-center gap-1.5 bg-[var(--text-secondary)] text-[12.5px] text-[var(--bg)] hover:bg-[var(--text-primary)] hover:text-[var(--bg)] disabled:opacity-40 ${layout.compact ? "w-8" : "px-3"}`;
  const secondary = `tc-rail-btn inline-flex h-8 shrink-0 items-center justify-center border border-[var(--border-hover)] text-[12.5px] text-[var(--text-primary)] disabled:opacity-40 ${layout.compact ? "w-8" : "px-3"}`;
  const noTargetHint = target ? undefined : t.reader_no_worktree;

  let actions: React.ReactNode;
  if (holding && holding === managerTerminalId) {
    actions = (
      <button
        type="button"
        className={primary}
        onClick={() => {
          onClose();
          useChatDockStore.getState().showFace("chat");
        }}
      >
        {t.reader_go_to_chat}
      </button>
    );
  } else if (holding && holdingTerminal?.chatMode) {
    actions = (
      <button type="button" className={primary} onClick={() => (onLive ? onLive(holding) : useSessionStore.getState().openLiveChat(holding))}>
        {t.reader_open_chat}
      </button>
    );
  } else if (holding) {
    actions = (
      <button
        type="button"
        className={secondary}
        onClick={() => {
          if (onLive) return onLive(holding);
          onClose();
          panToTerminal(holding);
        }}
      >
        {onLive ? t.reader_open_tab : t.workdesk_show_on_canvas}
      </button>
    );
  } else {
    actions = (
      <>
        <button
          type="button"
          className={primary}
          disabled={!target}
          title={noTargetHint ?? (layout.compact ? t.reader_continue_chat : undefined)}
          aria-label={t.reader_continue_chat}
          onClick={() => target && void continueSessionInChat(target, onLive)}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 5l12 7-12 7z" />
          </svg>
          {!layout.compact && t.reader_continue_chat}
        </button>
        <button
          type="button"
          className={secondary}
          disabled={!target}
          title={noTargetHint ?? (layout.compact ? t.reader_resume_terminal : undefined)}
          aria-label={t.reader_resume_terminal}
          onClick={() => target && resumeSessionInTerminal(target, t.reader_resumed_toast(agentName), onLive)}
        >
          {layout.compact ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5" />
            </svg>
          ) : (
            t.reader_resume_terminal
          )}
        </button>
      </>
    );
  }

  const canAsk = managerTerminalId !== null && holding !== managerTerminalId;

  const turnsPane = (
    <>
      <label className="m-2.5 flex h-[30px] shrink-0 items-center gap-2 rounded-[8px] border border-[var(--border)] px-2 text-[var(--text-muted)] focus-within:border-[var(--border-hover)]">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M13.5 13.5l-3.2-3.2" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={t.reader_find}
          aria-label={t.reader_find}
          autoFocus={turnsOpen}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
        />
      </label>
      <div className="flex shrink-0 items-center justify-between px-3 pb-1.5">
        <span className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{t.reader_turns(turns.length)}</span>
        {layout.turnsBeside && (
          <button
            type="button"
            className="tc-rail-btn inline-flex h-5 w-5 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => foldTurns(true)}
            title={t.reader_turns_hide}
            aria-label={t.reader_turns_hide}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3.5L5.5 8l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2.5">
        {shownTurns.map((turn) => (
          <div key={turn.messageId} className="group relative">
            <button
              type="button"
              className="tc-rail-btn flex w-full items-start gap-2 px-2 py-1.5 pr-8 text-left"
              data-on={activeTurn === turn.messageId ? "" : undefined}
              onClick={() => {
                jumpTo(turn.messageId);
                setTurnsOpen(false);
              }}
              title={turn.text || t.reader_briefing}
            >
              <span className="tc-mono shrink-0 pt-px text-[10.5px] tabular-nums text-[var(--text-muted)]">{stamp(turn.at)}</span>
              <span className={`line-clamp-2 text-[12px] leading-snug ${turn.briefing ? "italic text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}`}>
                {turn.briefing ? t.reader_briefing : turn.text}
              </span>
            </button>
            {target && !turn.briefing && (
              <button
                type="button"
                className="tc-rail-btn absolute right-1 top-1 hidden h-6 w-6 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] group-hover:inline-flex"
                onClick={() => void forkSessionAt(target, timeline.filePath, turn.promptIndex, t.reader_forked_toast, onLive)}
                title={t.reader_fork}
                aria-label={t.reader_fork}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="4.5" cy="3.5" r="1.5" />
                  <circle cx="4.5" cy="12.5" r="1.5" />
                  <circle cx="11.5" cy="5.5" r="1.5" />
                  <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div className={`flex shrink-0 items-center border-b border-[var(--border)] py-3 pr-3 ${layout.compact ? "gap-2 pl-3" : "gap-3 pl-4"}`}>
        {agent && !layout.compact && <AgentTile agent={agent} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]" title={titleText}>
              {titleText}
            </span>
            {manager && (
              <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 text-[10.5px] text-[var(--text-muted)]">{t.chat_history_badge_manager}</span>
            )}
          </span>
          <span className="truncate text-[11.5px] text-[var(--text-muted)]">{meta}</span>
        </div>
        {actions}
        {!layout.turnsBeside && (
          <button
            ref={turnsButtonRef}
            type="button"
            className={iconButton}
            data-on={turnsOpen ? "" : undefined}
            aria-expanded={turnsOpen}
            onClick={() => {
              // With room for the column, this brings it back; without, it
              // opens the turns over the conversation.
              if (width >= READER_TWO_COLUMN_MIN) foldTurns(false);
              else setTurnsOpen((v) => !v);
            }}
            title={t.reader_turns_show}
            aria-label={t.reader_turns_show}
          >
            <TurnsGlyph />
          </button>
        )}
        <MoreMenu timeline={timeline} agent={agent} t={t} onHidden={onClose} />
        {!onLive && <CloseButton onClose={onClose} t={t} />}
      </div>

      <div className="relative flex min-h-0 flex-1">
        {layout.turnsBeside && (
          <nav className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)]" aria-label={t.reader_turns(turns.length)}>
            {turnsPane}
          </nav>
        )}
        {!layout.turnsBeside && turnsOpen && (
          <nav
            ref={turnsPopoverRef}
            data-reader-popover=""
            className="tc-float absolute right-2 top-2 z-10 flex max-h-[70%] w-[min(320px,calc(100%-16px))] flex-col"
            style={{ borderRadius: 12 }}
            aria-label={t.reader_turns(turns.length)}
          >
            {turnsPane}
          </nav>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col">
            <ChatThread
              transcript={transcript}
              agent={agent ?? "claude"}
              replyLabel={manager ? t.chat_from_manager(agentName.split(" ")[0]) : agentName}
              reveal={reveal}
              onSend={async () => {}}
              onCancel={async () => {}}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 text-[12px] text-[var(--text-muted)]">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
            </svg>
            <span className="min-w-0 flex-1 truncate">{t.reader_read_only(stamp(timeline.endedAt))}</span>
            {canAsk && (
              <button
                type="button"
                className="tc-rail-btn h-7 shrink-0 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                onClick={() => useChatDockStore.getState().insertIntoDraft(t.reader_ask_text(titleText, agentName, stamp(timeline.endedAt), timeline.filePath))}
              >
                {t.reader_ask_manager}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A past session continued in chat, live: the same panel, now with a message box. */
function LiveSession({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const t = useT();
  useProjectStore((s) => s.projects);
  const transcript = useManagerTranscript(terminalId);
  const [asking, setAsking] = useState(false);
  const [rootRef, width] = useOwnWidth<HTMLDivElement>();
  const { compact } = readerLayout(width, true);
  const found = findTerminal(terminalId);
  if (!found) {
    return <div className="flex h-full items-center justify-center px-8 text-center text-[12.5px] text-[var(--text-muted)]">{t.reader_live_gone}</div>;
  }
  const { terminal } = found;
  const agentName = findAgentAdapter(terminal.type)?.displayName ?? terminal.type;
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div className={`flex shrink-0 items-center border-b border-[var(--border)] py-3 pr-3 ${compact ? "gap-2 pl-3" : "gap-3 pl-4"}`}>
        {!compact && <AgentTile agent={terminal.type} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">{terminal.customTitle?.trim() || terminal.title}</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--green)]">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
            {t.reader_live(agentName)}
          </span>
        </div>
        <button
          type="button"
          className={`tc-rail-btn inline-flex h-8 shrink-0 items-center justify-center gap-1.5 border border-[var(--border-hover)] text-[12.5px] text-[var(--text-primary)] ${compact ? "w-8" : "px-3"}`}
          onClick={() => void continueChatSessionInTerminal(terminalId)}
          title={compact ? `${t.reader_continue_terminal}: ${t.reader_continue_terminal_hint}` : t.reader_continue_terminal_hint}
          aria-label={t.reader_continue_terminal}
        >
          {compact ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5" />
            </svg>
          ) : (
            t.reader_continue_terminal
          )}
        </button>
        <button type="button" className={iconButton} onClick={() => panToTerminal(terminalId)} title={t.workdesk_show_on_canvas} aria-label={t.workdesk_show_on_canvas}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" />
          </svg>
        </button>
        <CloseButton onClose={() => setAsking(true)} t={t} />
      </div>
      {asking && (
        <CloseSessionDialog
          running={transcript.running}
          onTerminal={() => {
            setAsking(false);
            void continueChatSessionInTerminal(terminalId);
          }}
          onEnd={() => {
            setAsking(false);
            closeChatSession(terminalId);
          }}
          onCancel={() => setAsking(false)}
          t={t}
        />
      )}
      <div className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col">
        <SessionChatBody terminalId={terminalId} agent={terminal.type} />
      </div>
    </div>
  );
}

/** A past session in a tab of the workdesk view: read, then continued right there. */
export function PastSessionTab({ filePath }: { filePath: string }) {
  const t = useT();
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    setError(null);
    window.tacit.sessions
      .loadReplay(filePath)
      .then((loaded) => !cancelled && setTimeline(loaded))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  const view = useWorkdeskViewStore.getState();
  if (!timeline) {
    return <div className="flex flex-1 items-center justify-center px-8 text-center text-[12.5px] text-[var(--text-muted)]">{error ?? t.reader_loading}</div>;
  }
  return (
    <PastSession
      timeline={timeline}
      onClose={() => {
        view.closeSession(filePath);
        view.setOpenNode(null);
      }}
      onLive={(terminalId) => useWorkdeskViewStore.getState().sessionWentLive(filePath, terminalId)}
    />
  );
}

export function SessionReader() {
  const t = useT();
  const timeline = useSessionStore((s) => s.replayTimeline);
  const replayError = useSessionStore((s) => s.replayError);
  const liveChatTerminalId = useSessionStore((s) => s.liveChatTerminalId);
  const loading = useSessionStore((s) => s.panelView === "replay");
  const closeOverlay = useCanvasStore((s) => s.closeSessionsOverlay);
  const close = () => {
    useSessionStore.getState().exitReplay();
    closeOverlay();
  };

  if (liveChatTerminalId) {
    return <LiveSession terminalId={liveChatTerminalId} onClose={close} />;
  }
  if (timeline) {
    return <PastSession timeline={timeline} onClose={close} />;
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 justify-end border-b border-[var(--border)] px-3 py-3">
        <CloseButton onClose={close} t={t} />
      </div>
      <div className="flex flex-1 items-center justify-center px-8 text-center text-[12.5px] text-[var(--text-muted)]">
        {replayError ?? (loading ? t.reader_loading : t.reader_pick)}
      </div>
    </div>
  );
}
