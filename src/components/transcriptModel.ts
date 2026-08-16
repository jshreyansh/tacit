import type { TimelineEvent } from "../../shared/sessions";

/**
 * Shape of a conversation, independent of how it is drawn.
 *
 * Extracted from SessionReplayView so the Project Chat panel and the replay
 * view group a transcript identically. Two renderers computing "what is a
 * turn" separately would eventually disagree, and the disagreement would show
 * up as the same conversation reading differently depending on where you
 * opened it.
 *
 * Pure functions only — no React, no stores — so the grouping is testable
 * without mounting anything.
 */

export interface Turn {
  startIndex: number;
  userEvent: TimelineEvent | null;
  assistantEvents: TimelineEvent[];
}

/**
 * A tool call paired with its result.
 *
 * Pairing is by position within a run rather than by call id, because
 * TimelineEvent carries no call ids. Providers emit N calls followed by N
 * results in order, so index pairing is right in practice — but a heavily
 * batched turn where results arrive out of order can mislabel which call
 * failed. Worth remembering before treating a red tag as proof.
 */
export interface ToolGroupItem {
  tool: TimelineEvent;
  result?: TimelineEvent;
}

export interface AssistantNode {
  type: "text" | "thinking" | "tool_group" | "error";
  index: number;
  primary: TimelineEvent;
  items?: ToolGroupItem[];
}

/** Split a flat event list into turns, each opened by a user prompt. */
export function buildTurns(events: TimelineEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const event of events) {
    if (event.type === "user_prompt") {
      if (current) turns.push(current);
      current = { startIndex: event.index, userEvent: event, assistantEvents: [] };
    } else {
      if (!current) {
        current = { startIndex: event.index, userEvent: null, assistantEvents: [] };
      }
      current.assistantEvents.push(event);
    }
  }
  if (current) turns.push(current);
  return turns;
}

/**
 * Collapse a turn's events into what actually gets drawn.
 *
 * A contiguous run of tool calls becomes ONE node rather than a row per call.
 * An earlier rendering emitted one pill per tool and one row per result, which
 * flooded the transcript and buried the prose — the reader usually only needs
 * to know the agent did some lookups, and can open the group when they don't.
 */
export function buildAssistantNodes(events: TimelineEvent[]): AssistantNode[] {
  const nodes: AssistantNode[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];

    if (ev.type === "tool_use" || ev.type === "tool_result") {
      const tools: TimelineEvent[] = [];
      const results: TimelineEvent[] = [];
      let j = i;
      while (j < events.length) {
        const e = events[j];
        if (e.type === "tool_use") tools.push(e);
        else if (e.type === "tool_result") results.push(e);
        else break;
        j += 1;
      }
      if (tools.length > 0) {
        nodes.push({
          type: "tool_group",
          index: tools[0].index,
          primary: tools[0],
          items: tools.map((tool, k) => ({ tool, result: results[k] })),
        });
      }
      i = j;
      continue;
    }

    if (ev.type === "assistant_text") {
      nodes.push({ type: "text", index: ev.index, primary: ev });
    } else if (ev.type === "thinking") {
      nodes.push({ type: "thinking", index: ev.index, primary: ev });
    } else if (ev.type === "error") {
      nodes.push({ type: "error", index: ev.index, primary: ev });
    }
    // turn_complete is metadata, not content — dropped.
    i += 1;
  }
  return nodes;
}

/**
 * Display label for a tool call.
 *
 * Claude names arrive Pascal-cased ("Read", "Edit") and codex as snake_case;
 * both are readable and pass through. MCP tools arrive as
 * `mcp__<server>__<tool>`, so a canvas call would render as
 * `mcp__termcanvas-bridge__spawn_browser` — unreadable as a tag, and exactly
 * the set that matters when reading a workspace manager's work. The server is
 * dropped for display; the full identifier stays on the expanded call.
 */
export function toolVerb(toolName: string | undefined): string {
  if (!toolName) return "Tool";
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(toolName);
  if (mcp?.[1]) return mcp[1];
  return toolName;
}

/** The most recognisable anchor for a call — its file, else its first line. */
export function toolSubjectHint(event: TimelineEvent): string {
  if (event.filePath) {
    return event.filePath.split(/[\\/]/).filter(Boolean).pop() ?? event.filePath;
  }
  if (event.textPreview) {
    const firstLine = event.textPreview.split("\n", 1)[0].trim();
    if (firstLine.length > 80) return `${firstLine.slice(0, 80)}…`;
    return firstLine;
  }
  return "";
}

/**
 * "Read · Bash ×3 · +2 more" — duplicates collapsed with a count, capped at
 * three distinct names so the collapsed header stays on one line.
 */
export function summarizeToolNames(items: ToolGroupItem[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const item of items) {
    const name = toolVerb(item.tool.toolName);
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const first = order.slice(0, 3).map((name) => {
    const c = counts.get(name) ?? 1;
    return c > 1 ? `${name} ×${c}` : name;
  });
  const rest = order.length - 3;
  if (rest > 0) first.push(`+${rest} more`);
  return first.join(" · ");
}

/** Failed calls across a set of nodes, for a collapsed header's count. */
export function countFailures(nodes: AssistantNode[]): number {
  let failed = 0;
  for (const node of nodes) {
    if (node.type !== "tool_group" || !node.items) continue;
    for (const item of node.items) {
      if (item.result?.isError) failed += 1;
    }
  }
  return failed;
}
