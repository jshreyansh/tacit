import type { ChatAnswers, ChatQuestion } from "../../../shared/chat-events";

/**
 * A question being answered in the chat: what's picked, and an answer in
 * the person's own words. Pure, so the rules are tested without React.
 */
export interface QuestionDraft {
  picked: string[];
  other: string;
  otherOn: boolean;
}

/** The answer a draft gives: the options picked, then their own words when chosen. */
export function answerOf(question: ChatQuestion, draft: QuestionDraft): string[] {
  const own = draft.other.trim();
  if (!question.options) return own ? [own] : [];
  return [...draft.picked, ...(draft.otherOn && own ? [own] : [])];
}

/** Whether Next (or Submit) can go: the question has an answer. */
export function canGoOn(question: ChatQuestion | undefined, draft: QuestionDraft | undefined): boolean {
  if (!question || !draft) return false;
  return answerOf(question, draft).length > 0;
}

export function answersFor(questions: readonly ChatQuestion[], drafts: readonly QuestionDraft[]): ChatAnswers {
  const out: ChatAnswers = {};
  questions.forEach((q, i) => {
    const answer = answerOf(q, drafts[i] ?? { picked: [], other: "", otherOn: false });
    if (answer.length) out[q.id] = answer;
  });
  return out;
}

/**
 * Skip on question `index`: that one goes unanswered and the form moves
 * on; on the last, what was answered goes back, or, with nothing
 * answered, the whole set is skipped.
 */
export function skipStep(
  questions: readonly ChatQuestion[],
  drafts: readonly QuestionDraft[],
  index: number,
): { next: number } | { submit: ChatAnswers } | { skipAll: true } {
  if (index < questions.length - 1) return { next: index + 1 };
  const answers = answersFor(questions, drafts.map((d, i) => (i === index ? { picked: [], other: "", otherOn: false } : d)));
  return Object.keys(answers).length > 0 ? { submit: answers } : { skipAll: true };
}

/**
 * Where the form goes after question `index`: the next question, then a
 * review of every answer when there are several, else submit.
 */
export function stepAfter(index: number, total: number): { question: number } | "review" | "submit" {
  if (index < total - 1) return { question: index + 1 };
  return total > 1 ? "review" : "submit";
}

export interface Receipt {
  index: number;
  label: string;
  answer: string;
}

/**
 * The answers given so far, as chips above the stack: every question
 * answered except the one open now. A secret shows as dots.
 */
export function receiptsFor(questions: readonly ChatQuestion[], drafts: readonly QuestionDraft[], open: number): Receipt[] {
  const out: Receipt[] = [];
  questions.forEach((q, i) => {
    if (i === open) return;
    const answer = answerOf(q, drafts[i] ?? { picked: [], other: "", otherOn: false });
    if (answer.length === 0) return;
    out.push({ index: i, label: q.header || q.question, answer: q.secret ? "••••••" : answer.join(", ") });
  });
  return out;
}

/** A draft that hands the choice back to the agent, in the person's words. */
export function decideDraft(text: string): QuestionDraft {
  return { picked: [], other: text, otherOn: true };
}
