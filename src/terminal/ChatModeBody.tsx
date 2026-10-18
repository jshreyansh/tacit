import { useT } from "../i18n/useT";
import { useChatDockStore } from "../stores/chatDockStore";
import { ManagerMark } from "../toolbar/ManagerMark";
import { ensureManagerChat, requestManagerMove } from "../actions/managerChatMode";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { continueChatSessionInTerminal } from "../actions/sessionResume";
import { useEffect } from "react";
import { openLiveChatSession } from "../actions/openSession";
import { ManagerChatHost } from "../toolbar/chat/ManagerChatHost";

/**
 * A tile whose agent runs in chat mode (T6). It starts no process; it says
 * where the conversation is and offers to bring it back here. The
 * manager's is in the docked chat; any other's (a past session continued
 * in chat) opens beside it.
 */
export function ChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const isManager = useCanvasRegistryStore((s) => s.canvases.some((c) => c.workspaceManagerTerminalId === terminalId));
  if (!isManager) return <SessionChatModeBody terminalId={terminalId} agent={agent} />;
  return <ManagerChatModeBody terminalId={terminalId} agent={agent} />;
}

function ManagerChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const t = useT();
  const openChat = useChatDockStore((s) => s.setOpen);
  const onCanvas = useChatDockStore((s) => s.placement === "canvas" && s.open);
  const transcript = useManagerTranscript(terminalId);
  const pendingMove = usePendingManagerMove(terminalId);
  // Placed on the canvas: the chat itself, here in its tile.
  if (onCanvas) return <ManagerChatHost />;
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

/** A past session continued in chat: its chat opens beside the manager's. */
function SessionChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const t = useT();
  const transcript = useManagerTranscript(terminalId);
  // After a restart its agent isn't running: start it again on the same session.
  useEffect(() => {
    void ensureManagerChat(terminalId);
  }, [terminalId]);
  const showChat = () => openLiveChatSession(terminalId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center nopan nodrag">
      <ManagerMark agent={agent} size={34} working={transcript.running} />
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{t.chat_session_tile_title}</div>
      <div className="max-w-[22rem] text-[12px] leading-relaxed text-[var(--text-muted)]">
        {transcript.running ? t.chat_session_tile_working : t.chat_session_tile_body}
      </div>
      <div className="flex gap-2">
        <button type="button" className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-primary)]" onClick={showChat}>
          {t.chat_mode_show_chat}
        </button>
        <button
          type="button"
          className="tc-rail-btn h-8 px-3 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => void continueChatSessionInTerminal(terminalId)}
          title={t.reader_continue_terminal_hint}
        >
          {t.reader_continue_terminal}
        </button>
      </div>
    </div>
  );
}
