import type { ChatEvent } from "./chat-events";
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
        out.push({ kind: "user_message", id: `${idPrefix}u${ev.index}`, text: ev.textPreview, at: ev.timestamp });
        inTurn = true;
        break;
      case "assistant_text":
        if (!ev.textPreview.trim()) break;
        inTurn = true;
        block += 1;
        out.push({ kind: "block_start", key, block: "text" }, { kind: "block_done", key, text: ev.textPreview });
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
