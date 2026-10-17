import { useT } from "../i18n/useT";
import { useChatDockStore } from "../stores/chatDockStore";
import { ManagerMark } from "../toolbar/ManagerMark";
import { moveManagerToTerminal } from "../actions/managerChatMode";
import { useManagerTranscript } from "../stores/managerChatStore";

/**
 * What a manager's tile shows while the manager runs in the docked chat
 * (T6). The tile stays, since Tacit knows the manager by this terminal; it
 * says where the conversation is and offers to bring it back here.
 */
export function ChatModeBody({ terminalId, agent }: { terminalId: string; agent: string }) {
  const t = useT();
  const openChat = useChatDockStore((s) => s.setOpen);
  const transcript = useManagerTranscript(terminalId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center nopan nodrag">
      <ManagerMark agent={agent} size={34} working={transcript.running} />
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{t.chat_mode_tile_title}</div>
      <div className="max-w-[22rem] text-[12px] leading-relaxed text-[var(--text-muted)]">
        {transcript.running ? t.chat_mode_tile_working : t.chat_mode_tile_body}
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
          onClick={() => void moveManagerToTerminal(terminalId)}
          title={t.chat_mode_open_terminal_hint}
        >
          {t.chat_mode_open_terminal}
        </button>
      </div>
    </div>
  );
}
