import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import type { ChatQuestion } from "../../shared/chat-events";
import { GO_AHEAD, canResume, carriesOn, isActive, tryOf, type TaskRequest } from "../../shared/task";
import { AskButton, AskFoot, AskHead, AskReply, AskWords } from "../components/ask/AskCard";
import { findTerminal } from "../actions/terminalLookup";
import { answerChatQuestion, answerManagerApproval, configureChat } from "../actions/managerChatMode";
import { useManagerTranscript } from "../stores/managerChatStore";
import { ApprovalCards } from "../toolbar/chat/ChatThread";
import { canSwitchToAuto } from "../toolbar/chat/composerSettingsModel";
import { QuestionForm } from "../toolbar/chat/QuestionForm";
import { answerTask, changeTask, goToTerminal, handOver, sayOnTask, stopTask } from "./taskActions";
import { HandOverButton } from "./HandOver";
import { ago } from "./taskWords";
import { useNow } from "./useNow";

/**
 * What a task waits on you for, each as the chat would ask it
 * (src/components/ask): a question with its answers, an approval, what an
 * agent is stuck on, a finish to look at.
 */
export function TaskAsks({ task, requests }: { task: Task; requests: readonly TaskRequest[] }) {
  // One agent's questions are asked together, as they are in its chat.
  const questions = requests.filter((r) => r.kind === "decide" && !r.answer);
  const askers = [...new Set(questions.map((r) => r.by))];
  const rest = requests.filter((r) => !questions.includes(r));
  const carries = carriesOn(task);
  const t = useT();
  const meanwhile = requests.find((r) => r.meanwhile)?.meanwhile;
  return (
    <>
      {askers.map((by) => (
        <Ask key={by}>
          <Questions task={task} requests={questions.filter((r) => r.by === by)} />
        </Ask>
      ))}
      {rest.map((r) => (
        <Ask key={r.id}>
          <OneAsk task={task} request={r} />
        </Ask>
      ))}
      {requests.some((r) => r.kind !== "check") && (meanwhile || carries > 0) && <p className="tc-tk-meanwhile">{meanwhile ? t.tb.meanwhile(meanwhile) : t.tb.carriesOn(carries)}</p>}
    </>
  );
}

/** Pressing in one is answering it, not dragging or opening what it's on. */
function Ask({ children }: { children: ReactNode }) {
  return (
    <div className="tc-tk-ask" draggable onDragStart={(e) => (e.preventDefault(), e.stopPropagation())} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

function Questions({ task, requests }: { task: Task; requests: readonly TaskRequest[] }) {
  const t = useT();
  const [sending, setSending] = useState(false);
  // What's being answered stays as it is until it's sent: one that comes meanwhile is next.
  const [held, setHeld] = useState<readonly TaskRequest[]>(requests);
  const ids = requests.map((r) => r.id);
  useEffect(() => {
    if (!sending && held.some((r) => !ids.includes(r.id))) setHeld(requests);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (held.length === 0) return null;
  const questions: ChatQuestion[] = held.map((r) => ({
    id: r.id,
    header: "",
    question: r.text,
    why: r.why,
    options: r.options?.length ? r.options.map((o) => ({ label: o.label, description: o.detail, recommended: o.recommended })) : null,
    multiSelect: !!r.multi,
    allowOther: true,
    secret: false,
  }));
  return (
    <QuestionForm
      key={held.map((r) => r.id).join()}
      pending={{ requestId: held[0].id, questions }}
      agentName={held[0].byName}
      inline
      skippable={false}
      busy={sending}
      onSkip={() => undefined}
      onSubmit={(answers) => {
        setSending(true);
        void (async () => {
          for (const r of held) if (answers[r.id]?.length) await answerTask(task, r.id, answers[r.id].join(", "));
          setSending(false);
        })();
      }}
    />
  );
}

function OneAsk({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const now = useNow();
  const meta = t.tb.waited(ago(request.at, now));
  if (request.answer) return <Answered task={task} request={request} />;
  switch (request.kind) {
    case "approve":
      return <Approve task={task} request={request} meta={meta} />;
    case "allow":
      return <Allow task={task} request={request} meta={meta} />;
    case "stuck":
      return <Stuck task={task} request={request} meta={meta} />;
    case "check":
      return <Check task={task} request={request} meta={meta} />;
    default:
      return null;
  }
}

const Line = ({ children }: { children: ReactNode }) => <p className="px-3 pb-2 text-[12.5px] leading-snug text-[var(--text-metadata)] [overflow-wrap:anywhere]">{children}</p>;

/** Answered, and on its way to whoever asked. */
function Answered({ task, request }: { task: Task; request: TaskRequest }) {
  const t = useT();
  const [sending, setSending] = useState(false);
  const { text, failed } = request.answer!;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[12.5px]" aria-live="polite">
      <span className="min-w-0 text-[var(--text-primary)] [overflow-wrap:anywhere]">“{text}”</span>
      <span className={failed ? "text-[var(--red)]" : "text-[var(--text-metadata)]"}>{failed ? t.tb.notDelivered(failed) : t.tb.sending}</span>
      {failed && (
        <AskButton
          disabled={sending}
          onClick={() => {
            setSending(true);
            void answerTask(task, request.id, text).then(() => setSending(false));
          }}
        >
          {t.tb.sendAgain}
        </AskButton>
      )}
    </div>
  );
}

/** Before something that can't be undone, or another agent: the very words, Go ahead, or not and why. */
function Approve({ task, request, meta }: { task: Task; request: TaskRequest; meta: string }) {
  const t = useT();
  const [denying, setDenying] = useState(false);
  const [sending, setSending] = useState(false);
  const { does } = request;
  const send = (answer: string) => {
    setSending(true);
    void answerTask(task, request.id, answer).then(() => setSending(false));
  };
  return (
    <>
      <AskHead kind="approval" label={t.chat_card_approval} title={does ? t.tb.wantsReach(request.byName, does.name, !!does.open, does.answer) : t.tb.wantsTo(request.byName)} meta={meta} />
      <AskWords mono={false}>{does ? does.message : request.text}</AskWords>
      {request.why && <div className="pt-2"><Line>{request.why}</Line></div>}
      {does && <div className={request.why ? "" : "pt-2"}><Line>{does.open ? t.tb.doesOpen(does.name) : t.tb.doesReach(does.name)}</Line></div>}
      {denying ? (
        <AskReply placeholder={t.chat_approval_deny_placeholder} action={t.tb.dont} onSend={(words) => send(words ? `Don't. ${words}` : "Don't")} onBack={() => setDenying(false)} />
      ) : (
        <AskFoot>
          <AskButton tone="primary" disabled={sending} onClick={() => send(GO_AHEAD)}>
            {t.tb.goAhead}
          </AskButton>
          <span className="flex-1" />
          <AskButton tone="quiet" disabled={sending} onClick={() => setDenying(true)}>
            {t.tb.dontMore}
          </AskButton>
        </AskFoot>
      )}
    </>
  );
}

const terminalOf = (task: Task, request: TaskRequest) => {
  const id = tryOf(task, request.try)?.terminal;
  return id && findTerminal(id) ? id : null;
};

/**
 * Its CLI waits on a permission. One that's a chat is answered here, with the
 * chat's own card; a terminal's is answered in the terminal.
 */
function Allow({ task, request, meta }: { task: Task; request: TaskRequest; meta: string }) {
  const t = useT();
  const terminal = terminalOf(task, request);
  const chat = terminal ? !!findTerminal(terminal)?.terminal.chatMode : false;
  const agent = terminal ? (findTerminal(terminal)?.terminal.type ?? "") : "";
  const transcript = useManagerTranscript(chat ? terminal : null);
  if (chat && terminal && transcript.approvals.length > 0)
    return (
      <ApprovalCards
        inline
        approvals={transcript.approvals}
        agent={agent}
        onAnswer={(id, decision, note) => void answerManagerApproval(terminal, id, decision, note)}
        onPlanMode={(mode) => void configureChat(terminal, { mode })}
        onSwitchToAuto={canSwitchToAuto(transcript) ? () => void configureChat(terminal, { mode: "auto" }) : undefined}
      />
    );
  if (chat && terminal && transcript.questions[0])
    return (
      <QuestionForm
        key={transcript.questions[0].requestId}
        inline
        pending={transcript.questions[0]}
        agentName={request.byName}
        onSubmit={(answers) => void answerChatQuestion(terminal, transcript.questions[0].requestId, answers)}
        onSkip={() => void answerChatQuestion(terminal, transcript.questions[0].requestId, null)}
      />
    );
  return (
    <>
      <AskHead kind="permission" label={t.tb.reasons.allow} title={`${request.byName}: ${request.text}`} meta={meta} />
      <Line>{t.tb.allowHint}</Line>
      {terminal && (
        <AskFoot>
          <AskButton tone="primary" onClick={() => goToTerminal(terminal)}>
            {t.tb.openTerminal}
          </AskButton>
        </AskFoot>
      )}
    </>
  );
}

function Stuck({ task, request, meta }: { task: Task; request: TaskRequest; meta: string }) {
  const t = useT();
  const at = tryOf(task, request.try);
  const terminal = terminalOf(task, request);
  const going = at && isActive(at.state);
  const resumable = at && terminal && canResume(at.state) && at.state !== "quiet";
  return (
    <>
      <AskHead kind="stuck" label={t.tb.stuckWith(request.byName)} title={request.text} meta={meta} />
      {request.why && <Line>{request.why}</Line>}
      {request.said && <Said words={t.tb.itSaid(request.said)} />}
      <AskFoot>
        {going && (
          <AskButton tone="primary" onClick={() => void changeTask(task, { op: "dismiss", request: request.id })}>
            {t.tb.giveTime}
          </AskButton>
        )}
        {resumable && (
          <AskButton tone="primary" onClick={() => void sayOnTask(task, t.tb.carryOnText, at.id)}>
            {t.tb.carryOn}
          </AskButton>
        )}
        {terminal && <AskButton onClick={() => goToTerminal(terminal)}>{t.tb.openTerminal}</AskButton>}
        <HandOverButton task={task} part={at?.part ?? null} label={t.tb.startOver} />
        <span className="flex-1" />
        {going ? (
          <AskButton tone="quiet" onClick={() => void stopTask(task, at.id)}>
            {t.tb.stop}
          </AskButton>
        ) : (
          <AskButton tone="quiet" onClick={() => void changeTask(task, { op: "dismiss", request: request.id })}>
            {t.tb.leaveIt}
          </AskButton>
        )}
      </AskFoot>
    </>
  );
}

/** A finish that came to you: why, what it rests on, and your word on it. */
function Check({ task, request, meta }: { task: Task; request: TaskRequest; meta: string }) {
  const t = useT();
  const [back, setBack] = useState(false);
  const at = tryOf(task, request.try);
  const terminal = terminalOf(task, request);
  const part = at?.part ?? null;
  const sendBack = (words: string) => {
    if (!words || !terminal) return;
    void handOver(task, terminal, { part, note: words, how: "queue" }).then((r) => r === "done" && setBack(false));
  };
  return (
    <>
      <AskHead kind="check" label={t.tb.checkFrom(request.byName)} title={request.text} meta={meta} />
      {task.report && (
        <div className="px-3 pb-1">
          <ReportFacts task={task} />
        </div>
      )}
      {back ? (
        terminal ? (
          <AskReply required placeholder={t.tb.sendBackHint} action={t.tb.sendBack} onSend={sendBack} onBack={() => setBack(false)}>
            <HandOverButton task={task} part={part} label={t.tb.startOver} />
          </AskReply>
        ) : (
          <AskFoot>
            <HandOverButton task={task} part={part} label={t.tb.startOver} />
            <span className="flex-1" />
            <AskButton tone="quiet" onClick={() => setBack(false)}>
              {t.tb.cancel}
            </AskButton>
          </AskFoot>
        )
      ) : (
        <AskFoot>
          <AskButton tone="primary" onClick={() => void changeTask(task, { op: "accept" })}>
            {t.tb.looksGood}
          </AskButton>
          <span className="flex-1" />
          <AskButton tone="quiet" onClick={() => setBack(true)}>
            {t.tb.sendBackMore}
          </AskButton>
        </AskFoot>
      )}
    </>
  );
}

/** Someone's words: the start of them, and all when asked for. */
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
    <div className="flex flex-col items-start px-3 pb-1">
      <p ref={ref} className="tc-tk-said whitespace-pre-wrap text-[12.5px] leading-snug text-[var(--text-metadata)] [overflow-wrap:anywhere]" data-all={all || undefined}>
        {words}
      </p>
      {(long || all) && (
        <button type="button" className="tc-tk-more !px-0" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t.tb.showLess : t.tb.showAll}
        </button>
      )}
    </div>
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
    <div className="flex flex-col gap-1.5">
      {reasons && report.reasons.length > 0 && <p className="text-[12.5px] leading-snug text-[var(--text-metadata)]">{`${t.tb.cameBecause} ${report.reasons.join(". ")}`}</p>}
      {report.stale && <p className="text-[12.5px] text-[var(--amber)]">{t.tb.reportStale}</p>}
      {lines.map((l, i) => (
        <p key={i} className="tc-tk-fact" data-src={l.src}>
          <span className="tc-tk-src" data-src={l.src}>
            {t.tb.sources[l.src]}
          </span>
          <span>{l.text}</span>
        </p>
      ))}
      {lines.length === 0 && reasons && <p className="text-[12.5px] text-[var(--text-metadata)]">{t.tb.nothingToSee}</p>}
    </div>
  );
}
