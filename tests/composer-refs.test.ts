import test from "node:test";
import assert from "node:assert/strict";
import { chatCommands, filterRefs, replaceTrigger, triggerAt, workdeskRefs } from "../src/toolbar/chat/composerRefs";

test("@ after a space or at the start opens a mention; / as the first word opens commands", () => {
  assert.deepEqual(triggerAt("ask @foo", 8), { kind: "mention", query: "foo", start: 4 });
  assert.deepEqual(triggerAt("@", 1), { kind: "mention", query: "", start: 0 });
  assert.equal(triggerAt("me@example", 10), null);
  assert.deepEqual(triggerAt("/comp", 5), { kind: "command", query: "comp", start: 0 });
  assert.equal(triggerAt("run /comp", 9), null);
  assert.equal(triggerAt("/compact now", 12), null);
});

test("picking replaces what was typed and puts the caret after it", () => {
  assert.deepEqual(replaceTrigger("ask @fo please", 4, 7, '@"Fix footer" '), { text: 'ask @"Fix footer"  please', caret: 18 });
});

test("the workdesk's chats, pages, files and tasks become things to mention", () => {
  const refs = workdeskRefs({
    terminals: [
      { id: "t1", title: "Fix footer", type: "claude", folder: "tacit", agent: true },
      { id: "t2", title: "zsh", type: "shell", folder: "tacit", agent: false },
    ],
    pages: [{ id: "b1", title: "Lantern", url: "http://localhost:5173" }],
    files: [{ id: "f1", path: "/code/tacit/README.md" }],
    tasks: [{ id: "p1", title: "Launch Brewline", folder: "tacit" }],
  });
  assert.deepEqual(refs.map((r) => [r.kind, r.label]), [
    ["chat", "Fix footer"],
    ["terminal", "zsh"],
    ["page", "Lantern"],
    ["file", "README.md"],
    ["task", "Launch Brewline"],
  ]);
  assert.deepEqual(refs[0].insert, { text: '@"Fix footer"' });
  assert.deepEqual(refs[1].insert, { text: "@zsh" });
  assert.deepEqual(refs[2].insert, { text: "http://localhost:5173" });
  assert.deepEqual(refs[3].insert, { path: "/code/tacit/README.md" });
  assert.deepEqual(refs[4].insert, { text: 'the task "Launch Brewline"' });
  assert.deepEqual(filterRefs(refs, "foot").map((r) => r.key), ["terminal:t1"]);
  assert.deepEqual(filterRefs(refs, "tacit launch").map((r) => r.key), ["task:p1"]);
});

test("a chat offers only the commands that work through its agent's SDK", () => {
  assert.deepEqual(chatCommands("claude", "").map((c) => c.command), ["/compact", "/clear", "/init", "/review"]);
  assert.deepEqual(chatCommands("claude", "comp").map((c) => c.command), ["/compact"]);
  assert.deepEqual(chatCommands("codex", "").map((c) => c.command), ["/compact"]);
  assert.deepEqual(chatCommands("opencode", ""), []);
});
