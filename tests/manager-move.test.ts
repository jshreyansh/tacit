import test from "node:test";
import assert from "node:assert/strict";
import { useManagerChatStore } from "../src/stores/managerChatStore";
import { cancelManagerMove, moveManagerNow, requestManagerMove } from "../src/actions/managerChatMode";

const pending = (id: string) => useManagerChatStore.getState().pendingMoves[id] ?? null;

test("a move asked for mid-turn waits, and one asked for between turns doesn't", () => {
  requestManagerMove("t1", "terminal", true);
  assert.equal(pending("t1"), "terminal");
  // Between turns it goes straight away (no terminal by this id here, so the
  // move itself finds nothing to do) and nothing is left waiting.
  requestManagerMove("t1", "terminal", false);
  assert.equal(pending("t1"), null);
});

test("Move now carries out the waiting move; Cancel drops it", () => {
  requestManagerMove("t2", "chat", true);
  moveManagerNow("t2");
  assert.equal(pending("t2"), null);

  requestManagerMove("t3", "terminal", true);
  cancelManagerMove("t3");
  assert.equal(pending("t3"), null);
  moveManagerNow("t3");
  assert.equal(pending("t3"), null);
});

test("a closed manager's waiting move goes with its chat", () => {
  requestManagerMove("t4", "terminal", true);
  useManagerChatStore.getState().drop("t4");
  assert.equal(pending("t4"), null);
});

test("a tile goes to the chat with the session its terminal just reported, and back with the chat's", async () => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  const { useProjectStore } = await import("../src/stores/projectStore");
  const { useTerminalRuntimeStateStore, resolveTerminalRuntimeState } = await import("../src/stores/terminalRuntimeStateStore");
  const { moveManagerToChat, moveManagerToTerminal } = await import("../src/actions/managerChatMode");
  const previous = useProjectStore.getState();
  const started: Array<string | null> = [];
  let chatSession: string | null = null;
  (window as unknown as { tacit: unknown }).tacit = {
    chat: {
      start: async (req: { sessionId: string | null }) => {
        started.push(req.sessionId);
        return { ok: true };
      },
      snapshot: async () => ({ events: [], running: true, sessionId: chatSession }),
      stop: async () => {},
    },
  };
  try {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "home",
          path: "/tmp/home",
          worktrees: [
            {
              id: "w1",
              name: "home",
              path: "/tmp/home",
              // Just made and talked to: the saved tile has no session yet.
              terminals: [{ id: "c1", type: "claude", title: "claude", minimized: false, focused: false, ptyId: null, status: "running" }],
            },
          ],
        },
      ],
    } as unknown as Partial<ReturnType<typeof useProjectStore.getState>>);
    useTerminalRuntimeStateStore.getState().setSessionId("c1", "said-hey");

    await moveManagerToChat("c1");
    assert.deepEqual(started, ["said-hey"], "the chat resumes the terminal's conversation");

    // The chat went on in a session of its own; the terminal resumes that one.
    chatSession = "chat-session";
    await moveManagerToTerminal("c1");
    const tile = useProjectStore.getState().projects[0].worktrees[0].terminals[0];
    assert.equal(tile.chatMode, undefined);
    assert.equal(resolveTerminalRuntimeState(tile).sessionId, "chat-session");
  } finally {
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previous);
  }
});
