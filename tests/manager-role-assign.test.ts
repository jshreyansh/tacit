import test from "node:test";
import assert from "node:assert/strict";
import type { CaptureEvent } from "../shared/capture";

/**
 * The renderer half of role recording: assigning through the store must reach
 * both the decision record and the tenure log, carrying the CLI so a history
 * row can be labelled.
 *
 * Worth its own test because the recording deliberately does NOT live at the
 * call sites — the pill and the MCP surface both funnel through the store
 * action, and an earlier cut recorded in only one of them, so assigning the
 * role the normal way left no trace at all.
 */
interface RoleInput {
  terminalId: string;
  cli: string | null;
  canvasId: string | null;
}

function installBrowserGlobals(sink: {
  decisions: CaptureEvent[];
  roles: Array<RoleInput | null>;
}) {
  const storage = new Map<string, string>();
  const navigator = { language: "en-US", userAgent: "node-test", platform: "MacIntel" };
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900,
      innerWidth: 1440,
      localStorage,
      navigator,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      termcanvas: {
        app: { platform: "darwin", setQuitOnLastWindowClosed() {} },
        workspace: { setTitle() {} },
        capture: {
          record: (e: CaptureEvent) => sink.decisions.push(e),
          setCanvas() {},
          getHealth: () => Promise.resolve(null),
        },
        managerRole: {
          set: (input: RoleInput | null) => sink.roles.push(input),
          listSessions: () => Promise.resolve([]),
          getCurrent: () => Promise.resolve(null),
        },
      },
    },
  });
}

async function setup() {
  const sink = { decisions: [] as CaptureEvent[], roles: [] as Array<RoleInput | null> };
  installBrowserGlobals(sink);
  const { useCanvasRegistryStore } = await import("../src/stores/canvasRegistryStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");

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
              { id: "t-pm", title: "claude", type: "claude" },
              { id: "t-codex", title: "codex", type: "codex" },
            ],
          },
        ],
      },
    ],
  } as never);

  // The store is a module singleton shared across cases in this file, so a
  // previous test's holder would make the next assignment a no-op — which the
  // action is right to dedupe, but which silently empties the case under test.
  // Reset through setState so clearing it doesn't itself get recorded.
  useCanvasRegistryStore.setState((state) => ({
    canvases: state.canvases.map((c) => ({
      ...c,
      workspaceManagerTerminalId: null,
    })),
  }));
  sink.decisions.length = 0;
  sink.roles.length = 0;

  const canvasId = useCanvasRegistryStore.getState().canvases[0].id;
  return { sink, useCanvasRegistryStore, canvasId };
}

test("assigning the role reports it to the tenure log with the CLI", async () => {
  const { sink, useCanvasRegistryStore, canvasId } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");

  assert.equal(sink.roles.length, 1);
  assert.deepEqual(sink.roles[0], { terminalId: "t-pm", cli: "claude", canvasId });
});

test("the same assignment also lands in the decision record", async () => {
  const { sink, useCanvasRegistryStore, canvasId } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");

  const entry = sink.decisions.find((d) => d.kind === "manager");
  assert.ok(entry, "a manager decision should be recorded");
  assert.equal((entry as { node: string | null }).node, "terminal:t-pm");
});

test("handing over reports the new holder and its own CLI", async () => {
  const { sink, useCanvasRegistryStore, canvasId } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-codex");

  assert.equal(sink.roles.length, 2);
  assert.deepEqual(sink.roles[1], { terminalId: "t-codex", cli: "codex", canvasId });
});

test("removing the role reports null", async () => {
  const { sink, useCanvasRegistryStore, canvasId } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, null);

  assert.equal(sink.roles[1], null);
});

// Some paths re-run assignment with the value already in place; that is not a
// handover and must not open a second tenure.
test("re-assigning the current holder reports nothing", async () => {
  const { sink, useCanvasRegistryStore, canvasId } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");
  useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, "t-pm");

  assert.equal(sink.roles.length, 1, "no duplicate report");
});

test("an unknown canvas id changes nothing", async () => {
  const { sink, useCanvasRegistryStore } = await setup();
  useCanvasRegistryStore.getState().setWorkspaceManager("no-such-canvas", "t-pm");

  assert.equal(sink.roles.length, 0);
  assert.equal(sink.decisions.length, 0);
});
