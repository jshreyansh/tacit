import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { canResume, carriesOn, isActive, tryOf, type TaskRequest } from "../../shared/task";
import { answerTask, changeTask, goToTerminal, handOver, sayOnTask, stopTask } from "./taskActions";
import { HandOverButton } from "./HandOver";
import { findTerminal } from "../actions/terminalLookup";
import { ago } from "./taskWords";
import { useNow } from "./useNow";

/** One thing a task waits on you for, with what you can do about it. */
export function RequestBlock({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const now = useNow();
  const meanwhile = carriesOn(task);
  return (
    <div className="tc-tk-req" data-kind={request.kind} onMouseDown={(e) => e.stopPropagation()}>
      <p className="tc-tk-req-head">
        <span className="tc-tk-kind" data-kind={request.kind}>
          {t.tb.reasons[request.kind]}
        </span>
        <span className="text-[var(--text-metadata)]">
          {request.byName}, {t.tb.waited(ago(request.at, now))}
        </span>
      </p>
      <p className="tc-tk-req-text">{request.text}</p>
      {request.why && request.kind !== "check" && <p className="tc-tk-req-why">{request.why}</p>}
      {request.said && <Said words={request.said} />}
      {(request.kind === "decide" || request.kind === "approve") && <Answer key={request.id} task={task} request={request} />}
      {request.kind === "allow" && <Allow task={task} request={request} />}
      {request.kind === "stuck" && <Stuck task={task} request={request} />}
      {request.kind === "check" && <Check task={task} request={request} />}
      {(request.meanwhile || meanwhile > 0) && request.kind !== "check" && <p className="tc-tk-req-meanwhile">{request.meanwhile ? t.tb.meanwhile(request.meanwhile) : t.tb.carriesOn(meanwhile)}</p>}
    </div>
  );
}

/** What the agent said as it stopped: the start of it, and all of it when asked for. */
function Said({ words }: { words: string }) {
  const t = useT();
  const ref = useRef<HTMLParagraphElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || all) return;
    const look = () => setLong(el.scrollHeight > el.clientHeight + 2);
    look();
    const observer = new ResizeObserver(look);
    observer.observe(el);
    return () => observer.disconnect();
  }, [words, all]);
  return (
    <div className="flex flex-col items-start">
      <p ref={ref} className="tc-tk-req-why tc-tk-said" data-all={all || undefined}>
        {t.tb.itSaid(words)}
      </p>
      {(long || all) && (
        <button type="button" className="tc-tk-more !px-0" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t.tb.showLess : t.tb.showAll}
        </button>
      )}
    </div>
  );
}

function Answer({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  const given = request.answer;
  const text = [picked.join(", "), words.trim()].filter(Boolean).join(". ");
  const send = async (answer = text) => {
    if (!answer || sending) return;
    setSending(true);
    await answerTask(task, request.id, answer);
    setSending(false);
  };
  if (given) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px]" aria-live="polite">
        <span className="text-[var(--text-primary)]">“{given.text}”</span>
        <span className={given.failed ? "text-[var(--red)]" : "text-[var(--text-metadata)]"}>{given.failed ? t.tb.notDelivered(given.failed) : t.tb.sending}</span>
        {given.failed && (
          <button type="button" className="tc-tk-btn" disabled={sending} onClick={() => void send(given.text)}>
            {t.tb.sendAgain}
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {(request.options ?? []).map((o) => {
        const on = picked.includes(o.label);
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={on}
            className="tc-tk-choice"
            onClick={() => setPicked(on ? picked.filter((p) => p !== o.label) : request.multi ? [...picked, o.label] : [o.label])}
          >
            <span>
              {o.label}
              {o.recommended && <em>{t.tb.recommended}</em>}
            </span>
            {o.detail && <small>{o.detail}</small>}
          </button>
        );
      })}
      <span className="flex gap-1.5">
        <input className="tc-tk-input min-w-0 flex-1" aria-label={t.tb.ownWords} placeholder={t.tb.ownWords} maxLength={900} value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="tc-tk-btn" data-strong={!!text} disabled={!text || sending}>
          {t.tb.send}
        </button>
      </span>
    </form>
  );
}

const terminalOf = (task: Task, request: TaskRequest) => {
  const id = tryOf(task, request.try)?.terminal;
  return id && findTerminal(id) ? id : null;
};

function Allow({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const terminal = terminalOf(task, request);
  return (
    <>
      <p className="tc-tk-req-why">{t.tb.allowHint}</p>
      {terminal && (
        <button type="button" className="tc-tk-btn self-start" data-strong="true" onClick={() => goToTerminal(terminal)}>
          {t.tb.openTerminal}
        </button>
      )}
    </>
  );
}

function Stuck({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const at = tryOf(task, request.try);
  const terminal = terminalOf(task, request);
  const going = at && isActive(at.state);
  const resumable = at && terminal && canResume(at.state) && at.state !== "quiet";
  return (
    <div className="flex flex-wrap gap-1.5">
      {going && (
        <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => void changeTask(task, { op: "dismiss", request: request.id })}>
          {t.tb.giveTime}
        </button>
      )}
      {resumable && (
        <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => void sayOnTask(task, t.tb.carryOnText, at.id)}>
          {t.tb.carryOn}
        </button>
      )}
      {terminal && (
        <button type="button" className="tc-tk-btn" onClick={() => goToTerminal(terminal)}>
          {t.tb.openTerminal}
        </button>
      )}
      <HandOverButton task={task} part={at?.part ?? null} label={t.tb.startOver} />
      {going ? (
        <button type="button" className="tc-tk-btn" onClick={() => void stopTask(task, at.id)}>
          {t.tb.stop}
        </button>
      ) : (
        <button type="button" className="tc-tk-btn" onClick={() => void changeTask(task, { op: "dismiss", request: request.id })}>
          {t.tb.leaveIt}
        </button>
      )}
    </div>
  );
}

function Check({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const [back, setBack] = useState(false);
  const [words, setWords] = useState("");
  const terminal = terminalOf(task, request);
  const part = tryOf(task, request.try)?.part ?? null;
  const send = async () => {
    if (!terminal || !words.trim()) return;
    const result = await handOver(task, terminal, { part, note: words.trim(), allowed: task.allowed, how: "queue" });
    if (result === "done") setBack(false);
  };
  return (
    <>
      {task.report && <ReportFacts task={task} />}
      {back ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea autoFocus className="tc-tk-input resize-y" aria-label={t.tb.sendBackHint} placeholder={t.tb.sendBackHint} maxLength={2000} value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <span className="flex flex-wrap gap-1.5">
            {terminal && (
              <button type="submit" className="tc-tk-btn" data-strong={!!words.trim()} disabled={!words.trim()}>
                {t.tb.sendBack}
              </button>
            )}
            <HandOverButton task={task} part={part} note={words.trim() || undefined} label={t.tb.startOver} />
            <button type="button" className="tc-tk-btn" onClick={() => setBack(false)}>
              {t.tb.cancel}
            </button>
          </span>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => void changeTask(task, { op: "accept" })}>
            {t.tb.looksGood}
          </button>
          <button type="button" className="tc-tk-btn" onClick={() => setBack(true)}>
            {t.tb.sendBack}
          </button>
        </div>
      )}
    </>
  );
}

/** What a report rests on, each line by who saw it. Why it came to you, first. */
export function ReportFacts({ task, reasons = true }: { task: Task; reasons?: boolean }) {
  const t = useT();
  const report = task.report;
  if (!report) return null;
  // On the page its lines are with Done when, so not twice.
  const lines = [...(reasons ? task.doneWhen : []).flatMap((l) => (l.proof ? [{ src: l.proof.src, text: `${l.text}: ${l.proof.text}` }] : [])), ...report.facts];
  return (
    <div className="flex flex-col gap-1">
      {reasons && report.reasons.length > 0 && <p className="tc-tk-req-why">{`${t.tb.cameBecause} ${report.reasons.join(". ")}`}</p>}
      {report.stale && <p className="text-[13px] text-[var(--amber)]">{t.tb.reportStale}</p>}
      {lines.map((l, i) => (
        <p key={i} className="tc-tk-fact">
          <span className="tc-tk-src" data-src={l.src}>
            {t.tb.sources[l.src]}
          </span>
          <span>{l.text}</span>
        </p>
      ))}
      {lines.length === 0 && reasons && <p className="tc-tk-req-why">{t.tb.nothingToSee}</p>}
    </div>
  );
}
