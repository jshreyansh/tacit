import { useEffect } from "react";
import { cancelManagerMove, hasChatMode, moveManagerNow, requestManagerMove, runPendingMove } from "../actions/managerChatMode";
import { useT } from "../i18n/useT";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";

/**
 * Terminal or Chat, for an agent that has both (Claude, Codex, OpenCode).
 * It's the agent's own: switched on its canvas tile, its Grid tab or the
 * manager panel, it's switched in all of them, and it stays switched when
 * the workdesk goes from Canvas to Grid. Switching starts the agent again
 * the other way on the same conversation, so mid-turn it waits for the
 * turn to end (with Switch now and Cancel).
 */

/** Whether the agent is in the middle of a turn, the way it runs now. */
export function useAgentBusy(terminalId: string, chatMode: boolean): boolean {
  const transcript = useManagerTranscript(chatMode ? terminalId : null);
  const inTurn = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.telemetry?.turn_state === "in_turn");
  return chatMode ? transcript.running : inTurn;
}

/**
 * Carries out a switch that waits for the turn to end. Every place showing
 * the agent runs it; the switch happens once.
 */
export function usePendingSwitch(terminalId: string, chatMode: boolean, busy: boolean): "terminal" | "chat" | null {
  const pending = usePendingManagerMove(terminalId);
  useEffect(() => {
    if (pending) runPendingMove(terminalId, busy, chatMode);
  }, [pending, busy, chatMode, terminalId]);
  return pending;
}

/**
 * Picking Terminal or Chat for an agent: switches it (now, or when its turn
 * ends), or picking where it already is calls off a waiting switch.
 */
export function pickAgentMode(terminalId: string, to: "terminal" | "chat", chatMode: boolean, busy: boolean, pending: "terminal" | "chat" | null): boolean {
  if ((to === "chat") === chatMode) {
    if (pending) cancelManagerMove(terminalId);
    return false;
  }
  requestManagerMove(terminalId, to, busy);
  return true;
}

function TerminalGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6.5 6.5 8.25 4.5 10M8.5 10h3" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.25a1.75 1.75 0 0 1 1.75-1.75h7.5a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75H7l-3 2.5V11h.25A1.75 1.75 0 0 1 2.5 9.25z" />
    </svg>
  );
}

/**
 * The switch. `size="tile"` is the canvas tile's (small, kept off the
 * tile's drag); `size="bar"` is the Grid tab's and the manager panel's.
 */
export function AgentModeSwitch({
  terminalId,
  type,
  chatMode,
  busy,
  size = "bar",
  onPicked,
}: {
  terminalId: string;
  type: string;
  chatMode: boolean;
  busy: boolean;
  size?: "tile" | "bar";
  onPicked?: (to: "terminal" | "chat") => void;
}) {
  const t = useT();
  const pending = usePendingManagerMove(terminalId);
  if (!hasChatMode(type)) return null;
  const pick = (to: "terminal" | "chat") => {
    if (pickAgentMode(terminalId, to, chatMode, busy, pending)) onPicked?.(to);
  };
  const tile = size === "tile";
  const segment = (to: "terminal" | "chat") => {
    const on = (to === "chat") === chatMode;
    const waiting = pending === to;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={on}
        title={to === "chat" ? t.agent_mode_chat_hint : t.agent_mode_terminal_hint}
        className={`inline-flex items-center gap-1 rounded-[5px] transition-colors duration-quick ${tile ? "h-[18px] px-1.5 text-[10.5px]" : "h-6 px-2.5 text-[12px]"}`}
        style={{
          background: on ? "var(--surface-hover)" : "transparent",
          color: on ? "var(--text-primary)" : waiting ? "var(--cyan)" : "var(--text-muted)",
          fontWeight: on ? 600 : 500,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          pick(to);
        }}
      >
        {to === "chat" ? <ChatGlyph /> : <TerminalGlyph />}
        {to === "chat" ? t.workdesk_view_chat : t.workdesk_view_terminal}
      </button>
    );
  };
  return (
    <div
      role="tablist"
      aria-label={t.workdesk_view_as}
      className={`${tile ? "nodrag h-6 rounded-md p-[2px]" : "rounded-[8px] p-0.5"} flex shrink-0 items-center gap-0.5 border border-[var(--border)]`}
      style={{ cornerShape: "round" } as React.CSSProperties}
    >
      {segment("terminal")}
      {segment("chat")}
    </div>
  );
}

/** "Switches to the chat when this turn ends · Switch now · Cancel". */
export function PendingSwitchLine({ terminalId, className }: { terminalId: string; className?: string }) {
  const t = useT();
  const pending = usePendingManagerMove(terminalId);
  if (!pending) return null;
  const button =
    "nodrag tc-rail-btn h-6 shrink-0 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]";
  return (
    <div className={`flex items-center gap-2 text-[11.5px] ${className ?? ""}`}>
      <span className="tc-live-pip inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--cyan)" }} />
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{pending === "terminal" ? t.chat_move_pending_terminal : t.chat_move_pending_chat}</span>
      <button
        type="button"
        className={button}
        title={t.chat_move_now_hint}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          moveManagerNow(terminalId);
        }}
      >
        {t.chat_move_now}
      </button>
      <button
        type="button"
        className={button}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          cancelManagerMove(terminalId);
        }}
      >
        {t.cancel}
      </button>
    </div>
  );
}
