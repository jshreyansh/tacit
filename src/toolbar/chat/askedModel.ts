import type { ChatQuestion } from "../../../shared/chat-events";
import { claudeQuestions } from "../../../shared/chat-stream-claude";
import { CODEX_ASK_ASYNC_TOOL, CODEX_ASK_TOOL, codexAsyncQuestions, codexQuestions } from "../../../shared/chat-stream-codex";
import { askedAnswers } from "./threadMessages";

/**
 * Questions an agent asked, as they stay in the thread once answered:
 * each question, what it offered, and what the person said. Claude asks
 * with AskUserQuestion, Codex with request_user_input (or its async kind,
 * answered by the next message); either way the call of the tool is the
 * record, and its result the answers. Pure.
 */

export interface AskedQuestion {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
  secret: boolean;
  /** What the person answered: options picked, or their own words. Empty: not answered. */
  answer: string[];
}

export interface AskedView {
  questions: AskedQuestion[];
  answered: number;
  /** The agent has the reply (some may be skipped); false while it waits. */
  settled: boolean;
}

const ASKED_TOOLS = new Set(["AskUserQuestion", CODEX_ASK_TOOL, CODEX_ASK_ASYNC_TOOL]);

/** Whether a tool call is an agent asking the person questions. */
export function isAskedTool(toolName: string): boolean {
  return ASKED_TOOLS.has(toolName);
}

/** Codex's answers, as the result of its question tool: `{ answers: { id: { answers: [...] } } }`. */
function codexAnswers(result: unknown): Record<string, string[]> | null {
  let parsed = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || !("answers" in parsed)) return null;
  const answers = (parsed as { answers: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    const list = value && typeof value === "object" ? (value as { answers?: unknown }).answers : null;
    if (Array.isArray(list)) out[id] = list.filter((a): a is string => typeof a === "string");
  }
  return out;
}

export function askedView(toolName: string, args: Record<string, unknown>, result: unknown): AskedView | null {
  let questions: ChatQuestion[];
  let answers: Record<string, string[]> | null;
  if (toolName === "AskUserQuestion") {
    questions = claudeQuestions(args);
    const text = typeof result === "string" ? result : undefined;
    const byQuestion = askedAnswers(text);
    answers = text === undefined ? null : Object.fromEntries(Object.entries(byQuestion).map(([q, a]) => [q, [a]]));
  } else if (toolName === CODEX_ASK_TOOL) {
    questions = codexQuestions(args);
    answers = codexAnswers(result);
  } else if (toolName === CODEX_ASK_ASYNC_TOOL) {
    questions = codexAsyncQuestions(args.questions);
    // Its own result only says the questions were posted; the answers come after.
    answers = codexAnswers(result);
  } else {
    return null;
  }
  if (questions.length === 0) return null;
  const asked = questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options ?? [],
    secret: q.secret,
    answer: answers?.[q.id] ?? [],
  }));
  return { questions: asked, answered: asked.filter((q) => q.answer.length > 0).length, settled: answers !== null };
}
