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
