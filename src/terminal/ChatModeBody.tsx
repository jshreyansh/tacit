import { useT } from "../i18n/useT";
import { useChatDockStore } from "../stores/chatDockStore";
import { ManagerMark } from "../toolbar/ManagerMark";
import { requestManagerMove } from "../actions/managerChatMode";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { SessionChatBody } from "../toolbar/chat/SessionChat";

/**
 * A tile whose agent runs in chat mode (T6). The manager's says where its
 * conversation is (the docked chat) and offers to bring it back here; any
 * other, a past session continued in chat, holds the conversation itself.
 */
export function ChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const isManager = useCanvasRegistryStore((s) => s.canvases.some((c) => c.workspaceManagerTerminalId === terminalId));
  if (!isManager) {
    return (
      <div className="flex min-h-0 flex-1 flex-col nopan nodrag nowheel">
        <SessionChatBody terminalId={terminalId} agent={agent} compact />
      </div>
    );
  }
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
