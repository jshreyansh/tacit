import test from "node:test";
import assert from "node:assert/strict";
import { chatTitle, duration, filterChatHistory, projectName, relativeAge } from "../src/toolbar/chatHistoryModel";

const entry = (over: Partial<Parameters<typeof filterChatHistory>[0][number]>) => ({
  sessionId: "s",
  provider: "claude",
  projectDir: "/Users/me/tacit",
  filePath: "/x.jsonl",
  firstPrompt: "",
  startedAt: "2026-10-17T10:00:00Z",
  lastActivityAt: "2026-10-17T10:30:00Z",
  estimatedMessageCount: 4,
  ...over,
});

test("a session the manager briefing opened is named as the manager's", () => {
  assert.deepEqual(
    chatTitle("You've been assigned the workspace manager role for this canvas. Your tools come from…"),
    { kind: "manager" },
  );
});

test("a title is the first typed line, without pasted blocks or quote bars", () => {
  assert.deepEqual(chatTitle('<pasted_content id="a">big brief</pasted_content id="a">\n\nfix the login bug\nmore'), {
    kind: "text",
    text: "fix the login bug",
  });
  assert.deepEqual(chatTitle("▎ check the   deploy logs"), { kind: "text", text: "check the deploy logs" });
  assert.deepEqual(chatTitle('<pasted_content id="a">only a paste</pasted_content id="a">'), { kind: "pasted" });
  assert.deepEqual(chatTitle("   "), { kind: "untitled" });
  assert.deepEqual(chatTitle(null), { kind: "untitled" });
});

test("search matches every word across title, project and agent", () => {
  const list = [
    entry({ sessionId: "a", firstPrompt: "Fix the failing PR checks", provider: "codex" }),
    entry({ sessionId: "b", firstPrompt: "Compare vendor pricing", projectDir: "/work/research" }),
    entry({ sessionId: "c", firstPrompt: "You've been assigned the workspace manager role for this canvas." }),
  ];
  assert.deepEqual(filterChatHistory(list, "pr checks").map((e) => e.sessionId), ["a"]);
  assert.deepEqual(filterChatHistory(list, "research").map((e) => e.sessionId), ["b"]);
  assert.deepEqual(filterChatHistory(list, "codex").map((e) => e.sessionId), ["a"]);
  assert.deepEqual(filterChatHistory(list, "manager").map((e) => e.sessionId), ["c"]);
  assert.deepEqual(filterChatHistory(list, "  ").map((e) => e.sessionId), ["a", "b", "c"]);
  assert.deepEqual(filterChatHistory(list, "pricing codex"), []);
});

test("ages, durations and project names read as a person would say them", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  assert.equal(relativeAge("2026-10-17T11:59:40Z", now), "just now");
  assert.equal(relativeAge("2026-10-17T11:15:00Z", now), "45m ago");
  assert.equal(relativeAge("2026-10-15T12:00:00Z", now), "2d ago");
  assert.equal(relativeAge("not a date", now), "");
  assert.equal(duration("2026-10-17T10:00:00Z", "2026-10-17T10:00:30Z"), null);
  assert.equal(duration("2026-10-17T10:00:00Z", "2026-10-17T10:42:00Z"), "42m");
  assert.equal(duration("2026-10-17T10:00:00Z", "2026-10-17T12:05:00Z"), "2h 5m");
  assert.equal(projectName("/Users/me/auto-video-remotion-pipeline/"), "auto-video-remotion-pipeline");
});
