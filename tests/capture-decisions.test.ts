import test from "node:test";
import assert from "node:assert/strict";
import type { CaptureEvent } from "../shared/capture";

/**
 * Which canvas actions reach the decision record, and how they are attributed.
 *
 * The service tests cover writing. These cover the judgement calls above it —
 * an agent's wire must not be recorded as the user's, and the lineage backfill
 * that runs on every single app start must not reach the record at all. Both
 * are silent failures: the file would still look plausible while being wrong
 * about who decided what.
 */
function installBrowserGlobals(recorded: CaptureEvent[]) {
  const storage = new Map<string, string>();
  const navigator = { language: "en-US", userAgent: "node-test" };
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900,
      innerWidth: 1440,
      localStorage,
      navigator,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      // Importing the action modules transitively loads preferencesStore and
      // shortcutStore, which read `window.tacit?.app.*` at module scope —
      // guarding the `tacit` but not the `app` (20 call sites do this, so
      // it's the house convention). A stub with only `capture` therefore throws
      // on import; `app` has to be here even though nothing under test uses it.
      tacit: {
        app: { platform: "darwin", setQuitOnLastWindowClosed() {} },
        workspace: { setTitle() {} },
        capture: {
          record: (entry: CaptureEvent) => recorded.push(entry),
          setCanvas: () => {},
          getHealth: () => Promise.resolve(null),
        },
      },
    },
  });
}

test("a user-drawn wire is recorded as the user's", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { createConnectionInScene } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  createConnectionInScene(
    { kind: "terminal", id: "a" },
    { kind: "note", id: "n" },
  );

  assert.equal(recorded.length, 1);
  const entry = recorded[0] as Extract<CaptureEvent, { kind: "wire" }>;
  assert.equal(entry.kind, "wire");
  assert.equal(entry.by, "user");
  assert.equal(entry.from, "terminal:a");
  assert.equal(entry.to, "note:n");
  assert.equal(entry.origin, "manual");
});

test("an agent's wire is attributed to that agent, not the user", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { createConnectionInScene } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  createConnectionInScene(
    { kind: "terminal", id: "pm" },
    { kind: "note", id: "n" },
    { by: "terminal:pm" },
  );

  const entry = recorded[0] as Extract<CaptureEvent, { kind: "wire" }>;
  assert.equal(entry.by, "terminal:pm");
});

test("re-wiring an already-connected pair records nothing", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { createConnectionInScene } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  createConnectionInScene({ kind: "terminal", id: "a" }, { kind: "note", id: "n" });
  createConnectionInScene({ kind: "terminal", id: "a" }, { kind: "note", id: "n" });
  // Undirected, so the reverse is the same pair.
  createConnectionInScene({ kind: "note", id: "n" }, { kind: "terminal", id: "a" });

  assert.equal(recorded.length, 1, "only the wire that actually happened");
});

test("removing a wire records an unwire carrying the original origin", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { createConnectionInScene, removeConnectionFromScene } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  const id = createConnectionInScene(
    { kind: "terminal", id: "a" },
    { kind: "terminal", id: "b" },
    { origin: "spawn" },
  );
  assert.ok(id);
  recorded.length = 0;

  removeConnectionFromScene(id!);

  assert.equal(recorded.length, 1);
  const entry = recorded[0] as Extract<CaptureEvent, { kind: "unwire" }>;
  assert.equal(entry.kind, "unwire");
  assert.equal(entry.origin, "spawn", "origin must survive the removal");
  assert.equal(entry.from, "terminal:a");
  assert.equal(entry.to, "terminal:b");
  assert.equal(entry.by, "user");
});

test("removing a connection that no longer exists records nothing", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { removeConnectionFromScene } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  removeConnectionFromScene("conn-does-not-exist");
  assert.equal(recorded.length, 0);
});

// This one guards the most expensive possible mistake: backfill runs on every
// restore, so if it recorded, the file would gain a fresh batch of fake
// "decisions" every time the app opened, and the record would be worthless.
test("the lineage backfill never reaches the record", async () => {
  const recorded: CaptureEvent[] = [];
  installBrowserGlobals(recorded);
  const { backfillLineageConnections } = await import(
    "../src/actions/sceneConnectionActions.ts"
  );
  const { useConnectionStore } = await import("../src/stores/connectionStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  useConnectionStore.setState({ connections: {}, pending: null });

  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "repo",
        path: "/tmp/repo",
        worktrees: [
          {
            id: "w1",
            name: "main",
            path: "/tmp/repo",
            terminals: [
              { id: "parent", title: "claude", type: "claude" },
              { id: "child", title: "claude", type: "claude", parentTerminalId: "parent" },
            ],
          },
        ],
      },
    ],
  } as never);

  backfillLineageConnections();

  assert.equal(
    Object.keys(useConnectionStore.getState().connections).length,
    1,
    "the wire itself should still be created",
  );
  assert.equal(recorded.length, 0, "but it is a migration, not a decision");
});
