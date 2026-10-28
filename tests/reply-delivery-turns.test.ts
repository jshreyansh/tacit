import test from "node:test";
import assert from "node:assert/strict";

// A finished turn is passed on once per turn, not once per distinct text: two
// turns that end in the same words ("5", after counting to five twice) are two
// replies, and a rule passing replies to another agent passes both. The two
// completion signals for one turn (hook and transcript watcher) still pass it
// on once.

test("a rule passes on every turn, even one ending in the same words as the last", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { innerHeight: 900, innerWidth: 1440, addEventListener() {}, removeEventListener() {}, tacit: undefined },
  });
  const { useProjectStore } = await import("../src/stores/projectStore");
  const { useTerminalRuntimeStateStore } = await import("../src/stores/terminalRuntimeStateStore");
  const { useConnectionStore } = await import("../src/stores/connectionStore");
  const { handleAgentTurnComplete } = await import("../src/browser/chatReplyDelivery");

  let reply: { status: "ready"; text: string; turn?: string } = { status: "ready", text: "5", turn: "turn-1" };
  const sent: Array<{ to: string; body: string }> = [];
  (window as unknown as { tacit: unknown }).tacit = {
    session: { finalReply: async () => reply },
    wires: {
      sendToTerminal: async (req: { target: { terminalId: string }; envelope: { body: string } }) => {
        sent.push({ to: req.target.terminalId, body: req.envelope.body });
        return { ok: true, delivered: "now" };
      },
      replyAnswered: async () => false,
    },
  };

  const terminal = (id: string, title: string) => ({
    id, type: "codex", title, minimized: false, focused: false, ptyId: null, status: "running",
  });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "home",
        path: "/tmp/home",
        worktrees: [
          { id: "w1", name: "home", path: "/tmp/home", terminals: [terminal("a", "A"), terminal("b", "B")] },
        ],
      },
    ],
  } as unknown as Partial<ReturnType<typeof useProjectStore.getState>>);
  const runtime = useTerminalRuntimeStateStore.getState();
  runtime.setSessionId("b", "session-b");
  runtime.setPtyId("a", 7);
  useConnectionStore.setState({
    connections: {
      w1: {
        id: "w1",
        from: { kind: "terminal", id: "a" },
        to: { kind: "terminal", id: "b" },
        rules: [{ id: "r1", when: "turn_finished", at: "to", consent: "always", perHour: 20 }],
      },
    },
  } as unknown as Partial<ReturnType<typeof useConnectionStore.getState>>);

  await handleAgentTurnComplete({ terminalId: "b", immediate: true });
  assert.equal(sent.length, 1, "the first turn's reply goes to A");
  assert.equal(sent[0].to, "a");
  assert.equal(sent[0].body, "5");

  // The second signal for the same turn (the transcript watcher, after the
  // hook) sends nothing more.
  await handleAgentTurnComplete({ terminalId: "b", immediate: true });
  assert.equal(sent.length, 1, "one turn is passed on once");

  // The next turn ends in the same words: it is still a reply, and goes.
  reply = { status: "ready", text: "5", turn: "turn-2" };
  await handleAgentTurnComplete({ terminalId: "b", immediate: true });
  assert.equal(sent.length, 2, "a new turn with the same text is passed on");
  assert.equal(sent[1].body, "5");
});
