import { useRef, useState } from "react";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { waitForTerminalReady } from "../actions/sceneConnectionActions";
import { useT } from "../i18n/useT";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { useChatDockStore } from "../stores/chatDockStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { flyToBounds } from "../utils/panToTerminal";
import { agentIcon } from "./agentIcons";
import { ConversationBody, useManagerConversation } from "./ProjectChatPanel";

/**
 * An agent running in a terminal, opened from the list beside the chat: its
 * conversation read live from its transcript, and a box that types into its
 * terminal, as the manager's does when it runs in one.
 */
export function TerminalConversation({ terminalId }: { terminalId: string }) {
  const t = useT();
  // Re-read on every project change, so a renamed or closed tile shows here.
  useProjectStore((s) => s.projects);
  const found = findTerminal(terminalId);
  const sessionFile = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.telemetry?.session_file ?? null);
  const conversation = useManagerConversation(terminalId, sessionFile, true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);

  const back = () => useChatDockStore.getState().setFace("chat");

  if (!found) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-[13px] text-[var(--text-muted)]">
        {t.reader_terminal_gone}
        <button type="button" className="tc-rail-btn h-7 border border-[var(--border)] px-3 text-[12px]" onClick={back}>
          {t.back}
        </button>
      </div>
    );
  }
  const { terminal, project, worktree } = found;
  const agent = findAgentAdapter(terminal.type)?.displayName ?? terminal.type;
  const where = worktree.name ? `${project.name} · ${worktree.name}` : project.name;
  const title = terminal.customTitle || terminal.title || agent;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const ready = await waitForTerminalReady(terminalId);
      const ptyId = getLivePtyId(terminalId);
      if (!ready || ptyId == null) {
        useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
        return;
      }
      const result = await window.tacit.managerChat.send(
        { terminalId, ptyId, terminalType: ready.terminal.type, worktreePath: ready.worktree.path },
        text,
      );
      if (result.ok) setDraft("");
      else useNotificationStore.getState().notify("warn", result.detail ?? result.error ?? t.project_chat_send_failed);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--border)] pl-4 pr-2">
        <img src={agentIcon(terminal.type)} alt="" className="h-5 w-5 shrink-0 object-contain" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{title}</span>
          <span className="truncate text-[11px] text-[var(--text-muted)]">{t.reader_worker_meta(agent, where)}</span>
        </span>
        <button
          type="button"
          className="tc-rail-btn h-7 shrink-0 px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => flyToBounds(terminal.x, terminal.y, terminal.width, terminal.height)}
        >
          {t.reader_show_tile}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationBody conversation={conversation} isLive handover={null} />
      </div>
      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className="flex items-end gap-2 rounded-xl border border-[var(--border)] px-3 py-2 focus-within:border-[var(--border-hover)]">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The canvas listens globally for single-key shortcuts.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t.reader_message_agent(agent)}
            aria-label={t.reader_message_agent(agent)}
            className="block max-h-40 min-h-[22px] flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-snug text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <button
            type="button"
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
            aria-label={t.reader_send}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg)] disabled:opacity-30"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
