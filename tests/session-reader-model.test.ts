import test from "node:test";
import assert from "node:assert/strict";
import {
  agentOfSessionFile,
  filterTurns,
  linkNodeIds,
  messageCount,
  readerTitle,
  resumeCommand,
  turnsOf,
} from "../src/toolbar/sessionReaderModel";
import type { TimelineEvent } from "../shared/sessions";

function ev(index: number, type: TimelineEvent["type"], textPreview: string, timestamp = `2026-10-11T18:${String(30 + index).padStart(2, "0")}:00Z`): TimelineEvent {
  return { index, timestamp, type, textPreview };
}

const events: TimelineEvent[] = [
  ev(0, "user_prompt", "You've been assigned the workspace manager role for this canvas. Your tools come from…"),
  ev(1, "assistant_text", "Ready."),
  ev(2, "user_prompt", "<pasted_content>a log</pasted_content>\nRun the approval test twice"),
  ev(3, "tool_use", "$ touch a.txt"),
  ev(4, "tool_result", ""),
  ev(5, "assistant_text", "Done twice."),
  ev(6, "user_prompt", "send on opencode a hi"),
  ev(7, "assistant_text", "Sent."),
];

test("the agent comes from where its session files live, and so does the resume command", () => {
  assert.equal(agentOfSessionFile("/home/me/.claude/projects/-repo/abc.jsonl"), "claude");
  assert.equal(agentOfSessionFile("C:\\Users\\me\\.codex\\sessions\\2026\\10\\11\\rollout-x.jsonl"), "codex");
  assert.equal(agentOfSessionFile("/home/me/.local/share/opencode/opencode.db"), null);
  assert.equal(resumeCommand("claude", "abc"), "claude --resume abc");
  assert.equal(resumeCommand("codex", "abc"), "codex resume abc");
});

test("a manager session is named as one, and its turns list the briefing by name, not its text", () => {
  assert.deepEqual(readerTitle(events), { kind: "manager" });
  const turns = turnsOf(events, "r");
  assert.deepEqual(
    turns.map((t) => ({ id: t.messageId, text: t.text, briefing: t.briefing, n: t.promptIndex })),
    [
      { id: "ru0", text: "", briefing: true, n: 0 },
      { id: "ru2", text: "Run the approval test twice", briefing: false, n: 1 },
      { id: "ru6", text: "send on opencode a hi", briefing: false, n: 2 },
    ],
  );
  assert.deepEqual(filterTurns(turns, "OPENCODE hi").map((t) => t.messageId), ["ru6"]);
  assert.equal(filterTurns(turns, "").length, 3);
  assert.equal(messageCount(events), 6);
});

test("terminal ids in an agent's text become chips by name; closed ones say so; code blocks are left alone", () => {
  const describe = (id: string) => (id === "1792004559435-3" ? { label: "Opencode", open: true } : { label: "closed terminal", open: false });
  const text = "I sent hi to `1792004559435-3`, not 1792234561950-1.\n```\nid 1792004559435-3\n```";
  const out = linkNodeIds(text, describe);
  assert.ok(out.includes('[Opencode](#tacit-node=1792004559435-3 "1792004559435-3")'));
  assert.ok(out.includes('[closed terminal](#tacit-node=1792234561950-1 "1792234561950-1 (closed)")'));
  assert.ok(out.endsWith("```\nid 1792004559435-3\n```"));
  // Not an id: too short, or no count.
  assert.equal(linkNodeIds("pid 12345-1 and 1792004559435", describe), "pid 12345-1 and 1792004559435");
  // A name with brackets can't break the link.
  assert.ok(linkNodeIds("1792004559435-3", () => ({ label: "a [b]", open: true })).startsWith("[a \\[b\\]]"));
});

test("a preview line reads terminal ids as names and drops Markdown's marks", async () => {
  const { previewLine } = await import("../src/toolbar/sessionReaderModel");
  const names: Record<string, string> = { "1792010924415-1": "claude · gym plan" };
  assert.equal(
    previewLine("**Done.** Worker `1792010924415-1` is on it; see [the plan](file:///p.md).\n\n- next", (id) => names[id] ?? null),
    "Done. Worker claude · gym plan is on it; see the plan. next",
  );
  // A closed terminal keeps its id; long text is cut.
  assert.equal(previewLine("ask 1792000000000-3", () => null), "ask 1792000000000-3");
  assert.equal(previewLine("x".repeat(200), () => null, 10), "xxxxxxxxx…");
});
