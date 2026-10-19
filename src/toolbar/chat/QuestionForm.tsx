import { useMemo, useState } from "react";
import { useT } from "../../i18n/useT";
import type { ChatQuestion } from "../../../shared/chat-events";
import type { PendingQuestion } from "../../../shared/chat-transcript";
import { answersFor, canGoOn, skipStep, type QuestionDraft } from "./questionModel";

/**
 * The agent's questions (Claude's AskUserQuestion, Codex's
 * request_user_input), one at a time: choose one, or several where the
 * agent allows it, or answer in your own words; Back and Next move through
 * them and Submit sends them all, the way the agent's own terminal does;
 * Skip passes over one.
 * A follow-up that depends on the answer comes as the agent's next question.
 */

function Option({
  multi,
  checked,
  label,
  description,
  onPick,
}: {
  multi: boolean;
  checked: boolean;
  label: string;
  description?: string;
  onPick: () => void;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2.5 rounded-[9px] border px-2.5 py-2 text-left"
      style={{ borderColor: checked ? "var(--cyan)" : "var(--border)", background: checked ? "color-mix(in srgb, var(--cyan) 8%, transparent)" : undefined }}
    >
      <input type={multi ? "checkbox" : "radio"} checked={checked} onChange={onPick} className="mt-0.5 accent-[var(--cyan)]" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] text-[var(--text-primary)]">{label}</span>
        {description && <span className="text-[11.5px] leading-snug text-[var(--text-muted)]">{description}</span>}
      </span>
    </label>
  );
}

function QuestionStep({ question, draft, onChange }: { question: ChatQuestion; draft: QuestionDraft; onChange: (draft: QuestionDraft) => void }) {
  const t = useT();
  const toggle = (label: string) => {
    if (question.multiSelect) {
      const picked = draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label];
      onChange({ ...draft, picked });
    } else {
      onChange({ ...draft, picked: [label], otherOn: false });
    }
  };
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
          onKeyDown={(e) => e.stopPropagation()}
          className="w-full rounded-[9px] border border-[var(--border)] bg-transparent px-2.5 py-2 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--border-hover)]"
        />
      </label>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
      {question.options.map((option) => (
        <Option
          key={option.label}
          multi={question.multiSelect}
          checked={draft.picked.includes(option.label)}
          label={option.label}
          description={option.description}
          onPick={() => toggle(option.label)}
        />
      ))}
      {question.allowOther && (
        <div
          className="flex items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5"
          style={{ borderColor: draft.otherOn ? "var(--cyan)" : "var(--border)" }}
        >
          <input
            type={question.multiSelect ? "checkbox" : "radio"}
            checked={draft.otherOn}
            onChange={() => onChange({ ...draft, otherOn: !draft.otherOn || !question.multiSelect, picked: question.multiSelect ? draft.picked : [] })}
            className="accent-[var(--cyan)]"
            aria-label={t.chat_question_other}
          />
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t.chat_question_other}</span>
            <input
              type={question.secret ? "password" : "text"}
              value={draft.other}
              placeholder={t.chat_question_other}
              onFocus={() => onChange({ ...draft, otherOn: true, picked: question.multiSelect ? draft.picked : [] })}
              onChange={(e) => onChange({ ...draft, other: e.target.value, otherOn: true, picked: question.multiSelect ? draft.picked : [] })}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full bg-transparent py-0.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function QuestionForm({
  pending,
  agentName,
  onSubmit,
  onSkip,
}: {
  pending: PendingQuestion;
  agentName: string;
  onSubmit: (answers: Record<string, string[]>) => void;
  onSkip: () => void;
}) {
  const t = useT();
  const questions = pending.questions;
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => ({ picked: [], other: "", otherOn: false })));
  const question = questions[index];
  const last = index === questions.length - 1;
  const ready = useMemo(() => canGoOn(question, drafts[index]), [question, drafts, index]);
  if (!question) return null;
  const button = "tc-rail-btn h-8 px-3 text-[12.5px]";
  return (
    <div
      className="mx-3 mb-2 flex flex-col gap-2.5 rounded-[12px] border px-3 py-3"
      style={{ borderColor: "color-mix(in srgb, var(--cyan) 35%, var(--border))", background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}
      role="form"
      aria-label={t.chat_question_title(agentName)}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="uppercase tracking-[0.06em]">{t.chat_question_title(agentName)}</span>
        {question.header && <span className="rounded-full border border-[var(--border)] px-1.5 normal-case">{question.header}</span>}
        {questions.length > 1 && <span className="ml-auto tabular-nums">{t.chat_question_count(index + 1, questions.length)}</span>}
      </div>
      <div className="text-[13.5px] font-medium leading-snug text-[var(--text-primary)]">
        {question.question}
        {question.multiSelect && <span className="ml-1.5 text-[11.5px] font-normal text-[var(--text-muted)]">{t.chat_question_pick_any}</span>}
      </div>
      <QuestionStep key={question.id} question={question} draft={drafts[index]} onChange={(d) => setDrafts((prev) => prev.map((x, i) => (i === index ? d : x)))} />
      <div className="flex items-center gap-1.5">
        {/* Skips this question only: what was answered before it still goes back. */}
        <button
          type="button"
          className={`${button} text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
          onClick={() => {
            const step = skipStep(questions, drafts, index);
            if ("next" in step) {
              setDrafts((prev) => prev.map((d, i) => (i === index ? { picked: [], other: "", otherOn: false } : d)));
              setIndex(step.next);
            }
            else if ("submit" in step) onSubmit(step.submit);
            else onSkip();
          }}
        >
          {t.chat_question_skip}
        </button>
        <span className="flex-1" />
        {index > 0 && (
          <button type="button" className={`${button} border border-[var(--border)] text-[var(--text-secondary)]`} onClick={() => setIndex((i) => i - 1)}>
            {t.back}
          </button>
        )}
        <button
          type="button"
          disabled={!ready}
          className={`${button} bg-[var(--text-secondary)] text-[var(--bg)] hover:bg-[var(--text-primary)] disabled:opacity-40`}
          onClick={() => (last ? onSubmit(answersFor(questions, drafts)) : setIndex((i) => i + 1))}
        >
          {last ? t.chat_question_submit : t.chat_question_next}
        </button>
      </div>
    </div>
  );
}
