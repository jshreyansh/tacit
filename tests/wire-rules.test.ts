import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RULE_PER_HOUR,
  consoleErrorsText,
  normalizeRules,
  ruleWords,
  rulesOffered,
  withinHourlyLimit,
} from "../shared/wire-rules";
import { MAX_AUTOMATIC_HOPS } from "../shared/wire-envelope";

// Rules on a wire: one event at one end, one delivery to the other.

test("a rule is offered only where its event happens and the other end can take it", () => {
  // An agent's finished reply can go to another agent, either way round.
  assert.deepEqual(rulesOffered("agent", "agent", false), [
    { when: "turn_finished", at: "from" },
    { when: "turn_finished", at: "to" },
  ]);
  // A page's console errors go to the agent driving it, though the wire
  // runs from the agent to the page.
  assert.deepEqual(rulesOffered("agent", "browser", false), [{ when: "console_error", at: "to" }]);
  // An agent's reply into a task is logged as a step.
  assert.deepEqual(rulesOffered("agent", "task", false), [{ when: "turn_finished", at: "from" }]);
  // Replies into a page or a note have their own toggles; not offered twice.
  assert.deepEqual(rulesOffered("agent", "note", false), []);
  // Nothing is offered on a plain link, or where no event fits.
  assert.deepEqual(rulesOffered("agent", "agent", true), []);
  assert.deepEqual(rulesOffered("note", "note", false), []);
  assert.deepEqual(rulesOffered("shell", "agent", false), []);
});

test("rules from a file are checked before they can run", () => {
  assert.deepEqual(
    normalizeRules([
      { id: "r1", when: "turn_finished", at: "from", consent: "always", perHour: 5 },
      { id: "r2", when: "teleport", at: "from" },
      { id: "r3", when: "console_error", at: "sideways" },
      { id: "r4", when: "console_error", at: "to", consent: "maybe", perHour: 9999 },
      "nonsense",
    ]),
    [
      { id: "r1", when: "turn_finished", at: "from", consent: "always", perHour: 5 },
      { id: "r4", when: "console_error", at: "to", consent: "ask", perHour: DEFAULT_RULE_PER_HOUR },
    ],
  );
  assert.deepEqual(normalizeRules(undefined), []);
});

test("the hourly limit counts only the last hour", () => {
  const now = 10 * 3_600_000;
  assert.equal(withinHourlyLimit([now - 10, now - 20], now, 3), true);
  assert.equal(withinHourlyLimit([now - 10, now - 20, now - 30], now, 3), false);
  assert.equal(withinHourlyLimit([now - 3_600_000, now - 3_700_000, now - 10], now, 3), true);
});

test("console errors are gathered into one short message", () => {
  assert.equal(consoleErrorsText(["Uncaught TypeError: x is undefined"]), "The page logged an error:\n- Uncaught TypeError: x is undefined");
  const many = consoleErrorsText(Array.from({ length: 12 }, (_, i) => `e${i}`));
  assert.match(many, /^The page logged 12 errors:/);
  assert.match(many, /\(and 2 more\)$/);
});

test("a rule reads as a sentence", () => {
  assert.equal(ruleWords({ when: "turn_finished" }, "Codex", "Claude"), "when Codex finishes a turn, send its reply to Claude");
  assert.equal(ruleWords({ when: "console_error" }, "localhost", "Claude"), "when localhost logs a console error, tell Claude");
});

// ---------------------------------------------------------------- engine

type Sent = { to: string; body: string; payload: string };

async function engine() {
  const sent: Sent[] = [];
  const notes: string[] = [];
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US", userAgent: "node-test" } });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900, innerWidth: 1440, localStorage,
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      tacit: {
        app: { platform: "darwin", setQuitOnLastWindowClosed() {} },
        workspace: { setTitle() {} },
        capture: { record: () => {}, setCanvas: () => {}, getHealth: () => Promise.resolve(null) },
        wires: {
          sendToTerminal: async (req: { target: { terminalId: string }; envelope: { body: string; payload: string } }) => {
            sent.push({ to: req.target.terminalId, body: req.envelope.body, payload: req.envelope.payload });
            return { ok: true };
          },
        },
      },
    },
  });
  const rules = await import("../src/canvas/wireRules.ts");
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import("../src/stores/terminalRuntimeStateStore.ts");
  const { useNotificationStore } = await import("../src/stores/notificationStore.ts");
  useProjectStore.setState({
    projects: [{
      id: "p1", name: "repo", path: "/tmp/repo",
      worktrees: [{ id: "w1", name: "main", path: "/tmp/repo", terminals: [
        { id: "cx", title: "Codex", type: "codex" },
        { id: "cl", title: "Claude", type: "claude" },
      ] }],
    }],
  } as never);
  useTerminalRuntimeStateStore.setState({ terminals: { cx: { ptyId: 1 }, cl: { ptyId: 2 } } } as never);
  const notify = useNotificationStore.getState().notify;
  useNotificationStore.setState({ notify: ((_t: string, message: string) => { notes.push(message); }) as never });
  useConnectionStore.setState({
    connections: {
      w: {
        id: "w", from: { kind: "terminal", id: "cx" }, to: { kind: "terminal", id: "cl" },
        createdAt: 1, origin: "manual", type: "hands-off-to", twoWay: true, v: 2,
        rules: [
          { id: "r-cx", when: "turn_finished", at: "from", consent: "always", perHour: 100 },
          { id: "r-cl", when: "turn_finished", at: "to", consent: "always", perHour: 100 },
        ],
      },
    },
    pending: null,
  });
  return { rules, sent, notes, useConnectionStore, restore: () => useNotificationStore.setState({ notify }) };
}

test("a finished reply goes to the other agent, labelled as a reply", async () => {
  const e = await engine();
  await e.rules.agentTurnFinished("cx", "The diff looks safe.");
  assert.deepEqual(e.sent, [{ to: "cl", body: "The diff looks safe.", payload: "reply" }]);
  e.restore();
});

test("two agents passing replies back and forth stop after the hop limit, and the user is told", async () => {
  const e = await engine();
  // Codex finishes a turn the user started; whoever a rule delivers to
  // then finishes its own turn, and so on until a delivery doesn't happen.
  let next = "cx";
  for (let turn = 0; turn < 20; turn += 1) {
    const before = e.sent.length;
    await e.rules.agentTurnFinished(next, `reply ${turn}`);
    if (e.sent.length === before) break;
    next = e.sent[e.sent.length - 1].to;
  }
  assert.equal(e.sent.length, MAX_AUTOMATIC_HOPS);
  assert.ok(e.notes.some((n) => /Stopped a chain of automatic messages/.test(n)), e.notes.join("\n"));
  e.restore();
});

test("a rule that asks waits for the user: Skip sends nothing, Always stops asking", async () => {
  const e = await engine();
  e.useConnectionStore.getState().putConnectionRule("w", { id: "r-cx", when: "turn_finished", at: "from", consent: "ask", perHour: 100 });

  const skipped = e.rules.agentTurnFinished("cx", "first");
  await new Promise((r) => setTimeout(r, 0));
  const [prompt] = e.rules.useRulePromptStore.getState().prompts;
  assert.match(prompt.sentence, /when Codex finishes a turn, send its reply to Claude/);
  assert.equal(prompt.preview, "first");
  prompt.decide("skip");
  await skipped;
  assert.equal(e.sent.length, 0);

  const always = e.rules.agentTurnFinished("cx", "second");
  await new Promise((r) => setTimeout(r, 0));
  e.rules.useRulePromptStore.getState().prompts[0].decide("always");
  await always;
  assert.equal(e.sent.length, 1);
  const rule = e.useConnectionStore.getState().connections.w.rules!.find((r) => r.id === "r-cx")!;
  assert.equal(rule.consent, "always");
  await e.rules.agentTurnFinished("cx", "third");
  assert.equal(e.sent.length, 2, "no prompt the second time");
  e.restore();
});

test("a rule over its hourly limit doesn't run, and says so", async () => {
  const e = await engine();
  e.useConnectionStore.getState().putConnectionRule("w", { id: "r-limit", when: "turn_finished", at: "from", consent: "always", perHour: 1 });
  e.useConnectionStore.getState().removeConnectionRule("w", "r-cx");
  await e.rules.agentTurnFinished("cx", "one");
  await e.rules.agentTurnFinished("cx", "two");
  assert.equal(e.sent.filter((s) => s.to === "cl").length, 1);
  assert.ok(e.notes.some((n) => /its limit/.test(n)));
  e.restore();
});

test("a rule on a plain link never runs", async () => {
  const e = await engine();
  e.useConnectionStore.getState().setConnectionType("w", "relates-to");
  await e.rules.agentTurnFinished("cx", "anything");
  assert.equal(e.sent.length, 0);
  e.restore();
});
