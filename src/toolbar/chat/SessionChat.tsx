import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { findAgentAdapter } from "../../../shared/agent-adapters";
import { useManagerTranscript } from "../../stores/managerChatStore";
import {
  answerChatQuestion,
  answerManagerApproval,
  ensureManagerChat,
  interruptManagerChat,
  sendToManagerChat,
} from "../../actions/managerChatMode";
import { useNotificationStore } from "../../stores/notificationStore";
import { ApprovalCards, ChatThread } from "./ChatThread";
import { QuestionForm } from "./QuestionForm";
import { ComposerSettings } from "./ComposerSettings";
import { LimitCard, PlanCard, QueuedMessages, useQueue, useQueueSender } from "./LongRunning";
import { useManagerChatStore } from "../../stores/managerChatStore";

/**
 * A chat with one session that isn't the manager: a past session continued
 * in chat. The reader shows it live beside the manager's chat, and its node
 * on the canvas shows the same conversation (T6's engine runs it, keyed by
 * the node's terminal id).
 */

export function ChatComposer({
  running,
  placeholder,
  onSend,
  onStop,
  compact = false,
  settings,
}: {
  running: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  compact?: boolean;
  /** The model, effort and mode chips, under the text. */
  settings?: React.ReactNode;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (await onSend(text)) setDraft("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={compact ? "shrink-0 px-2 pb-2" : "shrink-0 px-3 pb-3"}>
      <div className="flex flex-col gap-1.5 rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-3 py-2 focus-within:border-[var(--border-hover)]">
        <label className="min-w-0">
          <span className="sr-only">{placeholder}</span>
          <textarea
            value={draft}
            rows={compact ? 1 : 2}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The canvas listens globally for single-key shortcuts.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            className="block max-h-40 w-full resize-none bg-transparent text-[13px] leading-[1.5] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
          />
        </label>
        <div className="flex items-center gap-2">
        <span className="-ml-2 flex min-w-0 flex-1">{settings}</span>
        {running && (
          <button
            type="button"
            className="tc-rail-btn inline-flex h-8 shrink-0 items-center gap-1.5 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)]"
            onClick={onStop}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            {t.project_chat_stop}
          </button>
        )}
        {(!running || draft.trim()) && (
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--text-secondary)] text-[var(--bg)] disabled:opacity-40"
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
            aria-label={t.project_chat_send}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

/** The conversation, its waiting approvals and the message box. */
export function SessionChatBody({ terminalId, agent, compact = false }: { terminalId: string; agent: string; compact?: boolean }) {
  const t = useT();
  const transcript = useManagerTranscript(terminalId);
  const started = useRef(false);
  // After a restart, or opened from its node: catch up, and start its agent
  // again on the same session if it isn't running.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ensureManagerChat(terminalId);
  }, [terminalId]);
  const agentName = findAgentAdapter(agent)?.displayName ?? agent;
  const queue = useQueue(terminalId);
  const sendNow = async (text: string) => {
    const ok = await sendToManagerChat(terminalId, text);
    if (!ok) useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
    return ok;
  };
  // Written while it works: queued, to go when the turn ends.
  const send = async (text: string) => {
    if (transcript.running || queue.length > 0) {
      useManagerChatStore.getState().enqueue(terminalId, text);
      return true;
    }
    return sendNow(text);
  };
  useQueueSender(terminalId, transcript, sendNow);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatThread
        transcript={transcript}
        agent={agent}
        replyLabel={agentName}
        onSend={async (text) => void (await send(text))}
        onCancel={() => interruptManagerChat(terminalId)}
      />
      {transcript.failure && (
        <div className="mx-3 mb-2 rounded-lg border px-2.5 py-1.5 text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, transparent)", color: "var(--red)" }}>
          {transcript.failure}
        </div>
      )}
      {transcript.questions[0] && (
        <QuestionForm
          key={transcript.questions[0].requestId}
          pending={transcript.questions[0]}
          agentName={agentName}
          onSubmit={(answers) => void answerChatQuestion(terminalId, transcript.questions[0].requestId, answers)}
          onSkip={() => void answerChatQuestion(terminalId, transcript.questions[0].requestId, null)}
        />
      )}
      <ApprovalCards approvals={transcript.approvals} onAnswer={(id, decision) => void answerManagerApproval(terminalId, id, decision)} />
      <PlanCard transcript={transcript} />
      <LimitCard terminalId={terminalId} transcript={transcript} agentName={agentName} />
      <QueuedMessages terminalId={terminalId} onSendNow={(text) => void sendNow(text)} />
      <ChatComposer
        running={transcript.running}
        placeholder={t.reader_message_session}
        onSend={send}
        onStop={() => void interruptManagerChat(terminalId)}
        compact={compact}
        settings={<ComposerSettings terminalId={terminalId} transcript={transcript} />}
      />
    </div>
  );
}
