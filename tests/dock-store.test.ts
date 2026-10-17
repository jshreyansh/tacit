import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PINNED, loadPinned, normalizePinned, togglePinned, useDockStore } from "../src/stores/dockStore";

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

test("a first launch pins Claude, Codex, the browser and notes", () => {
  withStorage({}, () => {
    assert.deepEqual(loadPinned(), ["claude", "codex", "browser", "note"]);
    assert.deepEqual([...DEFAULT_PINNED], ["claude", "codex", "browser", "note"]);
  });
});

test("an empty dock the person chose stays empty", () => {
  withStorage({ "tacit.dock.pinned.v1": "[]" }, () => {
    assert.deepEqual(loadPinned(), []);
  });
});

test("a damaged saved dock falls back to the defaults, not to nothing", () => {
  withStorage({ "tacit.dock.pinned.v1": "{not json" }, () => {
    assert.deepEqual(loadPinned(), [...DEFAULT_PINNED]);
  });
  withStorage({ "tacit.dock.pinned.v1": '{"claude":true}' }, () => {
    assert.deepEqual(loadPinned(), [...DEFAULT_PINNED]);
  });
});

test("unknown and repeated ids are dropped, order kept", () => {
  assert.deepEqual(normalizePinned(["note", "gemini", "claude", "note", 7]), ["note", "claude"]);
  assert.equal(normalizePinned("claude"), null);
});

test("pinning adds to the end and unpinning removes", () => {
  const start = ["claude", "codex", "browser", "note"] as const;
  assert.deepEqual(togglePinned(start, "opencode"), ["claude", "codex", "browser", "note", "opencode"]);
  assert.deepEqual(togglePinned(start, "codex"), ["claude", "browser", "note"]);
  assert.deepEqual(togglePinned([], "shell"), ["shell"]);
});

test("pins survive a restart", () => {
  withStorage({}, (store) => {
    useDockStore.setState({ pinned: ["claude"] });
    useDockStore.getState().togglePin("antigravity");
    assert.equal(store.get("tacit.dock.pinned.v1"), '["claude","antigravity"]');
    assert.deepEqual(loadPinned(), ["claude", "antigravity"]);
  });
});
