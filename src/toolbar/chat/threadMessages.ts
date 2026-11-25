import type { ChatMessage, ChatPart, ChatTranscript } from "../../../shared/chat-transcript";
import { UNHELD_PREFIX } from "./attachmentPreview";

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
  | { readonly type: "data-turn-note"; readonly data: { readonly kind: "interrupted" | "error"; readonly error?: string } }
  /** A line between messages: earlier turns summarized to make room. */
  | { readonly type: "data-compacted"; readonly data: { readonly preTokens?: number } }
  | { readonly type: "data-briefing"; readonly data: { readonly text: string } };

export interface ThreadAttachment {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly status: { readonly type: "complete" };
  readonly content: readonly { readonly type: "image"; readonly image: string }[];
}

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
  /** Files sent with a user message: an image carries its picture. */
  readonly attachments?: readonly ThreadAttachment[];
  /** `steered`: a message sent mid-turn. `note`: a line, not a reply. */
  readonly metadata?: { readonly custom: { readonly steered?: boolean; readonly note?: boolean } };
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
      // A finished thought with nothing in it (Codex's are encrypted) is noise.
      return part.done && !part.text.trim() ? null : { type: "reasoning", text: part.text };
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
      return {
        id: m.id,
        role: "user",
        content: m.text ? [{ type: "text", text: m.text }] : [],
        createdAt: new Date(m.at),
        ...(m.attachments?.length
          ? {
              attachments: m.attachments.map((a, i) => ({
                // The held file's id, so the tile can open it.
                id: a.id ?? `${UNHELD_PREFIX}${m.id}-${i}`,
                type: a.kind,
                name: a.name,
                status: { type: "complete" as const },
                content: a.preview ? [{ type: "image" as const, image: a.preview }] : [],
              })),
            }
          : {}),
        ...(m.steered ? { metadata: { custom: { steered: true } } } : {}),
      };
    }
    if (m.role === "note") {
      return {
        id: m.id,
        role: "assistant",
        content:
          m.kind === "briefing"
            ? [{ type: "data-briefing", data: { text: m.text ?? "" } }]
            : [{ type: "data-compacted", data: m.preTokens !== undefined ? { preTokens: m.preTokens } : {} }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: { note: true } },
      };
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

export interface CanvasToolView {
  kind: "draw" | "change" | "delete";
  title: string;
  /** The drawing it made, or the thing it did, as the result names it. */
  id: string | null;
  /** It waits on you: nothing has changed yet. */
  asked: boolean;
}

/** A Tacit tool that draws, and what to show for it. */
export function canvasTool(toolName: string, args: JsonObject, result?: unknown): CanvasToolView | null {
  const tool = /^mcp__tacit__(.+)$/.exec(toolName)?.[1];
  const kind = ({ draw: "draw", change_drawing: "change", delete_drawing: "delete" } as const)[tool ?? ""];
  if (!kind) return null;
  const text = typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result);
  const id = kind === "draw" ? /\(id ([\w-]+)\)/.exec(text)?.[1] : /\((op-[\w-]+)\)/.exec(text)?.[1];
  return { kind, title: typeof args.title === "string" ? args.title.slice(0, 140) : "", id: id ?? null, asked: kind !== "draw" && /^Not yet: /.test(text) };
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

/** A Tacit task tool, and what to show for it. */
export type TaskToolView =
  | { kind: "create"; title: string; steps: number }
  | { kind: "ask"; taskId: string; question: string; choices: string[] }
  | { kind: "update" | "take" | "finish" | "suggest" | "hand"; taskId: string; text: string | null }
  | { kind: "list" | "read" };

export function taskTool(toolName: string, args: JsonObject): TaskToolView | null {
  const tool = /^mcp__tacit__(.+)$/.exec(toolName)?.[1];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const taskId = str(args.id);
  switch (tool) {
    case "create_task":
      return { kind: "create", title: str(args.title), steps: Array.isArray(args.parts) ? args.parts.length : 0 };
    case "ask_user":
    case "ask_approval":
      return {
        kind: "ask",
        taskId,
        question: str(args.question) || str(args.what),
        choices: Array.isArray(args.options) ? args.options.map((o) => (typeof o === "string" ? o : str((o as JsonObject | null)?.label))).filter(Boolean) : [],
      };
    case "request_agent":
      return { kind: "ask", taskId, question: [str(args.open) || str(args.to), str(args.message)].filter(Boolean).join(": "), choices: [] };
    case "report_part":
      return { kind: "update", taskId, text: str(args.say) || str(args.state) || null };
    case "take_part":
      return { kind: "take", taskId, text: taskId };
    case "finish_task":
      return { kind: "finish", taskId, text: str(args.summary).split("\n")[0] || null };
    case "suggest_task_text":
      return { kind: "suggest", taskId, text: null };
    case "hand_over_task":
      return { kind: "hand", taskId, text: taskId };
    case "get_task":
      return { kind: "read" };
    case "list_tasks":
      return { kind: "list" };
    default:
      return null;
  }
}

/** The task id a create_task result names. */
export function createdTaskId(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { task?: { id?: unknown } };
    return typeof parsed.task?.id === "string" ? parsed.task.id : null;
  } catch {
    return /"id"\s*:\s*"([a-z0-9][a-z0-9-]*)"/.exec(result)?.[1] ?? null;
  }
}

/** The answers in AskUserQuestion's result, by question: `"Q"="A", "Q2"="B"`. */
export function askedAnswers(result: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!result) return out;
  for (const m of result.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Sent (or briefed) and nothing back yet: the wait before the agent's first event. */
export function isAwaitingReply(t: Pick<ChatTranscript, "messages" | "running" | "failure">): boolean {
  const last = t.messages[t.messages.length - 1];
  return t.running && !t.failure && (last?.role === "user" || (last?.role === "note" && last.kind === "briefing"));
}

/** A Tacit memory tool, and what to show for it. */
export type MemoryToolView =
  | {
      kind: "remember";
      name: string;
      description: string;
      scope: string;
      /** Known once it ran: added, updated, or skipped as a repeat. */
      action: "add" | "update" | "skip" | null;
      status: "active" | "pending" | null;
      filePath: string | null;
      replaces: string | null;
    }
  | { kind: "forget"; name: string; scope: string }
  | { kind: "handover" }
  | { kind: "recall"; query: string };

function resultObject(result: unknown): Record<string, unknown> | null {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    // MCP results come as content blocks; the JSON is in the first text one.
    if (Array.isArray(r.content)) {
      const text = (r.content as Array<{ type?: unknown; text?: unknown }>).find((c) => c?.type === "text" && typeof c.text === "string")?.text;
      return typeof text === "string" ? resultObject(text) : null;
    }
    return r;
  }
  if (typeof result !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed && typeof parsed === "object" ? resultObject(parsed) : null;
  } catch {
    const json = /\{[\s\S]*\}/.exec(result)?.[0];
    if (!json || json === result) return null;
    return resultObject(json);
  }
}

export function memoryTool(toolName: string, args: JsonObject, result?: unknown): MemoryToolView | null {
  const tool = /^mcp__tacit__(.+)$/.exec(toolName)?.[1];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "remember": {
      const r = resultObject(result);
      const action = r?.action === "add" || r?.action === "update" || r?.action === "skip" ? r.action : null;
      const status = r?.status === "active" || r?.status === "pending" ? r.status : null;
      return {
        kind: "remember",
        name: str(r?.name) || str(args.name),
        description: str(args.description) || str(args.name),
        scope: str(r?.scope) || str(args.scope) || "folder",
        action,
        status,
        filePath: typeof r?.filePath === "string" ? r.filePath : null,
        replaces: str(args.replaces) || null,
      };
    }
    case "forget":
      return { kind: "forget", name: str(args.name), scope: str(args.scope) || "folder" };
    case "update_handover":
      return { kind: "handover" };
    case "recall":
    case "query_memory":
      return { kind: "recall", query: str(args.query) };
    default:
      return null;
  }
}
