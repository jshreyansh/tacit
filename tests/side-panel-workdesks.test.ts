import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectData, TerminalData } from "../src/types/index.ts";

// Each workdesk remembers which project its side panel shows, across
// switching workdesks and quitting the app. Before, the panel showed only
// the focused project: a workdesk with no terminal saved as focused came
// back blank, or showing the last workdesk's folder.

function installBrowserGlobals() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
  const navigator = { language: "en-US", userAgent: "node-test" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { innerHeight: 900, innerWidth: 1440, navigator, tacit: undefined }),
  });
}

async function load() {
  installBrowserGlobals();
  const { useCanvasRegistryStore } = await import("../src/stores/canvasRegistryStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { snapshotState, readWorkspaceSnapshot, restoreWorkspaceSnapshot } = await import("../src/snapshotState.ts");
  return { useCanvasRegistryStore, useProjectStore, snapshotState, readWorkspaceSnapshot, restoreWorkspaceSnapshot };
}

function terminal(id: string): TerminalData {
  return {
    id,
    title: id,
    type: "shell",
    minimized: false,
    focused: false,
    ptyId: null,
    status: "idle",
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    tags: [],
  };
}

function project(id: string, terminals: TerminalData[] = []): ProjectData {
  return {
    id,
    name: id,
    path: `/work/${id}`,
    worktrees: [{ id: `${id}-main`, name: "main", path: `/work/${id}`, terminals }],
  };
}

test("each workdesk keeps its panel's project across switches and a restart", async () => {
  const { useCanvasRegistryStore, useProjectStore, snapshotState, readWorkspaceSnapshot, restoreWorkspaceSnapshot } = await load();
  const registry = () => useCanvasRegistryStore.getState();
  const projects = () => useProjectStore.getState();

  // Workdesk A: two projects. Click a terminal in "site", then empty canvas.
  const deskA = registry().activeCanvasId;
  projects().addProject(project("site", [terminal("t1")]));
  projects().addProject(project("notes", [terminal("t2")]));
  projects().setFocusedTerminal("t1", { focusInput: false });
  projects().clearFocus();

  // Workdesk B: pick "app" in the panel; nothing is focused.
  const deskB = registry().createCanvas("B");
  projects().addProject(project("app", [terminal("t3")]));
  projects().addProject(project("docs"));
  projects().setPanelWorktree("app-main");

  registry().switchCanvas(deskA);
  assert.equal(projects().focusedWorktreeId, null, "nothing was focused on A when it was left");
  assert.equal(projects().panelWorktreeId, "site-main");

  registry().switchCanvas(deskB);
  assert.equal(projects().panelWorktreeId, "app-main");

  // Quit on B and reopen.
  const saved = snapshotState();
  projects().setProjects([]);
  useProjectStore.setState({ panelWorktreeId: null });
  const restored = readWorkspaceSnapshot(saved);
  assert.ok(restored && "scene" in restored);
  restoreWorkspaceSnapshot(restored);

  assert.equal(registry().activeCanvasId, deskB);
  assert.equal(projects().panelWorktreeId, "app-main");
  registry().switchCanvas(deskA);
  assert.equal(projects().panelWorktreeId, "site-main");
});

test("a workdesk saved before the panel kept its own project shows the focused terminal's", async () => {
  const { useProjectStore, readWorkspaceSnapshot, restoreWorkspaceSnapshot } = await load();
  const flagged = { ...terminal("t9"), focused: true };
  const restored = readWorkspaceSnapshot({
    version: 2,
    scene: {
      version: 2,
      camera: { x: 0, y: 0, zoom: 1 },
      browserCards: {},
      annotations: [],
      projects: [
        { ...project("old"), position: { x: 0, y: 0 }, collapsed: false, zIndex: 0 },
        {
          ...project("flagged", [flagged]),
          position: { x: 0, y: 0 },
          collapsed: false,
          zIndex: 0,
        },
      ],
    },
  });
  assert.ok(restored && "scene" in restored);
  restoreWorkspaceSnapshot(restored);
  assert.equal(useProjectStore.getState().panelWorktreeId, "flagged-main");
});
