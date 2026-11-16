import test from "node:test";
import assert from "node:assert/strict";
import { buildChatList, liveDot } from "../src/toolbar/chatListModel";
import type { CanvasTerminalItem } from "../src/components/sessionPanelModel";
import type { ChatHistoryEntry } from "../src/toolbar/chatHistoryModel";

const live = (over: Partial<CanvasTerminalItem>): CanvasTerminalItem => ({
  terminalId: "t1",
  projectId: "p1",
  projectName: "lantern",
  worktreeId: "w1",
  worktreeName: "main",
  title: "Testimonials strip",
  locationLabel: "lantern · main",
  focused: false,
  state: "active",
  ...over,
});

const past = (over: Partial<ChatHistoryEntry>): ChatHistoryEntry => ({
  sessionId: "s1",
  provider: "claude",
  projectDir: "/code/lantern",
  filePath: "/x/s1.jsonl",
  firstPrompt: "Tighten the hero copy",
  startedAt: "2026-11-16T10:00:00Z",
  lastActivityAt: "2026-11-16T10:30:00Z",
  estimatedMessageCount: 4,
  ...over,
});

const folders = [
  { id: "p1", name: "lantern", path: "/code/lantern", worktreePaths: ["/code/lantern", "/code/lantern-wt"] },
  { id: "p2", name: "tacit", path: "/code/tacit", worktreePaths: ["/code/tacit"] },
];

test("chats are grouped by folder, live first, finished newest first", () => {
  const list = buildChatList(
    folders,
    [live({}), live({ terminalId: "t2", projectId: "p2", title: "Mask secrets" })],
    [
      past({ sessionId: "old", lastActivityAt: "2026-11-01T00:00:00Z" }),
      past({ sessionId: "new", projectDir: "/code/lantern-wt", lastActivityAt: "2026-11-15T00:00:00Z" }),
    ],
  );
  assert.deepEqual(list.map((f) => f.name), ["lantern", "tacit"]);
  assert.deepEqual(list[0].live.map((i) => i.terminalId), ["t1"]);
  assert.deepEqual(list[0].past.map((e) => e.sessionId), ["new", "old"]);
  assert.deepEqual(list[1].live.map((i) => i.terminalId), ["t2"]);
});

test("the manager and shells are left out, and a running session is listed once", () => {
  const list = buildChatList(
    folders,
    [live({ terminalId: "mgr" }), live({ terminalId: "shell" }), live({ terminalId: "t1", sessionId: "s-live" })],
    [past({ sessionId: "s-live" }), past({ sessionId: "s-done" })],
    { hidden: new Set(["mgr", "shell"]) },
  );
  assert.deepEqual(list[0].live.map((i) => i.terminalId), ["t1"]);
  assert.deepEqual(list[0].past.map((e) => e.sessionId), ["s-done"]);
});

test("history from a directory that isn't a folder here gets its own group; empty folders are dropped", () => {
  const list = buildChatList(folders, [], [past({ projectDir: "/old/termcanvas" })]);
  assert.deepEqual(list.map((f) => [f.name, f.past.length]), [["termcanvas", 1]]);
});

test("search narrows both live and finished chats", () => {
  const list = buildChatList(
    folders,
    [live({ title: "Testimonials strip" }), live({ terminalId: "t2", title: "Footer links" })],
    [past({ firstPrompt: "Tighten the hero copy" }), past({ sessionId: "s2", firstPrompt: "Footer spacing" })],
    { query: "footer" },
  );
  assert.deepEqual(list[0].live.map((i) => i.title), ["Footer links"]);
  assert.deepEqual(list[0].past.map((e) => e.sessionId), ["s2"]);
});

test("a live row's dot: running, needs you, or none", () => {
  assert.equal(liveDot("active"), "run");
  assert.equal(liveDot("attention"), "need");
  assert.equal(liveDot("idle"), null);
  assert.equal(liveDot("done"), null);
});

test("history recorded with a bare folder name joins the folder of that name", () => {
  const list = buildChatList(folders, [], [past({ projectDir: "tacit" })]);
  assert.deepEqual(list.map((f) => [f.key, f.past.length]), [["p2", 1]]);
});
