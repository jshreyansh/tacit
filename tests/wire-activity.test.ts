import test from "node:test";
import assert from "node:assert/strict";

import { RECENT_PER_WIRE, connectionEventPairKey, useBridgeActivityStore } from "../src/stores/bridgeActivityStore.ts";

// A message on a wire: drawn as it travels, then kept in the wire's menu.

const claude = { kind: "terminal" as const, id: "c" };
const shell = { kind: "terminal" as const, id: "s" };

test("a message travels, then stays in its wire's recent list with how it went", () => {
  const store = useBridgeActivityStore.getState();
  store.startConnectionEvent("r1", "message", claude, shell, "ls -la");
  const key = connectionEventPairKey(claude, shell);
  assert.equal(useBridgeActivityStore.getState().flights.r1?.preview, "ls -la");
  assert.equal(useBridgeActivityStore.getState().recentByPair[key][0].status, "sending");

  store.endConnectionEvent("r1", claude, shell, false);
  assert.equal(useBridgeActivityStore.getState().flights.r1?.status, "failed");
  assert.equal(useBridgeActivityStore.getState().recentByPair[key][0].status, "failed");
});

test("a wire keeps only its latest messages, newest first, whichever way they went", () => {
  const store = useBridgeActivityStore.getState();
  for (let i = 0; i < RECENT_PER_WIRE + 2; i++) {
    const [from, to] = i % 2 ? [shell, claude] : [claude, shell];
    store.startConnectionEvent(`m${i}`, "message", from, to, `#${i}`);
    store.endConnectionEvent(`m${i}`, from, to, true);
  }
  const recent = useBridgeActivityStore.getState().recentByPair[connectionEventPairKey(claude, shell)];
  assert.equal(recent.length, RECENT_PER_WIRE);
  assert.equal(recent[0].preview, `#${RECENT_PER_WIRE + 1}`);
  assert.ok(recent.every((m) => m.status === "delivered"));
});
