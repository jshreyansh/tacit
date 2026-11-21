import test from "node:test";
import assert from "node:assert/strict";
import { buildChatList, liveDot, matchRanges, searchChats } from "../src/toolbar/chatListModel";
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

const sources = [{ id: "p1", name: "tacit", path: "/code/tacit", worktreePaths: ["/code/tacit"] }];
const titleOf = (e: ChatHistoryEntry) => (e.firstPrompt.startsWith("You've been assigned") ? "Manager session" : e.firstPrompt.split("\n")[0]);

test("search matches what the row shows and what was typed, never the folder, agent or a briefing", () => {
  const entries = [
    past({ sessionId: "a", projectDir: "/code/tacit", firstPrompt: "hey" }),
    past({ sessionId: "b", projectDir: "/code/tacit", firstPrompt: "You've been assigned the workdesk manager role. Help the user." }),
    past({ sessionId: "c", projectDir: "/code/tacit", provider: "claude", firstPrompt: "Fix the footer\nthen ship the header too" }),
  ];
  const ids = (q: string) => searchChats(sources, [], entries, { query: q, pastTitle: titleOf }).map((h) => (h.kind === "past" ? h.entry.sessionId : h.item.terminalId));
  assert.deepEqual(ids("he").sort(), ["a", "c"]);
  assert.deepEqual(ids("tacit"), []);
  assert.deepEqual(ids("claude"), []);
  assert.deepEqual(ids("help"), []);
  assert.deepEqual(ids("manager"), ["b"]);
  assert.deepEqual(ids("header"), ["c"]);
  assert.deepEqual(ids("   "), []);
});

test("search results: live first, needing you on top, then finished newest first, each with its folder", () => {
  const hits = searchChats(
    sources,
    [live({ terminalId: "t1", title: "Hero copy", state: "idle", sessionId: "s-live" }), live({ terminalId: "t2", title: "Hero image", state: "attention", projectName: "tacit" }), live({ terminalId: "m", title: "Hero manager" })],
    [
      past({ sessionId: "old", projectDir: "/code/tacit", firstPrompt: "hero old", lastActivityAt: "2026-11-01T00:00:00Z" }),
      past({ sessionId: "new", projectDir: "/elsewhere/site", firstPrompt: "hero new", lastActivityAt: "2026-11-10T00:00:00Z" }),
      past({ sessionId: "s-live", projectDir: "/code/tacit", firstPrompt: "hero again" }),
    ],
    { query: "hero", hidden: new Set(["m"]), pastTitle: titleOf },
  );
  assert.deepEqual(
    hits.map((h) => (h.kind === "live" ? `live:${h.item.terminalId}` : `past:${h.entry.sessionId}:${h.folder}`)),
    ["live:t2", "live:t1", "past:new:site", "past:old:tacit"],
  );
});

test("matched words are found in the title, any case, overlaps merged", () => {
  assert.deepEqual(matchRanges("Hello there", "he"), [[0, 2], [7, 9]]);
  assert.deepEqual(matchRanges("Manager session", "man ager"), [[0, 7]]);
  assert.deepEqual(matchRanges("abc", "zz"), []);
});
