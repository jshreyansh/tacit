import test from "node:test";
import assert from "node:assert/strict";

import { ASK_TIMEOUT_MS, WireAsks, answerText, questionText, type PendingAsk, type ReplyRead } from "../electron/wire-asks";

// Asking over a wire: the turn the question starts is the answer, and it
// goes back to the asker.

function harness(reply: () => ReplyRead) {
  const answers: Array<{ to: string; text: string }> = [];
  let now = 0;
  const asks = new WireAsks({
    readReply: () => reply(),
    answer: async (ask, text) => { answers.push({ to: ask.askerId, text }); },
    now: () => now,
    wait: async () => {},
  });
  const ask = (id = "q1", targetId = "cx"): PendingAsk => ({
    id, askerId: "cl", askerTitle: "Claude", targetId, targetTitle: "Codex",
    question: "Does the login redirect keep the query string?", cwd: "/w", at: now,
  });
  return { asks, answers, ask, advance: (ms: number) => { now += ms; } };
}

test("the target is told its reply goes back to the asker", () => {
  assert.equal(
    questionText({ id: "cl", title: "Claude" }, "review this"),
    "[Question from Claude (terminal cl), over a wire on the canvas. Your final reply this turn is sent back to Claude as the answer.] review this",
  );
});

test("when the turn the question started ends, its final reply goes back as the answer", async () => {
  let reply: ReplyRead = { status: "no-reply" };
  const h = harness(() => reply);
  h.asks.register(h.ask());
  h.asks.started("q1");
  reply = { status: "ready", text: "Yes, it keeps it." };
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 1);
  assert.equal(h.answers[0].to, "cl");
  assert.equal(h.answers[0].text, answerText(h.ask(), "Yes, it keeps it."));
  assert.match(h.answers[0].text, /^\[Answer from Codex \(terminal cx\) to your question "Does the login redirect/);
  // Answered once: a later turn of the same agent sends nothing.
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 1);
});

test("a turn that ends while the agent's own subagents still work isn't taken as the answer", async () => {
  let state: ReplyRead = { status: "mid-task" };
  const h = harness(() => state);
  h.asks.register(h.ask());
  h.asks.started("q1");
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 0);
  state = { status: "ready", text: "done" };
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 1);
});

test("a turn that ended before the question was typed in doesn't answer it", async () => {
  const h = harness(() => ({ status: "ready", text: "an older reply" }));
  h.asks.register(h.ask()); // still waiting in the mailbox
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 0);
});

test("the asker hears when there is no answer, or it can't be read", async () => {
  const none = harness(() => ({ status: "no-reply" }));
  none.asks.register(none.ask());
  none.asks.started("q1");
  await none.asks.turnEnded("cx");
  assert.match(none.answers[0].text, /finished without saying anything/);

  const unreadable = harness(() => ({ status: "unavailable", reason: "no-session" }));
  unreadable.asks.register(unreadable.ask());
  unreadable.asks.started("q1");
  await unreadable.asks.turnEnded("cx");
  assert.match(unreadable.answers[0].text, /couldn't be read \(no-session\)/);
});

test("a question discarded from the mailbox, or a target that closed, is reported back", async () => {
  const h = harness(() => ({ status: "ready", text: "x" }));
  h.asks.register(h.ask("q1"));
  h.asks.dropped("q1");
  assert.match(h.answers[0].text, /was discarded before it was delivered/);

  h.asks.register(h.ask("q2"));
  h.asks.started("q2");
  h.asks.targetGone("cx");
  assert.match(h.answers[1].text, /closed before answering/);
});

test("an answer that never comes is given up on after 30 minutes", async () => {
  const h = harness(() => ({ status: "mid-task" }));
  h.asks.register(h.ask());
  h.asks.started("q1");
  h.advance(ASK_TIMEOUT_MS - 1);
  await h.asks.sweep();
  assert.equal(h.answers.length, 0);
  h.advance(1);
  await h.asks.sweep();
  assert.match(h.answers[0].text, /after 30 minutes/);
  assert.equal(h.asks.activeFor("cx"), null);
});

test("a transcript that still shows the reply from before the question is read again, not sent", async () => {
  // Seen live: Codex's turn ended a moment before it wrote "task complete",
  // and the first read found its previous task's reply.
  const reads: ReplyRead[] = [
    { status: "ready", text: "The page describes example.com." }, // before the question
    { status: "ready", text: "The page describes example.com." }, // turn ended, file not caught up
    { status: "ready", text: "399" },
  ];
  const h = harness(() => reads.shift() ?? { status: "ready", text: "399" });
  h.asks.register(h.ask());
  h.asks.started("q1");
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 1);
  assert.match(h.answers[0].text, /\] 399$/);
});

test("an answer that really is the same as the last reply still goes back, after a few reads", async () => {
  const h = harness(() => ({ status: "ready", text: "ok" }));
  h.asks.register(h.ask());
  h.asks.started("q1");
  await h.asks.turnEnded("cx");
  assert.match(h.answers[0].text, /\] ok$/);
});

test("the turn that answered is remembered, once, so a rule doesn't send it to the asker again", async () => {
  let reply: ReplyRead = { status: "no-reply" };
  const h = harness(() => reply);
  h.asks.register(h.ask());
  h.asks.started("q1");
  reply = { status: "ready", text: "5", turn: "t-1" };
  await h.asks.turnEnded("cx");
  assert.equal(h.answers.length, 1);
  // Not this turn to someone else, nor another turn to the asker.
  assert.equal(h.asks.alreadyAnswered("cx", "someone-else", "turn:t-1"), false);
  assert.equal(h.asks.alreadyAnswered("cx", "cl", "turn:t-2"), false);
  assert.equal(h.asks.alreadyAnswered("cx", "cl", "turn:t-1"), true);
  // Used up: asked again, it's no longer an answer already sent.
  assert.equal(h.asks.alreadyAnswered("cx", "cl", "turn:t-1"), false);
});
