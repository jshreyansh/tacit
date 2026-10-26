import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { findAgentAdapter } from "../../../shared/agent-adapters";
import { useManagerTranscript } from "../../stores/managerChatStore";
import {
  answerChatQuestion,
  answerManagerApproval,
  configureChat,
  ensureManagerChat,
  interruptManagerChat,
  sendToManagerChat,
} from "../../actions/managerChatMode";
import { useNotificationStore } from "../../stores/notificationStore";
import { ApprovalCards, ChatThread } from "./ChatThread";
import { QuestionForm } from "./QuestionForm";
import { ComposerSettings } from "./ComposerSettings";
import { LimitCard, PlanCard, QueuedMessages, UsageMeter, useQueue, useQueueSender } from "./LongRunning";
import { ComposerBox, useAttachments } from "./Composer";
import type { ChatAttachmentInfo } from "../../../shared/chat-events";

const notifyFailure = (error: unknown) => useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error));
import { useManagerChatStore } from "../../stores/managerChatStore";

/**
 * A chat with one session that isn't the manager: a past session continued
 * in chat. The reader shows it live beside the manager's chat, and its node
 * on the canvas shows the same conversation (T6's engine runs it, keyed by
 * the node's terminal id).
 */

export function ChatComposer({
  terminalId,
  running,
  placeholder,
  onSend,
  onStop,
  compact = false,
  settings,
  meter,
}: {
  terminalId: string;
  running: boolean;
  placeholder: string;
  onSend: (text: string, attachments: ChatAttachmentInfo[]) => Promise<boolean>;
  onStop: () => void;
  compact?: boolean;
  /** The model, effort and mode chips, under the text. */
  settings?: React.ReactNode;
  /** The usage ring, beside send. */
  meter?: React.ReactNode;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments(terminalId);
  const ready = (draft.trim() || attachments.items.length > 0) && !attachments.busy;
  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    try {
      if (await onSend(draft.trim(), attachments.items)) {
        setDraft("");
        attachments.clear();
      }
    } catch (error) {
      useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={compact ? "shrink-0 px-2 pb-2" : "shrink-0 px-3 pb-3"}>
      <ComposerBox
        value={draft}
        onChange={setDraft}
        onSubmit={() => void send()}
        placeholder={placeholder}
        rows={compact ? 1 : 2}
        attachments={attachments}
        settings={settings}
        meter={meter}
        compact={compact}
        canSend={!!ready && !sending}
        showSend={!running || !!ready}
        trailing={
          running ? (
            <button
              type="button"
              className="tc-rail-btn ml-1 inline-flex h-8 shrink-0 items-center gap-1.5 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)]"
              onClick={onStop}
              title={t.project_chat_stop}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              <span className="@max-[300px]:hidden">{t.project_chat_stop}</span>
            </button>
          ) : null
        }
      />
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
  const sendNow = async (text: string, attachments: ChatAttachmentInfo[] = []) => {
    const ok = await sendToManagerChat(terminalId, text, attachments);
    if (!ok) useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
    return ok;
  };
  // Written while it works: queued, to go when the turn ends.
  const send = async (text: string, attachments: ChatAttachmentInfo[] = []) => {
    if (transcript.running || queue.length > 0) {
      useManagerChatStore.getState().enqueue(terminalId, text, attachments);
      return true;
    }
    return sendNow(text, attachments);
  };
  useQueueSender(terminalId, transcript, sendNow);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatThread
        transcript={transcript}
        agent={agent}
        replyLabel={agentName}
        emptyText={t.chat_session_empty(agentName)}
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
      <ApprovalCards
        approvals={transcript.approvals}
        onAnswer={(id, decision, note) => void answerManagerApproval(terminalId, id, decision, note)}
        onPlanMode={(mode) => void configureChat(terminalId, { mode })}
        agent={agent}
      />
      <PlanCard transcript={transcript} />
      <LimitCard terminalId={terminalId} transcript={transcript} agentName={agentName} />
      <QueuedMessages terminalId={terminalId} onSendNow={(text, attachments) => void sendNow(text, attachments).catch(notifyFailure)} />
      <ChatComposer
        terminalId={terminalId}
        running={transcript.running}
        placeholder={t.reader_message_session}
        onSend={send}
        onStop={() => void interruptManagerChat(terminalId)}
        compact={compact}
        settings={<ComposerSettings terminalId={terminalId} transcript={transcript} />}
        meter={<UsageMeter transcript={transcript} agent={agent} />}
      />
    </div>
  );
}
