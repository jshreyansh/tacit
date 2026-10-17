import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import type { ChatTranscript } from "../../../shared/chat-transcript";
import type { PlanStep } from "../../../shared/chat-events";
import { useManagerChatStore, type QueuedMessage } from "../../stores/managerChatStore";
import { contextPercent, formatTokens, lastOutcome, resetLabel, shouldSendQueued } from "./longRunningModel";

/**
 * A chat that runs long (Phase L): messages written while the agent works
 * wait in a queue and go one at a time as each turn ends (any can go now,
 * to steer the running turn); the header says how full the context is;
 * the agent's plan sits above the message box; and when the account runs
 * out of usage, a card says when it comes back and what else you can do.
 */

type Dict = ReturnType<typeof useT>;

const EMPTY: QueuedMessage[] = [];

export function useQueue(terminalId: string | null): QueuedMessage[] {
  return useManagerChatStore((s) => (terminalId ? s.queues[terminalId] : undefined) ?? EMPTY);
}

/**
 * Sends the queue: the first message when the agent is free again, and the
 * rest as each turn ends. A message that can't be sent goes back first in
 * line.
 */
export function useQueueSender(terminalId: string | null, transcript: ChatTranscript, send: (text: string) => Promise<boolean>): void {
  const queue = useQueue(terminalId);
  const waitUntil = useManagerChatStore((s) => (terminalId ? s.waitUntil[terminalId] : undefined) ?? null);
  const awaiting = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // Waiting out a usage limit: wake when it lifts.
  useEffect(() => {
    if (!waitUntil) return;
    const ms = Date.parse(waitUntil) - Date.now();
    if (ms <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(ms + 1000, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [waitUntil]);

  useEffect(() => {
    if (transcript.running) awaiting.current = false;
  }, [transcript.running]);

  useEffect(() => {
    if (!terminalId || awaiting.current) return;
    const ready = shouldSendQueued({
      running: transcript.running,
      queued: queue.length,
      failure: transcript.failure !== null,
      outcome: lastOutcome(transcript),
      limited: transcript.limit?.status === "limited",
      waitUntil,
      now: Math.max(now, Date.now()),
    });
    if (!ready) return;
    const [next] = queue;
    const store = useManagerChatStore.getState();
    store.removeQueued(terminalId, next.id);
    if (waitUntil) store.setWaitUntil(terminalId, null);
    awaiting.current = true;
    void send(next.text).then((ok) => {
      if (ok) return;
      awaiting.current = false;
      useManagerChatStore.setState((s) => ({ queues: { ...s.queues, [terminalId]: [next, ...(s.queues[terminalId] ?? [])] } }));
    });
  }, [terminalId, transcript, queue, waitUntil, now, send]);
}

/** The queue above the message box: each message can go now, be edited, or removed. */
export function QueuedMessages({ terminalId, onSendNow }: { terminalId: string; onSendNow: (text: string) => void }) {
  const t = useT();
  const queue = useQueue(terminalId);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (queue.length === 0) return null;
  const store = useManagerChatStore.getState();
  const icon = "tc-rail-btn inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]";
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      {queue.map((q, i) => (
        <div key={q.id} className="flex items-center gap-2 rounded-[9px] border border-dashed border-[var(--border-hover)] py-1.5 pl-2.5 pr-1.5 text-[12px] text-[var(--text-secondary)]">
          <span className="shrink-0 rounded-full border px-1.5 text-[10.5px]" style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 40%, transparent)" }}>
            {t.chat_queued(i + 1)}
          </span>
          {editing === q.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && draft.trim()) {
                  store.editQueued(terminalId, q.id, draft.trim());
                  setEditing(null);
                } else if (e.key === "Escape") setEditing(null);
              }}
              onBlur={() => setEditing(null)}
              aria-label={t.chat_queued_edit}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate" title={q.text}>
              {q.text}
            </span>
          )}
          <button
            type="button"
            className={icon}
            title={t.chat_queued_send_now}
            aria-label={t.chat_queued_send_now}
            onClick={() => {
              store.removeQueued(terminalId, q.id);
              onSendNow(q.text);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </button>
          <button
            type="button"
            className={icon}
            title={t.chat_queued_edit}
            aria-label={t.chat_queued_edit}
            onClick={() => {
              setDraft(q.text);
              setEditing(q.id);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 13h3l7-7-3-3-7 7z" />
            </svg>
          </button>
          <button type="button" className={icon} title={t.chat_queued_remove} aria-label={t.chat_queued_remove} onClick={() => store.removeQueued(terminalId, q.id)}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/** How full the context is: a small bar and the percent, the detail on hover. */
export function ContextMeter({ transcript }: { transcript: ChatTranscript }) {
  const t = useT();
  const percent = contextPercent(transcript.context);
  if (percent === null || !transcript.context) return null;
  const limit = transcript.limit;
  const lines = [t.chat_context_detail(percent, formatTokens(transcript.context.used), formatTokens(transcript.context.window ?? 0))];
  if (limit?.usedPercent !== undefined) lines.push(t.chat_limit_detail(limit.usedPercent, resetLabel(limit.resetsAt) ?? ""));
  const tone = percent >= 85 ? "var(--red)" : percent >= 65 ? "var(--amber)" : "var(--text-muted)";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-[var(--text-muted)]" title={lines.join("\n")} aria-label={lines.join(". ")}>
      <span aria-hidden="true" className="block h-1 w-9 overflow-hidden rounded-full bg-[var(--surface-hover)]">
        <span className="block h-1 rounded-full" style={{ width: `${percent}%`, background: tone }} />
      </span>
      {percent}%
    </span>
  );
}

const STEP_MARK: Record<PlanStep["status"], { mark: string; color: string }> = {
  done: { mark: "✓", color: "var(--green)" },
  active: { mark: "▸", color: "var(--accent)" },
  pending: { mark: "○", color: "var(--text-faint)" },
};

/** The agent's plan, as a checklist. */
export function PlanSteps({ steps }: { steps: readonly PlanStep[] }) {
  return (
    <div className="flex flex-col gap-1 text-[12.5px]">
      {steps.map((step, i) => (
        <div key={i} className="flex gap-2">
          <span className="shrink-0" style={{ color: STEP_MARK[step.status].color }} aria-hidden="true">
            {STEP_MARK[step.status].mark}
          </span>
          <span
            className={step.status === "done" ? "text-[var(--text-muted)] line-through" : step.status === "active" ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}
          >
            {step.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The running turn's plan, above the message box, folded to its current step. */
export function PlanCard({ transcript }: { transcript: ChatTranscript }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const steps = transcript.plan;
  if (!steps || !transcript.running) return null;
  const done = steps.filter((s) => s.status === "done").length;
  const current = steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending");
  return (
    <div className="mx-3 mb-2 rounded-[10px] border border-[var(--border)] px-3 py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left text-[11.5px] text-[var(--text-muted)]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="uppercase tracking-[0.06em]">{t.chat_plan}</span>
        <span className="tabular-nums">
          {done}/{steps.length}
        </span>
        {!open && current && <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">{current.text}</span>}
      </button>
      {open && (
        <div className="mt-1.5">
          <PlanSteps steps={steps} />
        </div>
      )}
    </div>
  );
}

/**
 * Out of usage: when it comes back, and what to do meanwhile. Waiting holds
 * the queue (with your last message in it again) until the limit lifts.
 */
export function LimitCard({
  terminalId,
  transcript,
  agentName,
  handOver,
}: {
  terminalId: string;
  transcript: ChatTranscript;
  agentName: string;
  /** Hand the manager's seat to another agent; only for the manager. */
  handOver?: { label: string; run: () => void };
}) {
  const t = useT();
  const waitUntil = useManagerChatStore((s) => s.waitUntil[terminalId] ?? null);
  const queued = useQueue(terminalId).length;
  if (transcript.limit?.status !== "limited" || transcript.running) return null;
  const resets = resetLabel(transcript.limit.resetsAt);
  const store = useManagerChatStore.getState();
  if (waitUntil) {
    return (
      <div className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
        <span className="min-w-0 flex-1">{t.chat_limit_waiting(resetLabel(waitUntil) ?? "", queued)}</span>
        <button type="button" className="tc-rail-btn h-7 px-2 text-[12px] text-[var(--text-secondary)]" onClick={() => store.setWaitUntil(terminalId, null)}>
          {t.cancel}
        </button>
      </div>
    );
  }
  const lastUser = [...transcript.messages].reverse().find((m) => m.role === "user");
  const wait = () => {
    if (!transcript.limit?.resetsAt) return;
    if (queued === 0 && lastUser?.role === "user") store.enqueue(terminalId, lastUser.text);
    store.setWaitUntil(terminalId, transcript.limit.resetsAt);
  };
  return (
    <div className="mx-3 mb-2 flex flex-col gap-2 rounded-[12px] border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--amber) 40%, transparent)", background: "color-mix(in srgb, var(--amber) 6%, transparent)" }}>
      <div className="text-[13px] font-medium text-[var(--text-primary)]">{t.chat_limit_title(agentName)}</div>
      <div className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{resets ? t.chat_limit_body(resets) : t.chat_limit_body_unknown}</div>
      <div className="flex flex-wrap gap-1.5">
        {handOver && (
          <button type="button" className="tc-rail-btn h-8 border border-[var(--border-hover)] px-3 text-[12px] text-[var(--text-primary)]" onClick={handOver.run}>
            {handOver.label}
          </button>
        )}
        {resets && (
          <button type="button" className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-secondary)]" onClick={wait}>
            {t.chat_limit_wait(resets)}
          </button>
        )}
      </div>
    </div>
  );
}

/** The line where earlier turns were summarized to make room. */
export function CompactedDivider({ preTokens, t }: { preTokens?: number; t: Dict }) {
  return (
    <div className="my-3 flex items-center gap-2 text-[11px] text-[var(--text-muted)]" role="separator">
      <span className="h-px flex-1 bg-[var(--border)]" />
      {preTokens ? t.chat_compacted_from(formatTokens(preTokens)) : t.chat_compacted}
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}
