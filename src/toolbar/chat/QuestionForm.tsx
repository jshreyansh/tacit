import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n/useT";
import type { ChatQuestion } from "../../../shared/chat-events";
import type { PendingQuestion } from "../../../shared/chat-transcript";
import { AskBadge, AskHead, AskOption, askButtonClass, askButtonStyle } from "../../components/ask/AskCard";
import { answerOf, answersFor, canGoOn, decideDraft, receiptsFor, stepAfter, type QuestionDraft } from "./questionModel";

/**
 * The agent's questions (Claude's AskUserQuestion, Codex's
 * request_user_input), as a stack of cards behind the message box: the
 * question open now in front, the ones to come peeking out above it, and
 * every answer given so far as a receipt chip you can tap to change it.
 * Several questions end on a review with one Send, the way the agent's own
 * terminal takes them.
 *
 * Keys: 1–9 pick an option, Enter goes on, ⌘Enter sends from anywhere.
 * Picking a single choice moves to the next question by itself.
 */

const EMPTY: QuestionDraft = { picked: [], other: "", otherOn: false };

function QuestionStep({ question, draft, onChange, onPicked }: { question: ChatQuestion; draft: QuestionDraft; onChange: (draft: QuestionDraft) => void; onPicked: () => void }) {
  const t = useT();
  const toggle = (label: string) => {
    if (question.multiSelect) {
      const picked = draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label];
      onChange({ ...draft, picked });
    } else {
      onChange({ ...draft, picked: [label], otherOn: false });
      onPicked();
    }
  };
  const input = "tc-sq-ctl w-full bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]";
  if (!question.options) {
    return (
      <label className="flex">
        <span className="sr-only">{question.question}</span>
        <input
          autoFocus
          type={question.secret ? "password" : "text"}
          value={draft.other}
          placeholder={t.chat_question_type_answer}
          onChange={(e) => onChange({ ...draft, other: e.target.value, otherOn: true })}
          className={input}
          style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}
        />
      </label>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
      {question.options.map((option, i) => (
        <AskOption
          key={option.label}
          multi={question.multiSelect}
          checked={draft.picked.includes(option.label)}
          label={option.label}
          description={option.description}
          recommended={option.recommended ? t.tb.recommended : undefined}
          hotkey={i < 9 ? String(i + 1) : undefined}
          onPick={() => toggle(option.label)}
        />
      ))}
      {question.allowOther && (
        <label className="tc-sq-ctl flex min-h-10 items-center gap-2.5 px-2.5" style={{ background: draft.otherOn ? "var(--accent-soft)" : "color-mix(in srgb, var(--text-primary) 4%, transparent)" }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">
            <path d="M3 13h3l7-7-3-3-7 7z" />
          </svg>
          <span className="sr-only">{t.chat_question_other}</span>
          <input
            type={question.secret ? "password" : "text"}
            value={draft.other}
            placeholder={t.chat_question_other}
            onFocus={() => onChange({ ...draft, otherOn: true, picked: question.multiSelect ? draft.picked : [] })}
            onChange={(e) => onChange({ ...draft, other: e.target.value, otherOn: true, picked: question.multiSelect ? draft.picked : [] })}
            className="min-w-0 flex-1 bg-transparent py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>
      )}
    </div>
  );
}

export function QuestionForm({
  pending,
  agentName,
  onSubmit,
  onSkip,
  floating = false,
  inline = false,
  skippable = true,
  busy = false,
}: {
  pending: PendingQuestion;
  agentName: string;
  onSubmit: (answers: Record<string, string[]>) => void;
  onSkip: () => void;
  /** Over the canvas, in the pill's own glass: one card, no stack behind it. */
  floating?: boolean;
  /** Inside something else, as on a task: no frame of its own, and no stack. */
  inline?: boolean;
  /** Whether a question can go unanswered. A task's waits until it's answered. */
  skippable?: boolean;
  /** Being sent. */
  busy?: boolean;
}) {
  const t = useT();
  const questions = pending.questions;
  const total = questions.length;
  // An index past the last question is the review.
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => EMPTY));
  const reviewing = index >= total;
  const question = reviewing ? undefined : questions[index];
  const draft = drafts[index] ?? EMPTY;
  const ready = useMemo(() => canGoOn(question, draft), [question, draft]);
  const receipts = receiptsFor(questions, drafts, reviewing ? -1 : index);
  const frontRef = useRef<HTMLDivElement>(null);
  const advanceTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
  }, []);

  if (total === 0) return null;

  const setDraft = (i: number, d: QuestionDraft) => setDrafts((prev) => prev.map((x, j) => (j === i ? d : x)));
  const sendAll = (from: QuestionDraft[] = drafts) => {
    const answers = answersFor(questions, from);
    if (Object.keys(answers).length > 0) onSubmit(answers);
    else onSkip();
  };
  const goOn = (from: QuestionDraft[] = drafts) => {
    const step = stepAfter(index, total);
    if (step === "submit") sendAll(from);
    else if (step === "review") setIndex(total);
    else setIndex(step.question);
  };
  const skipOne = () => {
    const cleared = drafts.map((d, j) => (j === index ? EMPTY : d));
    setDrafts(cleared);
    const step = stepAfter(index, total);
    if (step === "submit") onSkip();
    else if (step === "review") setIndex(total);
    else setIndex(step.question);
  };
  const decide = () => {
    const next = drafts.map((d, j) => (j === index ? decideDraft(t.chat_question_decide_answer) : d));
    setDrafts(next);
    goOn(next);
  };
  // A single choice moves on by itself, after a beat to see it picked.
  const autoAdvance = () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      if (total > 1) goOn();
    }, 220);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The canvas listens globally for single-key shortcuts.
    e.stopPropagation();
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendAll();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (reviewing) {
        e.preventDefault();
        sendAll();
      } else if (ready) {
        e.preventDefault();
        goOn();
      }
      return;
    }
    if (!typing && question?.options && /^[1-9]$/.test(e.key)) {
      const option = question.options[Number(e.key) - 1];
      if (!option) return;
      e.preventDefault();
      if (question.multiSelect) {
        const picked = draft.picked.includes(option.label) ? draft.picked.filter((l) => l !== option.label) : [...draft.picked, option.label];
        setDraft(index, { ...draft, picked });
      } else {
        setDraft(index, { ...draft, picked: [option.label], otherOn: false });
        autoAdvance();
      }
    }
  };

  // What's still to come, nearest first: the next questions, then the review.
  const upcoming: { key: string; number?: number; label: string; detail?: string }[] = [];
  if (!reviewing) {
    for (let j = index + 1; j < total; j += 1) upcoming.push({ key: questions[j].id, number: j + 1, label: questions[j].header || "", detail: questions[j].question });
    if (total > 1) upcoming.push({ key: "review", label: t.chat_question_review_back });
  }
  const backs = floating || inline ? [] : upcoming.slice(0, 2).reverse();
  const button = "tc-sq-ctl inline-flex h-8 items-center gap-1.5 px-3 text-[12.5px]";
  const answeredCount = Object.keys(answersFor(questions, drafts)).length;

  return (
    <div className={`flex flex-col ${inline ? "tc-ask-inline" : ""}`} onKeyDown={onKeyDown} role="form" aria-label={t.chat_question_title(agentName)}>
      {receipts.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 pb-2 ${floating || inline ? "px-3" : "px-[18px]"} ${inline ? "pt-3 !pb-0" : ""}`}>
          {receipts.map((r) => (
            <button
              key={r.index}
              type="button"
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pl-1.5 pr-2.5 text-[12px] text-[var(--text-primary)] hover:brightness-125"
              style={{ background: "var(--accent-soft)" }}
              title={t.chat_question_change}
              onClick={() => setIndex(r.index)}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}>
                <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              </span>
              <span className="max-w-[9rem] shrink-0 truncate text-[var(--text-muted)]">{r.label}</span>
              <span className="min-w-0 truncate">{r.answer}</span>
            </button>
          ))}
        </div>
      )}
      {backs.map((b, i) => (
        <button
          key={b.key}
          type="button"
          className="tc-behind-back"
          style={{ margin: `0 ${14 + (backs.length - i) * 20}px -10px`, zIndex: 0 }}
          onClick={() => setIndex(b.key === "review" ? total : (b.number ?? 1) - 1)}
        >
          {b.number ? (
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--text-primary) 20%, transparent)" }}>
              {b.number}
            </span>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="shrink-0">
              <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
            </svg>
          )}
          {b.label && <span className="shrink-0 font-semibold text-[var(--text-secondary)]">{b.label}</span>}
          {b.detail && <span className="min-w-0 truncate">{b.detail}</span>}
        </button>
      ))}
      <div ref={frontRef} className={floating || inline ? "" : "tc-behind"} style={{ zIndex: 0 }}>
        {reviewing ? (
          <>
            <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
              <AskBadge kind="question" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">{t.chat_question_review_title}</span>
                <span className="text-[11.5px] text-[var(--text-muted)]">{t.chat_question_answered_count(answeredCount, total)}</span>
              </span>
            </div>
            <div className="flex flex-col gap-1 px-3 pb-2">
              {questions.map((q, i) => {
                const answer = answerOf(q, drafts[i] ?? EMPTY);
                return (
                  <button
                    key={q.id}
                    type="button"
                    className="tc-sq-ctl flex items-center gap-2.5 px-2.5 py-2 text-left text-[12.5px] hover:bg-[var(--surface-hover)]"
                    style={{ background: "color-mix(in srgb, var(--text-primary) 3.5%, transparent)" }}
                    onClick={() => setIndex(i)}
                  >
                    <span className="w-20 shrink-0 truncate font-semibold text-[var(--text-secondary)]">{q.header || `${i + 1}`}</span>
                    <span className={`min-w-0 flex-1 truncate ${answer.length ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>
                      {answer.length ? (q.secret ? "••••••" : answer.join(", ")) : t.chat_question_skipped}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{t.chat_question_change}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-2.5">
              {skippable && (
                <button type="button" className={`${button} text-[var(--text-muted)] hover:text-[var(--text-primary)]`} onClick={onSkip}>
                  {t.chat_question_skip_all}
                </button>
              )}
              <span className="flex-1" />
              <button type="button" disabled={busy} className={askButtonClass("primary")} style={askButtonStyle("primary")} onClick={() => sendAll()}>
                {t.chat_question_send_n(answeredCount)}
                <span className="tc-mono text-[10px] opacity-60">⌘⏎</span>
              </button>
            </div>
          </>
        ) : (
          question && (
            <>
              <AskHead kind="question" label={question.header || t.chat_question_title(agentName)} title={question.question} meta={total > 1 ? t.chat_question_count(index + 1, total) : undefined} />
              {question.why && <p className="px-3 pb-2 text-[12.5px] leading-snug text-[var(--text-metadata)] [overflow-wrap:anywhere]">{question.why}</p>}
              {question.multiSelect && (
                <div className="px-[14px] pb-1.5 text-[11.5px] text-[var(--text-muted)]">
                  {t.chat_question_pick_any}
                  {draft.picked.length > 0 && ` · ${t.chat_question_chosen(draft.picked.length)}`}
                </div>
              )}
              {/* The answers scroll on their own past a third of the window,
                  so a long question never pushes the conversation out of reach. */}
              <div className="tc-question-answers max-h-[34vh] min-h-0 overflow-y-auto px-3 pb-2">
                <QuestionStep key={question.id} question={question} draft={draft} onChange={(d) => setDraft(index, d)} onPicked={autoAdvance} />
              </div>
              <div className="flex items-center gap-1 border-t border-[var(--border)] px-2.5 py-2">
                {index > 0 && (
                  <button type="button" className={`${button} px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]`} onClick={() => setIndex((i) => i - 1)}>
                    {t.back}
                  </button>
                )}
                {skippable && (
                  <button type="button" className={`${button} px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]`} onClick={skipOne}>
                    {t.chat_question_skip}
                  </button>
                )}
                <button type="button" className={`${button} min-w-0 px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]`} onClick={decide} title={t.chat_question_decide_hint}>
                  <span className="truncate">{t.chat_question_decide(agentName.split(" ")[0])}</span>
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={!ready || busy}
                  className={askButtonClass("primary")}
                  style={askButtonStyle("primary")}
                  onClick={() => goOn()}
                >
                  {stepAfter(index, total) === "submit" ? t.chat_question_submit : t.chat_question_next}
                  <span className="tc-mono text-[10px] opacity-60">⏎</span>
                </button>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
