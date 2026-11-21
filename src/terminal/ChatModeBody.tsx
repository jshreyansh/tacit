import { useT } from "../i18n/useT";
import { useChatDockStore } from "../stores/chatDockStore";
import { ManagerMark } from "../toolbar/ManagerMark";
import { ensureManagerChat, requestManagerMove } from "../actions/managerChatMode";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useEffect, useRef } from "react";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { useCanvasStore } from "../stores/canvasStore";
import { FOCUS_CHAT_TILE_EVENT, takeChatTileFocus } from "../actions/chatTileFocus";
import { SessionChatBody } from "../toolbar/chat/SessionChat";

/**
 * A tile whose agent runs in chat mode (T6). It starts no process. The
 * manager's conversation is in the docked chat, so its tile says so; any
 * other's (a past session continued in chat) is the chat itself.
 */
export function ChatModeBody({ terminalId, agent, title = "", place = "" }: { terminalId: string; agent: string; title?: string; place?: string }) {
  const isManager = useCanvasRegistryStore((s) => s.canvases.some((c) => c.workspaceManagerTerminalId === terminalId));
  if (!isManager) return <SessionChatModeBody terminalId={terminalId} agent={agent} title={title} place={place} />;
  return <ManagerChatModeBody terminalId={terminalId} agent={agent} />;
}

function ManagerChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const t = useT();
  const openChat = useChatDockStore((s) => s.setOpen);
  const transcript = useManagerTranscript(terminalId);
  const pendingMove = usePendingManagerMove(terminalId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center nopan nodrag">
      <ManagerMark agent={agent} size={34} working={transcript.running} />
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{t.chat_mode_tile_title}</div>
      <div className="max-w-[22rem] text-[12px] leading-relaxed text-[var(--text-muted)]">
        {pendingMove === "terminal" ? t.chat_move_pending_terminal : transcript.running ? t.chat_mode_tile_working : t.chat_mode_tile_body}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-primary)]"
          onClick={() => openChat(true)}
        >
          {t.chat_mode_show_chat}
        </button>
        <button
          type="button"
          className="tc-rail-btn h-8 px-3 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => requestManagerMove(terminalId, "terminal", transcript.running)}
          disabled={pendingMove === "terminal"}
          title={t.chat_mode_open_terminal_hint}
        >
          {t.chat_mode_open_terminal}
        </button>
      </div>
    </div>
  );
}

/** Below this zoom a chat's words are too small to read: the tile shows a summary instead. */
const FAR_SCALE = 0.5;

/**
 * A past session continued in chat: the tile is the chat. Its conversation,
 * questions, approvals and message box live here, so the panel stays the
 * manager's. Zoomed far out it shows its state and title in big type; the
 * chat stays mounted underneath, so a draft survives zooming.
 */
function SessionChatModeBody({ terminalId, agent, title, place }: { terminalId: string; agent: string; title: string; place: string }) {
  const t = useT();
  const transcript = useManagerTranscript(terminalId);
  const scale = useCanvasStore((s) => s.viewport.scale);
  const rootRef = useRef<HTMLDivElement>(null);
  // After a restart its agent isn't running: start it again on the same session.
  useEffect(() => {
    void ensureManagerChat(terminalId);
  }, [terminalId]);
  // Flown to from the list, search or Continue: the cursor goes in the box.
  useEffect(() => {
    const focus = () => requestAnimationFrame(() => rootRef.current?.querySelector("textarea")?.focus({ preventScroll: true }));
    if (takeChatTileFocus(terminalId)) focus();
    const onRequest = (e: Event) => {
      if ((e as CustomEvent<string>).detail === terminalId && takeChatTileFocus(terminalId)) focus();
    };
    window.addEventListener(FOCUS_CHAT_TILE_EVENT, onRequest);
    return () => window.removeEventListener(FOCUS_CHAT_TILE_EVENT, onRequest);
  }, [terminalId]);

  const far = scale < FAR_SCALE;
  const needsYou = transcript.approvals.length > 0 || transcript.questions.length > 0;
  const agentName = findAgentAdapter(agent)?.displayName ?? agent;
  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col nopan nodrag nowheel cursor-auto">
      <div className={`flex min-h-0 flex-1 flex-col pt-1 ${far ? "invisible" : ""}`} aria-hidden={far || undefined}>
        <SessionChatBody terminalId={terminalId} agent={agent} compact />
      </div>
      {far && (
        <div className="absolute inset-0 flex flex-col gap-[0.5em] overflow-hidden p-[0.8em]" style={{ fontSize: Math.min(44, 14 / Math.max(scale, 0.05)) }}>
          <span
            className="inline-flex w-fit items-center gap-[0.35em] rounded-full px-[0.55em] py-[0.15em] text-[0.7em] font-medium"
            style={
              needsYou
                ? { background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }
                : transcript.running
                  ? { background: "color-mix(in srgb, var(--green) 14%, transparent)", color: "var(--green)" }
                  : { background: "color-mix(in srgb, var(--text-primary) 7%, transparent)", color: "var(--text-muted)" }
            }
          >
            <span aria-hidden="true" className="h-[0.4em] w-[0.4em] rounded-full bg-current" />
            {needsYou ? t.nav_needs_you_word : transcript.running ? t.chat_working : t.chat_tile_idle}
          </span>
          <span className="line-clamp-3 font-semibold leading-tight text-[var(--text-primary)]">{title}</span>
          <span className="truncate text-[0.7em] text-[var(--text-muted)]">{[place, agentName].filter(Boolean).join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
