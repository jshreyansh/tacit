import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_DOCK_DEFAULT_WIDTH,
  chatDockOffset,
  clampChatWidth,
  loadChatWidth,
  useChatDockStore,
} from "../src/stores/chatDockStore";

function withStorage(initial: Record<string, string>, run: (store: Map<string, string>) => void): void {
  const store = new Map(Object.entries(initial));
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  try {
    run(store);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
}

test("the chat's width stays between 360 and 680", () => {
  assert.equal(clampChatWidth(200), 360);
  assert.equal(clampChatWidth(900), 680);
  assert.equal(clampChatWidth(512.6), 513);
  assert.equal(clampChatWidth(Number.NaN), CHAT_DOCK_DEFAULT_WIDTH);
});

test("a saved width comes back, a damaged one gives the default", () => {
  withStorage({ "tacit.chatDock.width.v1": "520" }, () => assert.equal(loadChatWidth(), 520));
  withStorage({ "tacit.chatDock.width.v1": "wide" }, () => assert.equal(loadChatWidth(), CHAT_DOCK_DEFAULT_WIDTH));
  withStorage({ "tacit.chatDock.width.v1": "9999" }, () => assert.equal(loadChatWidth(), 680));
  withStorage({}, () => assert.equal(loadChatWidth(), CHAT_DOCK_DEFAULT_WIDTH));
});

test("a drag is saved when it ends, not on every move", () => {
  withStorage({}, (store) => {
    const dock = useChatDockStore.getState();
    dock.setWidth(500);
    dock.setWidth(530);
    assert.equal(store.has("tacit.chatDock.width.v1"), false);
    useChatDockStore.getState().commitWidth();
    assert.equal(store.get("tacit.chatDock.width.v1"), "530");
  });
});

test("panels opening after the chat move by its width and a gap, only while it is open", () => {
  assert.equal(chatDockOffset({ open: true, width: 440 }, 8), 448);
  assert.equal(chatDockOffset({ open: false, width: 440 }, 8), 0);
});

test("only a docked chat takes room beside the bar; floating and full screen take none", async () => {
  const { chatDockOffset } = await import("../src/stores/chatDockStore");
  assert.equal(chatDockOffset({ open: true, width: 440, placement: "dock" }, 8), 448);
  assert.equal(chatDockOffset({ open: true, width: 440 }, 8), 448);
  for (const placement of ["float", "full"] as const) assert.equal(chatDockOffset({ open: true, width: 440, placement }, 8), 0);
  assert.equal(chatDockOffset({ open: false, width: 440, placement: "dock" }, 8), 0);
});

test("a floating chat opens bottom right and always stays on screen, header in reach", async () => {
  const { clampFloatRect, defaultFloatRect, FLOAT_MIN } = await import("../src/stores/chatDockStore");
  const view = { width: 1440, height: 900 };
  assert.deepEqual(defaultFloatRect(view), { x: 1440 - 420 - 24, y: 900 - 620 - 24, w: 420, h: 620 });
  // Dragged off the right and bottom: pulled back in.
  assert.deepEqual(clampFloatRect({ x: 1400, y: 880, w: 420, h: 620 }, view), { x: 1440 - 420 - 8, y: 900 - 620 - 8, w: 420, h: 620 });
  // Too small: the minimum. Window shrunk: it fits.
  assert.deepEqual(clampFloatRect({ x: 100, y: 100, w: 10, h: 10 }, view), { x: 100, y: 100, w: FLOAT_MIN.w, h: FLOAT_MIN.h });
  const small = clampFloatRect({ x: 0, y: 0, w: 900, h: 900 }, { width: 600, height: 500 });
  assert.ok(small.x >= 8 && small.y >= 8 && small.x + small.w <= 592 && small.y + small.h <= 492);
});
