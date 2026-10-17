import type { ChatMessage, ChatPart } from "../../../shared/chat-transcript";

/**
 * The conversation as assistant-ui messages (ThreadMessageLike), for its
 * external-store runtime. Pure, so the mapping is tested without React.
 * Typed structurally here so this file needs nothing from the library.
 */

type JsonObject = { readonly [key: string]: unknown };

export type ThreadPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: JsonObject;
      readonly argsText: string;
      readonly result?: string;
      readonly isError?: boolean;
      readonly artifact?: { status: "running" | "done" | "error"; subagentSteps: number };
    }
  /** How a turn ended when it didn't finish: stopped, or failed and why. */
  | { readonly type: "data-turn-note"; readonly data: { readonly kind: "interrupted" | "error"; readonly error?: string } };

export type ThreadStatus =
  | { readonly type: "running" }
  | { readonly type: "complete"; readonly reason: "stop" }
  | { readonly type: "incomplete"; readonly reason: "cancelled" | "error"; readonly error?: string };

export interface ThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: readonly ThreadPart[];
  readonly createdAt?: Date;
  readonly status?: ThreadStatus;
}

function asArgs(input: unknown): JsonObject {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as JsonObject;
  return input === undefined ? {} : { value: input };
}

function toPart(part: ChatPart): ThreadPart | null {
  switch (part.type) {
    case "text":
      return part.text ? { type: "text", text: part.text } : null;
    case "thinking":
      return { type: "reasoning", text: part.text };
    case "tool":
      return {
        type: "tool-call",
        toolCallId: part.callId,
        toolName: part.name,
        args: asArgs(part.input),
        argsText: part.inputJson || (part.input !== undefined ? JSON.stringify(part.input) : ""),
        ...(part.output !== undefined ? { result: part.output } : {}),
        ...(part.status === "error" ? { isError: true } : {}),
        artifact: { status: part.status, subagentSteps: part.subagentSteps },
      };
  }
}

export function toThreadMessages(messages: readonly ChatMessage[]): ThreadMessage[] {
  return messages.map((m) => {
    if (m.role === "user") {
      return { id: m.id, role: "user", content: [{ type: "text", text: m.text }], createdAt: new Date(m.at) };
    }
    const status: ThreadStatus = !m.done
      ? { type: "running" }
      : m.outcome === "error"
        ? { type: "incomplete", reason: "error", ...(m.error ? { error: m.error } : {}) }
        : m.outcome === "interrupted"
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" };
    const content = m.parts.map(toPart).filter((p): p is ThreadPart => p !== null);
    if (m.done && (m.outcome === "interrupted" || m.outcome === "error")) {
      content.push({ type: "data-turn-note", data: { kind: m.outcome, ...(m.error ? { error: m.error } : {}) } });
    }
    return { id: m.id, role: "assistant", content, status };
  });
}

/** A Tacit tool that starts a worker, and what to show for it. */
export function workerSpawn(toolName: string, args: JsonObject): { agent: string | null; title: string } | null {
  const tool = /^mcp__tacit__(.+)$/.exec(toolName)?.[1];
  if (tool !== "spawn_terminal" && tool !== "spawn_worker") return null;
  const agent = typeof args.type === "string" ? args.type : typeof args.agent === "string" ? args.agent : null;
  const title = [args.title, args.name, args.prompt, args.initial_prompt].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? "";
  return { agent, title: title.replace(/\s+/g, " ").slice(0, 140) };
}

/**
 * The one line a folded run of tool calls reads as: the first few tools by
 * name, repeats counted, the rest as "+N more".
 */
export function toolRunSummary(names: readonly string[], shown = 3): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const distinct = [...counts.keys()];
  const head = distinct.slice(0, shown).map((name) => (counts.get(name)! > 1 ? `${name} ×${counts.get(name)}` : name));
  const rest = distinct.length - shown;
  return rest > 0 ? `${head.join(", ")} +${rest} more` : head.join(", ");
}

/** The terminal id a spawn tool's result names, when it does. */
export function spawnedTerminalId(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { id?: unknown; terminalId?: unknown; terminal?: { id?: unknown } };
    const id = parsed.id ?? parsed.terminalId ?? parsed.terminal?.id;
    return typeof id === "string" ? id : null;
  } catch {
    const match = /"(?:id|terminalId)"\s*:\s*"([^"]+)"/.exec(result);
    return match?.[1] ?? null;
  }
}
