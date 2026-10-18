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
