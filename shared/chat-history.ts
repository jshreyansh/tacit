import type { ChatEvent } from "./chat-events";
import { splitMentions } from "./chat-attachments";
import type { TimelineEvent } from "./sessions";

/**
 * A session's history, read from the agent's own record of it (Claude's
 * session file, Codex's rollout) through the replay timeline, as chat
 * events. The chat opens on this, so what was said before it, in the
 * terminal or before a restart, is there; live events then add to it.
 *
 * The timeline keeps previews rather than full tool inputs, so a past tool
 * call shows its command, file or arguments, not every field. Results pair
 * with calls in order, as both agents write them.
 */

function toolInput(preview: string): Record<string, unknown> {
  const text = preview.trim();
  if (text.startsWith("$ ")) return { command: text.slice(2) };
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Arguments cut off at the preview limit: shown as text below.
    }
  }
  if (text && !/\s/.test(text) && /[\\/]/.test(text)) return { file_path: text };
  return text ? { description: text } : {};
}

/**
 * Codex models that call tools from code write `tools.<name>({...})` inside
 * one `exec` call; the chat shows the tool it called, as it did live, with
 * the string fields of its (JavaScript, not JSON) argument.
 */
function unwrapCodeCall(preview: string): { name: string; input: Record<string, unknown> } | null {
  const call = /\btools\.([A-Za-z0-9_]+)\(\s*(\{[\s\S]*?\})?/.exec(preview);
  if (!call) return null;
  const input: Record<string, unknown> = {};
  for (const field of (call[2] ?? "").matchAll(/["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      input[field[1]] = JSON.parse(`"${field[2]}"`);
    } catch {
      input[field[1]] = field[2];
    }
  }
  if (call[1] === "exec_command") return { name: "Shell", input: { command: input.cmd ?? input.command ?? "" } };
  return { name: call[1], input };
}

const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;

/**
 * A session carried over into Codex from another agent keeps that agent's
 * tool calls and results as text in its replies:
 *
 *     [external_agent_tool_call: Bash]
 *     description: Wait 8 seconds
 *     command: sleep 8 && echo slept
 *     [/external_agent_tool_call]
 *     [external_agent_tool_result]          (or `[external_agent_tool_result: error]`)
 *     slept
 *     [/external_agent_tool_result]
 *
 * Split back into what they were: text, a tool call with its fields, its result.
 */
export type CarriedPart =
  | { kind: "text"; text: string }
  | { kind: "call"; name: string; input: Record<string, unknown> }
  | { kind: "result"; isError: boolean; output: string };

const CARRIED = /\[external_agent_tool_(call|result)(?::\s*([^\]\n]*))?\]\n?([\s\S]*?)(?:\n?\[\/external_agent_tool_\1\]|$)/g;

/** `key: value` lines; a line that doesn't start a field continues the one before. */
function carriedFields(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  let last: string | null = null;
  for (const line of body.split("\n")) {
    const field = /^([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (field && !(field[1] in input)) {
      last = field[1];
      input[last] = field[2];
    } else if (last) {
      input[last] = `${input[last]}\n${line}`;
    } else if (line.trim()) {
      input.description = line;
      last = "description";
    }
  }
  return input;
}

export function splitCarriedTools(text: string): CarriedPart[] {
  if (!text.includes("[external_agent_tool_")) return [{ kind: "text", text }];
  const parts: CarriedPart[] = [];
  let at = 0;
  for (const m of text.matchAll(CARRIED)) {
    const before = text.slice(at, m.index).trim();
    if (before) parts.push({ kind: "text", text: before });
    if (m[1] === "call") {
      const input = carriedFields(m[3]);
      // Read, Edit and Write name their file `file`; the chat reads `file_path`, as Claude writes it.
      if (typeof input.file === "string" && !("file_path" in input)) {
        input.file_path = input.file;
        delete input.file;
      }
      parts.push({ kind: "call", name: m[2]?.trim() || "tool", input });
    }
    else parts.push({ kind: "result", isError: m[2]?.trim() === "error", output: m[3] });
    at = m.index + m[0].length;
  }
  const after = text.slice(at).trim();
  if (after) parts.push({ kind: "text", text: after });
  return parts;
}

export function timelineToChatEvents(timeline: readonly TimelineEvent[], idPrefix = "h"): ChatEvent[] {
  const out: ChatEvent[] = [];
  const openCalls: string[] = [];
  let inTurn = false;
  let block = 0;
  const endTurn = (outcome: "success" | "interrupted" = "success") => {
    if (!inTurn) return;
    // A call the record never answered (the turn was stopped) closes with it.
    for (const callId of openCalls.splice(0)) out.push({ kind: "tool_result", toolCallId: callId, isError: false, output: "" });
    out.push({ kind: "turn_ended", outcome });
    inTurn = false;
  };
  for (const ev of timeline) {
    const key = `${idPrefix}${block}`;
    switch (ev.type) {
      case "user_prompt":
        // Claude records a stop as a message from the person; it's the turn ending.
        if (INTERRUPT_MARKER.test(ev.textPreview.trim())) {
          endTurn("interrupted");
          break;
        }
        endTurn();
        {
          // Files sent with it are mentions on its last lines.
          const { text, attachments } = splitMentions(ev.textPreview);
          out.push({ kind: "user_message", id: `${idPrefix}u${ev.index}`, text, at: ev.timestamp, ...(attachments.length ? { attachments } : {}) });
        }
        inTurn = true;
        break;
      case "assistant_text":
        if (!ev.textPreview.trim()) break;
        inTurn = true;
        // Tool calls carried over from another agent, written as text, show as the calls they were.
        splitCarriedTools(ev.textPreview).forEach((part, i) => {
          block += 1;
          const partKey = `${idPrefix}${block}`;
          if (part.kind === "text") {
            out.push({ kind: "block_start", key: partKey, block: "text" }, { kind: "block_done", key: partKey, text: part.text });
          } else if (part.kind === "call") {
            const callId = `${idPrefix}x${ev.index}-${i}`;
            openCalls.push(callId);
            out.push({ kind: "block_start", key: partKey, block: "tool", toolCallId: callId, toolName: part.name }, { kind: "block_done", key: partKey, input: part.input });
          } else {
            const callId = openCalls.shift();
            if (callId) out.push({ kind: "tool_result", toolCallId: callId, isError: part.isError, output: part.output });
          }
        });
        break;
      case "thinking":
        // Codex keeps its reasoning encrypted: nothing to show.
        if (!ev.textPreview.trim()) break;
        inTurn = true;
        block += 1;
        out.push({ kind: "block_start", key, block: "thinking" }, { kind: "block_done", key, text: ev.textPreview });
        break;
      case "tool_use": {
        inTurn = true;
        block += 1;
        const callId = `${idPrefix}c${ev.index}`;
        openCalls.push(callId);
        const unwrapped = ev.toolName === "exec" ? unwrapCodeCall(ev.textPreview) : null;
        const input = unwrapped?.input ?? (ev.filePath && !ev.textPreview ? { file_path: ev.filePath } : toolInput(ev.textPreview));
        out.push(
          { kind: "block_start", key, block: "tool", toolCallId: callId, toolName: unwrapped?.name ?? ev.toolName ?? "tool" },
          { kind: "block_done", key, input },
        );
        break;
      }
      case "tool_result": {
        const callId = openCalls.shift();
        if (callId) out.push({ kind: "tool_result", toolCallId: callId, isError: !!ev.isError, output: ev.textPreview });
        break;
      }
      case "turn_complete":
        endTurn();
        break;
      case "error":
        break;
    }
  }
  endTurn();
  return out;
}
