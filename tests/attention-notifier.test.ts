import test from "node:test";
import assert from "node:assert/strict";

import { AttentionNotifier } from "../electron/attention-notifier.ts";
import { DEFAULT_ATTENTION_PREFS, sanitizeAttentionPrefs, type AttentionNotice } from "../shared/attention.ts";

function setup(options: { focused?: boolean; workers?: string[]; harness?: Record<string, string> } = {}) {
  const state = { focused: options.focused ?? false, now: 1_000 };
  const requested: AttentionNotice[] = [];
  const shown: Array<{ id: string; title: string; body: string }> = [];
  const badges: number[] = [];
  const harness: Record<string, string> = { a: "claude", b: "codex", sh: "shell", ...options.harness };
  const notifier = new AttentionNotifier({
    isFocused: () => state.focused,
    harnessOf: (id) => harness[id] ?? null,
    startedByAgent: (id) => (options.workers ?? []).includes(id),
    requestText: (notice) => requested.push(notice),
    show: (n) => shown.push(n),
    setBadge: (count) => badges.push(count),
    now: () => state.now,
  });
  return { notifier, state, requested, shown, badges };
}

const alive = { pty_alive: true };
const waitingSnap = { pty_alive: true, turn_state: "awaiting_input" };

test("an agent waiting, finishing or failing notifies while Tacit isn't focused", () => {
  const { notifier, requested } = setup();
  notifier.observeTerminal("a", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  notifier.observeTerminal("a", alive, [{ kind: "errored", detail: "API error 500" }]);
  assert.deepEqual(
    requested.map((n) => [n.kind, n.target]),
    [
      ["waiting", { kind: "terminal", terminalId: "a" }],
      ["finished", { kind: "terminal", terminalId: "b" }],
      ["failed", { kind: "terminal", terminalId: "a" }],
    ],
  );
  assert.equal(requested[2].detail, "API error 500");
});

test("while Tacit is focused it's a toast, which can't become a system notification", () => {
  const { notifier, requested, shown } = setup({ focused: true });
  notifier.observeTerminal("a", waitingSnap, [{ kind: "waiting_for_human" }]);
  notifier.observeTerminal("a", alive, [{ kind: "turn_completed" }]);
  notifier.observeTask("/repo", { id: "t1", title: "T", kind: "task", status: "needs_you", ask: { reason: "?", at: "1" } });
  assert.deepEqual(requested.map((n) => [n.kind, n.surface]), [
    ["waiting", "toast"],
    ["finished", "toast"],
    ["needs_you", "toast"],
  ]);
  assert.equal(notifier.answer(requested[0].id, { title: "Hi" }), false);
  assert.equal(shown.length, 0);
});

test("a toast seen in Tacit doesn't use up the notification for when the person has left", () => {
  const { notifier, requested, state } = setup({ focused: true });
  notifier.observeTerminal("a", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  notifier.observeTerminal("a", alive, []);
  notifier.observeTerminal("a", waitingSnap, [{ kind: "waiting_for_human" }]);
  assert.equal(requested.length, 1, "a second approval in the same turn doesn't toast again");
  state.focused = false;
  notifier.observeTerminal("a", alive, []);
  notifier.observeTerminal("a", waitingSnap, [{ kind: "waiting_for_human" }]);
  assert.deepEqual(requested.map((n) => n.surface), ["toast", "banner"]);
});

test("a prompt the person typed on a manager's worker notifies at that turn's end, and only that turn's", () => {
  const { notifier, requested } = setup({ workers: ["b"] });
  notifier.observeTerminal("b", alive, [{ kind: "turn_started" }]);
  notifier.promptTyped("b");
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.deepEqual(requested.map((n) => n.kind), ["finished"]);

  notifier.observeTerminal("b", alive, [{ kind: "turn_started" }]);
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.equal(requested.length, 1, "the manager's next turn there stays quiet");

  notifier.observeTerminal("b", alive, [{ kind: "turn_started" }]);
  notifier.promptTyped("b");
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed", detail: "aborted" }]);
  notifier.observeTerminal("b", alive, [{ kind: "turn_started" }]);
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.equal(requested.length, 1, "a typed turn the person stopped doesn't carry over to the next");

  notifier.configure({ prefs: { ...DEFAULT_ATTENTION_PREFS, finished: false }, needsYouTasks: 0 });
  notifier.observeTerminal("b", alive, [{ kind: "turn_started" }]);
  notifier.promptTyped("b");
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.equal(requested.length, 1, "turning finished off still wins");
});

test("nothing notifies for a shell or for a turn the person stopped", () => {
  const { notifier, requested } = setup();
  notifier.observeTerminal("sh", alive, [{ kind: "turn_completed" }]);
  notifier.observeTerminal("unknown-id", alive, [{ kind: "turn_completed" }]);
  notifier.observeTerminal("a", alive, [{ kind: "turn_completed", detail: "aborted" }]);
  assert.equal(requested.length, 0);
});

test("settings turn each kind off, and workers' finished turns are off by default", () => {
  const { notifier, requested } = setup({ workers: ["b"] });
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.equal(requested.length, 0, "a manager's worker finishing doesn't notify by default");
  notifier.observeTerminal("b", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  assert.equal(requested.length, 1, "a worker waiting on the person still does");

  notifier.configure({ prefs: { ...DEFAULT_ATTENTION_PREFS, workersFinished: true }, needsYouTasks: 0 });
  notifier.observeTerminal("b", alive, [{ kind: "turn_completed" }]);
  assert.equal(requested.length, 2);

  notifier.configure({
    prefs: { waiting: false, finished: false, failed: false, needsYou: false, workersFinished: true },
    needsYouTasks: 0,
  });
  notifier.observeTerminal("a", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  notifier.observeTerminal("a", alive, [{ kind: "turn_completed" }]);
  notifier.observeTerminal("a", alive, [{ kind: "turn_started" }, { kind: "errored", detail: "x" }]);
  notifier.observeTask("/repo", { id: "t1", title: "T", kind: "task", status: "needs_you", ask: { reason: "?", at: "1" } });
  assert.equal(requested.length, 2);
});

test("one notification per kind per turn; a new turn can notify again", () => {
  const { notifier, requested } = setup();
  notifier.observeTerminal("a", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  notifier.observeTerminal("a", alive, []);
  notifier.observeTerminal("a", waitingSnap, [{ kind: "waiting_for_human" }]);
  assert.equal(requested.length, 1, "a second approval in the same turn doesn't notify again");
  notifier.observeTerminal("a", alive, [{ kind: "turn_completed" }]);
  notifier.observeTerminal("a", waitingSnap, [{ kind: "turn_started" }, { kind: "waiting_for_human" }]);
  assert.deepEqual(requested.map((n) => n.kind), ["waiting", "finished", "waiting"]);
});

test("a task notifies once per question when it moves to Needs you", () => {
  const { notifier, requested } = setup();
  const ask = { reason: "Which plan is Most popular?", choices: ["Regular"], at: "2026-11-03T10:00:00Z" };
  const task = { id: "launch-1", title: "Launch", kind: "task", status: "needs_you", ask };
  notifier.observeTask("/repo", task);
  notifier.observeTask("/repo", { ...task, title: "Launch!" });
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0].target, { kind: "task", repo: "/repo", taskId: "launch-1" });
  assert.equal(requested[0].question, "Which plan is Most popular?");
  assert.equal(requested[0].detail, "Launch");

  notifier.observeTask("/repo", { ...task, status: "in_progress", ask: undefined });
  notifier.observeTask("/repo", { ...task, ask: { ...ask, at: "2026-11-03T11:00:00Z" } });
  assert.equal(requested.length, 2, "a new question after an answer notifies again");

  notifier.observeTask("/repo", { id: "note-1", title: "N", kind: "note", status: "needs_you", ask });
  notifier.observeTask("/repo", null);
  assert.equal(requested.length, 2);
});

test("the badge counts agents waiting and tasks needing the person, and clears as they're answered", () => {
  const { notifier, badges } = setup({ focused: true });
  notifier.observeTerminal("a", waitingSnap, [{ kind: "waiting_for_human" }]);
  notifier.observeTerminal("b", waitingSnap, [{ kind: "waiting_for_human" }]);
  notifier.observeTerminal("sh", waitingSnap, []);
  notifier.configure({ prefs: DEFAULT_ATTENTION_PREFS, needsYouTasks: 2 });
  assert.equal(notifier.badgeCount(), 4);
  notifier.observeTerminal("a", alive, []);
  notifier.observeTerminal("b", { pty_alive: false }, [{ kind: "closed" }]);
  notifier.configure({ prefs: DEFAULT_ATTENTION_PREFS, needsYouTasks: 0 });
  assert.equal(notifier.badgeCount(), 0);
  assert.deepEqual(badges, [1, 2, 4, 3, 2, 0]);
});

test("only a notice main issued is shown, once, with its words masked and kept short", () => {
  const { notifier, requested, shown, state } = setup();
  notifier.observeTerminal("a", alive, [{ kind: "errored", detail: "x" }]);
  const id = requested[0].id;

  assert.equal(notifier.answer("made-up", { title: "Hi" }), false);
  assert.equal(notifier.answer(id, { title: "   " }), false);
  assert.equal(
    notifier.answer(id, { title: "Claude stopped", body: `key sk-ant-${"a".repeat(30)}\n${"word ".repeat(80)}` }),
    true,
  );
  assert.equal(notifier.answer(id, { title: "again" }), false, "an answered notice can't be shown twice");
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /^key \[masked:key\] word/);
  assert.ok(!shown[0].body.includes("sk-ant-"));
  assert.ok(!shown[0].body.includes("\n"));
  assert.ok(shown[0].body.length <= 180);

  notifier.observeTerminal("a", alive, [{ kind: "turn_started" }, { kind: "errored", detail: "y" }]);
  state.now += 31_000;
  assert.equal(notifier.answer(requested[1].id, { title: "late" }), false, "an unanswered notice expires");
});

test("settings from the window are checked, with defaults for anything missing or wrong", () => {
  assert.deepEqual(sanitizeAttentionPrefs(undefined), DEFAULT_ATTENTION_PREFS);
  assert.deepEqual(sanitizeAttentionPrefs({ waiting: false, finished: "no", extra: 1 }), {
    ...DEFAULT_ATTENTION_PREFS,
    waiting: false,
  });
  const { notifier } = setup();
  notifier.configure({ prefs: {}, needsYouTasks: -3 });
  assert.equal(notifier.badgeCount(), 0);
  notifier.configure({ prefs: {}, needsYouTasks: 1.5 });
  assert.equal(notifier.badgeCount(), 0);
});

test("a notification says who, what happened and where, in the person's language", async () => {
  const { attentionText, folderName } = await import("../src/attention/attentionText.ts");
  assert.equal(folderName({ name: "main", isPrimary: true }, { name: "undo-hand" }), "undo-hand");
  assert.equal(folderName({ name: "fix-login", isPrimary: false }, { name: "undo-hand" }), "fix-login");
  const { en } = await import("../src/i18n/en.ts");
  const { zh } = await import("../src/i18n/zh.ts");
  const terminal = { kind: "terminal" as const, terminalId: "a" };
  const place = { name: "Claude", folder: "brewline", workdesk: "Launch" };
  assert.deepEqual(attentionText({ id: "1", kind: "waiting", surface: "banner" as const, target: terminal }, place, en), {
    title: "Claude needs you",
    body: "Waiting for your approval · brewline · Launch",
  });
  assert.equal(attentionText({ id: "2", kind: "failed", surface: "banner" as const, target: terminal, detail: "API error" }, place, en).body, "API error · brewline · Launch");
  assert.equal(attentionText({ id: "3", kind: "finished", surface: "banner" as const, target: terminal }, { name: null }, en).title, "An agent finished");
  const task = { kind: "task" as const, repo: "/r", taskId: "t" };
  assert.deepEqual(attentionText({ id: "4", kind: "needs_you", surface: "banner" as const, target: task, detail: "Launch", question: "Which plan?" }, { name: null }, en), {
    title: "Needs you: Launch",
    body: "Which plan?",
  });
  assert.equal(attentionText({ id: "5", kind: "waiting", surface: "banner" as const, target: terminal }, place, { ...en, ...zh }).title, "Claude 需要你");
});
