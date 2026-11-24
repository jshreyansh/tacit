import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../shared/task.ts";

let n = 0;
const ctx = (by = "user"): T.Ctx => ({ at: new Date(1_800_000_000_000 + n++ * 1000).toISOString(), by, newId: () => `i${n++}` });
const NOTHING: T.Observed = { files: [], known: true, shared: false };
const PASSED: T.Observed = { files: [{ path: "src/a.ts", kind: "changed" }], known: true, shared: false, tests: { passed: true, after: true, command: "npm test" } };

function make(parts: string[] = [], doneWhen: string[] = []): T.Task {
  const at = ctx().at;
  let t: T.Task = {
    id: "fix-1", n: 1, workdesk: "w", title: "Fix the PDF error", body: "Why", kind: "bug", priority: "none", folder: "/p", doneWhen: [], leaveAlone: "", startFrom: [], allowed: "", check: "reason",
    parts: [], wait: "next", closed: null, seen: true, tries: [], requests: [], decisions: [], report: null, messages: [], history: [], suggestion: null, landed: null, madeFrom: null, ledTo: [], created: at, updated: at, rev: 1, revs: {},
  };
  for (const p of parts) t = T.changePart(t, ctx(), { op: "add", text: p });
  for (const l of doneWhen) t = T.changeLine(t, ctx(), { op: "add", text: l });
  return t;
}
const give = (t: T.Task, terminal = "a", part: string | null = null) => T.handOver(t, ctx(), { terminal, name: terminal.toUpperCase(), part });
const last = (t: T.Task) => t.tries.at(-1)!.id;
const see = (t: T.Task, saw: T.Signal, id = last(t)) => T.signal(t, ctx("tacit"), id, saw);
const working = (t: T.Task, terminal = "a", part: string | null = null) => see(see(give(t, terminal, part), { saw: "delivered" }), { saw: "working" });
const agent = (id = "a") => ctx(`terminal:${id}`);
const report = (t: T.Task, over: Partial<T.FinishInput> = {}, seen = PASSED, id = last(t)) =>
  T.finish(t, agent(), id, { summary: "Did it", lines: t.doneWhen.map((l) => ({ line: l.id, checked: true, how: "ran it" })), ...over }, seen);

test("handed over isn't working: it's delivered, then seen to start", () => {
  let t = give(make());
  assert.deepEqual([T.columnOf(t), t.tries[0].state], ["working", "sending"]);
  t = see(t, { saw: "delivered" });
  assert.equal(t.tries[0].state, "has");
  t = see(t, { saw: "working" });
  assert.equal(t.tries[0].state, "working");
  assert.ok(t.history.some((h) => h.text === "A started" && h.by === "tacit"));
});

test("a turn ending is never Done: asked once, then stuck; not asked while it waits for an answer", () => {
  let t = working(make());
  const before = t;
  t = see(t, { saw: "turn-ended" });
  assert.equal(T.wantsNudge(before, t, last(t)), true);
  assert.equal(T.columnOf(t), "working");
  // Being asked starts a turn. Its end doesn't ask again, for ever.
  t = see(t, { saw: "working" });
  const asked = t;
  t = see(t, { saw: "turn-ended" });
  assert.deepEqual([T.columnOf(t), t.requests[0].kind, t.tries[0].state], ["needs", "stuck", "ended"]);
  assert.equal(T.wantsNudge(asked, t, last(t)), false);
});

test("an agent that's still going isn't asked again; only time makes it stuck", () => {
  let t = see(see(working(make()), { saw: "turn-ended" }), { saw: "working" });
  t = T.stillGoing(t, agent(), last(t));
  t = see(t, { saw: "turn-ended" });
  assert.deepEqual([T.columnOf(t), t.tries[0].state], ["working", "quiet"]);
  assert.equal(T.columnOf(see(t, { saw: "still-quiet", minutes: 10 })), "needs");
  assert.equal(see(t, { saw: "working" }).tries[0].state, "working");
});

test("typing go on in its terminal picks the same try up again, and it can report", () => {
  for (const saw of ["limit", "failed", "restarted"] as const) {
    let t = see(working(make(["One"]), "a"), { saw });
    assert.equal(T.columnOf(t), "needs");
    t = see(t, { saw: "working" });
    assert.deepEqual([T.columnOf(t), t.requests.length, t.tries.length], ["working", 0, 1]);
    assert.equal(T.columnOf(report(t, { wantsCheck: true })), "needs");
  }
  const gone = see(working(make()), { saw: "closed" });
  assert.equal(T.columnOf(see(gone, { saw: "working" })), "needs", "a closed terminal isn't picked up");
  const stopped = T.stopTry(working(make()), ctx(), "nope");
  assert.equal(stopped.tries[0].state, "working");
});

test("reporting again before you've looked replaces the report", () => {
  let t = report(working(make([], ["It works"])), { taste: true });
  t = report(t, { summary: "Better" });
  assert.deepEqual([T.columnOf(t), t.report!.summary, t.requests.length], ["done", "Better", 0]);
});

test("what you allowed is for that go: given again, or not", () => {
  let t = T.editText(make(), ctx(), "allowed", "commit");
  t = working(t);
  assert.equal(t.allowed, "commit");
  t = T.stopTry(t, ctx(), last(t));
  assert.equal(give(t, "b").allowed, "");
  assert.equal(T.handOver(t, ctx(), { terminal: "b", name: "B", allowed: "commit" }).allowed, "commit");
  const two = working(make(["One", "Two"]), "a", null);
  const kept = T.handOver(T.editText(two, ctx(), "allowed", "commit"), ctx(), { terminal: "b", name: "B", part: two.parts[0].id });
  assert.equal(kept.allowed, "commit", "someone's still on it with that");
});

test("what you say to an agent waits, arrives or fails", () => {
  let t = working(make());
  t = T.post(t, ctx(), "You", "Use the new one", last(t));
  assert.equal(t.messages[0].state, "waiting");
  assert.equal(T.posted(t, t.messages[0].id, false).messages[0].state, "failed");
  assert.equal(T.posted(t, t.messages[0].id, true).messages[0].state, "delivered");
  assert.throws(() => T.post(t, ctx(), "You", "x", "gone"), /isn't there/);
});

test("a question waits, the rest carries on, and it leaves Needs you when its answer arrives", () => {
  let t = working(make(["One", "Two"]), "a", null);
  t = working(t, "b", t.parts[0].id);
  const a = t.tries[0].id;
  t = T.askPerson(t, agent("a"), { kind: "decide", try: a, byName: "A", text: "Which?", options: [{ label: "X", recommended: true }, { label: "Y" }] });
  assert.deepEqual([T.columnOf(t), T.carriesOn(t)], ["needs", 2]);
  const waits = see(t, { saw: "turn-ended" }, a);
  assert.deepEqual([waits.tries[0].state, T.wantsNudge(t, waits, a), T.carriesOn(waits)], ["quiet", false, 1], "ending a turn to wait is right, and isn't working");
  t = T.answer(t, ctx(), t.requests[0].id, "X");
  assert.equal(T.columnOf(t), "needs");
  assert.equal(t.decisions[0].answer, "X");
  const failed = T.answered(t, ctx("tacit"), t.requests[0].id, "terminal is busy");
  assert.equal(failed.requests[0].answer?.failed, "terminal is busy");
  t = T.answered(t, ctx("tacit"), t.requests[0].id);
  assert.equal(T.columnOf(t), "working");
});

test("an answer to an agent that has gone is kept and goes in the next brief", () => {
  let t = working(make());
  t = T.askPerson(t, agent(), { kind: "decide", try: last(t), byName: "A", text: "0.9 or 1.0?" });
  t = see(t, { saw: "closed" });
  assert.deepEqual(t.requests.map((r) => r.kind).sort(), ["decide", "stuck"]);
  t = T.answer(t, ctx(), t.requests.find((r) => r.kind === "decide")!.id, "1.0");
  assert.equal(t.decisions[0].pending, true);
  t = give(t, "b");
  assert.equal(t.decisions[0].pending, false);
  assert.match(T.briefText(t, last(t)), /0\.9 or 1\.0\? 1\.0/);
  assert.equal(T.columnOf(t), "working");
});

test("two agents asking at once: both show, and answering one leaves the other", () => {
  let t = make(["One", "Two"]);
  t = working(t, "a", t.parts[0].id);
  const a = last(t);
  t = working(t, "b", t.parts[1].id);
  const b = last(t);
  t = T.askPerson(t, agent("a"), { kind: "decide", try: a, byName: "A", text: "List or board?" });
  t = T.askPerson(t, agent("b"), { kind: "decide", try: b, byName: "B", text: "Keep colours?" });
  t = T.answered(T.answer(t, ctx(), t.requests[0].id, "Board"), ctx("tacit"), t.requests[0].id);
  assert.deepEqual(t.requests.map((r) => r.text), ["Keep colours?"]);
});

test("a permission shows until it's dealt with in the terminal", () => {
  let t = see(working(make()), { saw: "permission" });
  assert.deepEqual([T.columnOf(t), t.requests[0].kind, t.tries[0].state], ["needs", "allow", "paused"]);
  t = see(t, { saw: "working" });
  assert.deepEqual([T.columnOf(t), t.tries[0].state], ["working", "working"]);
});

test("what goes wrong comes to you, with something to do", () => {
  for (const [saw, state] of [[{ saw: "limit" }, "limit"], [{ saw: "failed" }, "failed"], [{ saw: "closed" }, "closed"], [{ saw: "restarted" }, "interrupted"]] as const) {
    const t = see(working(make()), saw);
    assert.deepEqual([T.columnOf(t), t.tries[0].state, t.requests.length], ["needs", state, 1]);
    assert.equal(T.columnOf(give(t, "b")), "working");
  }
  const lost = see(give(make()), { saw: "undelivered", why: "closed" });
  assert.deepEqual([T.columnOf(lost), lost.requests[0].why], ["needs", "closed"]);
  let quiet = see(working(make()), { saw: "quiet" });
  assert.equal(T.columnOf(quiet), "working");
  quiet = see(quiet, { saw: "still-quiet", minutes: 10 });
  assert.equal(T.columnOf(quiet), "needs");
  assert.equal(T.columnOf(T.dismissStuck(quiet, ctx(), quiet.requests[0].id)), "working");
  assert.equal(T.columnOf(see(quiet, { saw: "working" })), "working");
});

test("news of a try that's over changes nothing, and its agent can't update it", () => {
  let t = working(make());
  const old = last(t);
  t = working(t, "b");
  assert.equal(t.tries[0].state, "stopped");
  assert.deepEqual(see(t, { saw: "limit" }, old), t);
  assert.throws(() => report(t, {}, PASSED, old), /has ended/);
  assert.throws(() => T.askPerson(t, agent(), { kind: "decide", try: old, byName: "A", text: "x" }), /has ended/);
});

test("every line checked goes to Done; each reason alone brings it to you", () => {
  const fresh = () => working(make([], ["It works", "It undoes"]));
  const ok = report(fresh());
  assert.deepEqual([T.columnOf(ok), ok.closed?.how, ok.seen], ["done", "Tacit saw the tests pass", false]);
  const why = (over: Partial<T.FinishInput>, seen: Partial<T.Observed> = {}, t = fresh()) => {
    const r = report(t, over, { ...PASSED, ...seen });
    assert.equal(T.columnOf(r), "needs", JSON.stringify(over));
    return r.report!.reasons;
  };
  const line = fresh();
  assert.deepEqual(why({ lines: [{ line: line.doneWhen[0].id, checked: true, how: "ran" }, { line: line.doneWhen[1].id, checked: false, how: "no account" }] }, {}, line), ["One line wasn't checked"]);
  assert.deepEqual(why({ unsure: "might break undo" }), ["It's unsure"]);
  assert.deepEqual(why({ taste: true }), ["It's a matter of taste"]);
  assert.deepEqual(why({ sensitive: "sign-in" }), ["It says it touches something sensitive"]);
  assert.deepEqual(why({ left: "docs" }), ["Something is left"]);
  assert.deepEqual(why({ wantsCheck: true }), ["It asked you to look"]);
  assert.deepEqual(why({}, { tests: { passed: true, after: false, command: "npm test" } }), ["Tests ran before the last change"]);
  assert.deepEqual(why({}, { tests: { passed: false, after: true, command: "npm test" } }), ["Its tests failed"]);
  assert.deepEqual(why({}, { files: [{ path: "app/package.json", kind: "changed" }] }), ["It changed package.json"]);
  assert.deepEqual(why({}, { shared: true }), ["Another agent was editing the same folder"]);
  assert.deepEqual(why({}, {}, T.setSettings(fresh(), ctx(), { check: "always" })), ["You always check this"]);
  assert.throws(() => T.finish(working(make()), agent(), "x", { summary: "", lines: [] }, NOTHING), /isn't there/);
});

test("no Done when and no word of how it checked comes to you", () => {
  const t = working(make());
  const r = T.finish(t, agent(), last(t), { summary: "Done", lines: [] }, NOTHING);
  assert.deepEqual([T.columnOf(r), r.report!.reasons], ["needs", ["It didn't say how it checked"]]);
});

test("no Done when, but it says how it checked: Done, marked as its word", () => {
  const t = working(make());
  const r = T.finish(t, agent(), last(t), { summary: "Deleted it", lines: [], checked: "It's gone from the folder listing" }, NOTHING);
  assert.equal(T.columnOf(r), "done");
  assert.match(r.closed!.how, /said how it checked/);
  assert.ok(r.report!.facts.some((f) => f.src === "says" && /gone from the folder/.test(f.text)));
  // Lines of its own count too, and one it didn't check brings it to you.
  const own = T.finish(t, agent(), last(t), { summary: "x", lines: [{ line: "a", checked: true, how: "ran it" }] }, NOTHING);
  assert.equal(T.columnOf(own), "done");
  const not = T.finish(t, agent(), last(t), { summary: "x", lines: [{ line: "a", checked: false, how: "no network" }], checked: "read it" }, NOTHING);
  assert.deepEqual([T.columnOf(not), not.report!.reasons], ["needs", ["One line wasn't checked"]]);
  // Lines that are the task's own still have to be answered one by one.
  const asked = T.changeLine(make(), ctx(), { op: "add", text: "it works" });
  const w = working(asked);
  const skipped = T.finish(w, agent(), last(w), { summary: "x", lines: [], checked: "all good" }, NOTHING);
  assert.deepEqual(skipped.report!.reasons, ["One line wasn't checked"]);
});

test("Stuck carries what the agent said as it stopped", () => {
  let t = see(working(make()), { saw: "turn-ended", said: "first words" });
  assert.equal(t.requests.length, 0);
  t = see(see(t, { saw: "working" }), { saw: "turn-ended", said: "The task says not to use tools" });
  assert.deepEqual([t.requests[0].kind, t.requests[0].said], ["stuck", "The task says not to use tools"]);
});

test("an agent can't write Tacit saw, loosen a check, or finish while it waits on you", () => {
  let t = working(make([], ["It works"]));
  const r = report(t, { lines: [{ line: t.doneWhen[0].id, checked: true, how: "Tacit saw it pass" }] }, NOTHING);
  assert.equal(r.doneWhen[0].proof?.src, "says");
  assert.ok(r.report!.facts.every((f) => f.src !== "saw" || f.text === "No files changed"));
  assert.throws(() => T.setSettings(t, agent(), { check: "never" }), /Only you/);
  assert.equal(T.setSettings(t, agent(), { check: "always" }).check, "always");
  t = T.askPerson(t, agent(), { kind: "approve", try: last(t), byName: "A", text: "Push it?" });
  assert.throws(() => report(t), /still waiting/);
  assert.equal(T.columnOf(report(T.withdraw(t, agent(), t.requests[0].id))), "done");
  assert.throws(() => T.withdraw(t, agent("b"), t.requests[0].id), /Only whoever asked/);
});

test("Never unless I ask holds over the rules, not over failed tests or the agent asking", () => {
  const never = () => T.setSettings(working(make([], ["It works"])), ctx(), { check: "never" });
  assert.equal(T.columnOf(report(never(), { taste: true })), "done");
  assert.equal(T.columnOf(report(never(), { wantsCheck: true })), "needs");
  assert.equal(T.columnOf(report(never(), {}, { ...PASSED, tests: { passed: false, after: true, command: "t" } })), "needs");
});

test("parts: each has its own agent; the task finishes with the last", () => {
  let t = make(["One", "Two"], ["It works"]);
  t = working(t, "a", t.parts[0].id);
  const a = last(t);
  t = working(t, "b", t.parts[1].id);
  const b = last(t);
  t = T.finish(t, agent("a"), a, { summary: "part one", lines: [] }, PASSED);
  assert.deepEqual([T.columnOf(t), t.parts.map((p) => p.state)], ["working", ["done", "doing"]]);
  t = T.finish(t, agent("b"), b, { summary: "all", lines: [{ line: "It works", checked: true, how: "ran" }] }, PASSED);
  assert.equal(T.columnOf(t), "done");
  const whole = report(working(make(["One", "Two"])), {}, PASSED);
  assert.deepEqual(whole.report!.reasons, ["2 parts aren't done"]);
});

test("send back is a new try with your words, and a change after a report marks its proof out of date", () => {
  let t = report(working(make([], ["It works"])), { taste: true });
  t = T.changeLine(t, ctx(), { op: "add", text: "And undo" });
  assert.equal(t.report?.stale, true);
  t = T.handOver(t, ctx(), { terminal: "a", name: "A", note: "Warmer colours" });
  assert.deepEqual([T.columnOf(t), t.requests.length, t.tries.at(-1)!.n], ["working", 0, 2]);
  assert.match(T.briefText(t, last(t)), /Sent back with: Warmer colours/);
  const retext = T.changeLine(report(working(make([], ["It works"])), { taste: true }), ctx(), { op: "add", text: "x" });
  assert.equal(T.changeLine(retext, ctx(), { op: "text", id: retext.doneWhen[0].id, text: "It works twice" }).doneWhen[0].proof, undefined);
});

test("text edited from an old copy is refused; another field isn't", () => {
  let t = { ...make(), rev: 4 };
  t = { ...T.editText(t, agent(), "body", "Theirs", 4), rev: 5 };
  assert.throws(() => T.editText(t, ctx(), "body", "Mine", 4), /changed this since/);
  assert.equal(T.editText(t, ctx(), "title", "New name", 4).title, "New name");
  assert.throws(() => T.editText(t, ctx(), "title", "  "), /needs a name/);
});

test("a suggestion changes nothing until it's accepted", () => {
  const t = T.suggest(make([], ["It works"]), agent(), "A", { body: "Better", doneWhen: ["It works", "It undoes"] });
  assert.deepEqual([t.body, t.doneWhen.length], ["Why", 1]);
  const yes = T.settleSuggestion(t, ctx(), true);
  assert.deepEqual([yes.body, yes.doneWhen.map((l) => l.text), yes.suggestion], ["Better", ["It works", "It undoes"], null]);
  assert.deepEqual([T.settleSuggestion(t, ctx(), false).body], ["Why"]);
});

test("put off, drop, reopen: only what makes sense, and nothing starts by itself", () => {
  const busy = working(make());
  assert.throws(() => T.setWait(busy, ctx(), "later"), /Stop it first/);
  const dropped = T.dropTask(busy, ctx());
  assert.deepEqual([T.columnOf(dropped), dropped.tries[0].state], ["dropped", "stopped"]);
  assert.throws(() => give(dropped), /Reopen/);
  const back = T.reopen(dropped, ctx());
  assert.deepEqual([T.columnOf(back), T.activeTries(back).length], ["next", 0]);
  assert.equal(T.columnOf(T.setWait(back, ctx(), "later")), "later");
  assert.throws(() => T.setSettings(busy, ctx(), { folder: "/q" }), /Stop it first/);
  assert.throws(() => T.changePart(working(make(["One"]), "a", null), ctx(), { op: "remove", id: "nope" }), /isn't there/);
});

test("the board's order: priority first, then what has waited longest; newest done first", () => {
  const at = (t: T.Task, updated: string, priority: T.Priority = "none") => ({ ...t, id: updated, updated, priority });
  assert.deepEqual(T.sortTasks([at(make(), "2"), at(make(), "1"), at(make(), "3", "urgent")]).map((t) => t.id), ["3", "1", "2"]);
});

/* ---------- every way through, with several parts at once ---------- */

test("two hundred thousand random steps: never Working with something waiting, nothing in Needs you without a way out, closed means over", () => {
  let seed = 7;
  // mulberry32: the same walk every time, with every bit as random as the next.
  const rand = (k: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * k);
  };
  const pick = <X,>(xs: readonly X[]) => xs[rand(xs.length)];
  let steps = 0;
  const columns = new Set<string>();
  const states = new Set<string>();
  for (let walk = 0; walk < 4000; walk++) {
    let t = make(Array.from({ length: rand(4) }, (_, i) => `P${i}`), rand(2) ? ["L"] : []);
    for (let i = 0; i < 50; i++) {
      const on = T.activeTries(t);
      const tryId = on.length && rand(5) ? pick(on).id : t.tries.length ? pick(t.tries).id : "none";
      const req = t.requests.length ? pick(t.requests) : null;
      const part = t.parts.length && rand(2) ? pick(t.parts).id : null;
      const moves: Array<() => T.Task> = [
        () => T.handOver(t, ctx(), { terminal: pick(["a", "b", "c"]), name: "X", part, queued: rand(3) === 0 }),
        ...Array.from({ length: 10 }, () => () => T.signal(t, ctx("tacit"), tryId, pick<T.Signal>([{ saw: "sent" }, { saw: "delivered" }, { saw: "delivered" }, { saw: "delivered" }, { saw: "undelivered", why: "x" }, { saw: "working" }, { saw: "working" }, { saw: "working" }, { saw: "permission" }, { saw: "turn-ended" }, { saw: "turn-ended" }, { saw: "quiet" }, { saw: "still-quiet", minutes: 10 }, { saw: "limit" }, { saw: "failed" }, { saw: "closed" }, { saw: "restarted" }]))),
        () => T.askPerson(t, agent(), { kind: pick(["decide", "approve"]), try: tryId, byName: "X", text: "Q" }),
        () => (req ? T.answer(t, ctx(), req.id, "yes") : t),
        () => (req ? T.answered(t, ctx("tacit"), req.id, rand(3) ? undefined : "busy") : t),
        () => (req ? T.withdraw(t, ctx(req.by), req.id) : t),
        () => (req ? T.dismissStuck(t, ctx(), req.id) : t),
        () => T.finish(t, agent(), tryId, { summary: "s", lines: rand(2) ? t.doneWhen.map((l) => ({ line: l.id, checked: true, how: "x" })) : [], wantsCheck: rand(3) === 0 }, rand(2) ? PASSED : NOTHING),
        () => T.stopTry(t, ctx(), tryId),
        () => T.stillGoing(t, agent(), tryId),
        () => T.post(t, ctx(), "You", "hello", tryId),
        () => (t.messages.length ? T.posted(t, pick(t.messages).id, rand(2) === 0) : t),
        () => (rand(6) ? t : T.accept(t, ctx())),
        () => (rand(6) ? t : T.dropTask(t, ctx())),
        () => T.reopen(t, ctx()),
        () => T.setWait(t, ctx(), pick(["later", "next"])),
        () => T.changePart(t, ctx(), { op: "add", text: "New" }),
        () => (part ? T.changePart(t, ctx(), { op: "remove", id: part }) : t),
        () => (part ? T.setPart(t, ctx(), part, pick(["todo", "done"])) : t),
        () => T.editText(t, ctx(), "body", `b${i}`),
      ];
      try {
        t = pick(moves)();
      } catch (e) {
        if (!(e instanceof T.TaskError)) throw e;
        continue;
      }
      steps += 1;
      const column = T.columnOf(t);
      columns.add(column);
      for (const x of t.tries) states.add(x.state);
      if (column === "working") assert.equal(t.requests.length, 0);
      if (t.closed) assert.deepEqual([t.requests.length, T.activeTries(t).length], [0, 0], "closed means over");
      const parts = T.activeTries(t).map((x) => x.part);
      assert.equal(new Set(parts).size, parts.length, "one agent to a part");
      assert.ok(t.tries.every((x) => T.currentTries(t).includes(x) || !T.isActive(x.state)), "only the latest try of a part is active");
      for (const r of t.requests) {
        // Each has a way out that the person, or the agent they're sent to, can take now.
        const out: T.Task =
          r.kind === "decide" || r.kind === "approve" ? T.answered(T.answer(t, ctx(), r.id, "yes"), ctx("tacit"), r.id)
          : r.kind === "stuck" ? T.dismissStuck(t, ctx(), r.id)
          : r.kind === "allow" ? T.stopTry(t, ctx(), r.try!)
          : T.accept(t, ctx());
        assert.ok(!out.requests.some((x) => x.id === r.id), `a way out of ${r.kind}`);
      }
    }
  }
  assert.deepEqual([...columns].sort(), ["done", "dropped", "later", "needs", "next", "working"]);
  assert.equal(states.size, 15, [...states].join());
  assert.ok(steps > 60_000, String(steps));
});

test("a line that asks for the command Tacit saw pass is Tacit saw; others stay the agent's word", () => {
  const src = (line: string, tests: T.Observed["tests"] = { passed: true, after: true, command: "npm test" }) => report(working(make([], [line])), {}, { ...PASSED, tests }).doneWhen[0].proof?.src;
  for (const line of ["npm test passes", "`npm test` passes", "Run npm test passes.", "NPM test passed"]) assert.equal(src(line), "saw", line);
  for (const line of ["npm test:e2e passes", "npm test is fast", "It works and npm test passes", "npm test doesn't pass"]) assert.equal(src(line), "says", line);
  assert.equal(src("npm test passes", { passed: true, after: false, command: "npm test" }), "says");
  assert.equal(src("npm test passes", { passed: false, after: true, command: "npm test" }), "says");
});

test("what you wrote while nobody had it goes in the next brief, once", () => {
  let t = T.post(report(working(make([], ["It works"]))), ctx(), "You", "Also an empty word");
  t = give(T.reopen(t, ctx()));
  assert.match(T.briefText(t, last(t)), /The user also said, since it was last handed over:\n- Also an empty word/);
  t = give(T.stopTry(t, ctx(), last(t)), "b");
  assert.doesNotMatch(T.briefText(t, last(t)), /empty word/);
});
