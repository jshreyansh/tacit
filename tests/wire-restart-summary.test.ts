import test from "node:test";
import assert from "node:assert/strict";

// After a restart, the window says what was kept and for whom; messages for
// a terminal no longer on the workdesk are dropped, and the user is told.

test("kept messages are named by agent; ones for gone terminals are dropped and counted", async () => {
  const discarded: string[] = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US", userAgent: "node-test" } });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900, innerWidth: 1440, localStorage: globalThis.localStorage,
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      tacit: {
        app: { platform: "darwin", setQuitOnLastWindowClosed() {} },
        workspace: { setTitle() {} },
        capture: { record: () => {}, setCanvas: () => {}, getHealth: () => Promise.resolve(null) },
        wires: {
          discardWaiting: async (terminalId: string) => {
            discarded.push(terminalId);
            return { discarded: 2 };
          },
        },
      },
    },
  });
  const { useProjectStore } = await import("../src/stores/projectStore");
  const { useNotificationStore } = await import("../src/stores/notificationStore");
  const { tellRestartSummary } = await import("../src/stores/wireMailboxStore");
  useProjectStore.setState({
    projects: [{
      id: "p1", name: "home", path: "/tmp/home",
      worktrees: [{ id: "w1", name: "home", path: "/tmp/home", terminals: [
        { id: "cx", title: "codex", customTitle: "Reviewer", type: "codex" },
        { id: "cl", title: "claude", type: "claude" },
      ] }],
    }],
  } as never);
  const notes: Array<[string, string]> = [];
  useNotificationStore.setState({ notify: ((type: string, message: string) => { notes.push([type, message]); }) as never });

  await tellRestartSummary({
    held: [
      { terminalId: "cx", waiting: 2 },
      { terminalId: "cl", waiting: 1 },
      { terminalId: "gone", waiting: 2 },
    ],
  });
  assert.deepEqual(discarded, ["gone"]);
  assert.deepEqual(notes, [
    ["info", "Kept from before Tacit restarted: 2 for Reviewer, 1 for claude. Each agent gets its messages after its next turn, or click ✉ on it to deliver them now."],
    ["warn", "2 waiting messages were for terminals no longer on this workdesk, so they were dropped."],
  ]);

  notes.length = 0;
  await tellRestartSummary({ held: [], problem: "Tacit couldn't use what its wires were waiting on before it closed (not JSON), so nothing was kept." });
  assert.deepEqual(notes, [["warn", "Tacit couldn't use what its wires were waiting on before it closed (not JSON), so nothing was kept."]]);
});
