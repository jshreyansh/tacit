import test from "node:test";
import assert from "node:assert/strict";

import { resolvePanelProject } from "../src/components/RightPanel/panelProject.ts";
import { useProjectStore } from "../src/stores/projectStore.ts";
import { useTerminalRuntimeStateStore } from "../src/stores/terminalRuntimeStateStore.ts";
import type { ProjectData, TerminalData } from "../src/types/index.ts";

// The side panel (Files, Diff, Git, Memory) shows one project of the active
// workdesk. It used to show the focused project, so clicking empty canvas
// blanked it, a restart blanked it unless a terminal was saved as focused,
// and with nothing focused it kept showing whatever folder it showed last,
// even one from another workdesk.

function terminal(id: string, focused = false): TerminalData {
  return {
    id,
    title: id,
    type: "shell",
    minimized: false,
    focused,
    ptyId: null,
    status: "idle",
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    tags: [],
  };
}

function project(id: string, terminals: TerminalData[] = [], extraWorktrees: string[] = []): ProjectData {
  return {
    id,
    name: id,
    path: `/work/${id}`,
    worktrees: [
      { id: `${id}-main`, name: "main", path: `/work/${id}`, terminals },
      ...extraWorktrees.map((name) => ({
        id: `${id}-${name}`,
        name,
        path: `/work/${id}/.worktrees/${name}`,
        terminals: [],
      })),
    ],
  };
}

function shown(projects: ProjectData[], panel: string | null, focused: string | null): string {
  const result = resolvePanelProject(projects, panel, focused);
  if (result.kind === "project") return result.worktree.id;
  if (result.kind === "choose") return `choose:${result.projects.map((p) => p.id).join(",")}`;
  return "none";
}

// --- Which project the panel shows ------------------------------------------

test("the panel's own choice wins over focus", () => {
  const projects = [project("site"), project("app")];
  assert.equal(shown(projects, "site-main", "app-main"), "site-main");
});

test("with no choice yet, the panel shows the focused worktree", () => {
  const projects = [project("site"), project("app", [], ["fix"])];
  assert.equal(shown(projects, null, "app-fix"), "app-fix");
});

test("a choice that's no longer on the workdesk falls back to focus", () => {
  const projects = [project("site"), project("app")];
  assert.equal(shown(projects, "removed-main", "app-main"), "app-main");
});

test("a workdesk with one project shows it with nothing focused", () => {
  assert.equal(shown([project("home", [], ["x"])], null, null), "home-main");
});

test("a workdesk with several projects and nothing chosen asks instead of guessing", () => {
  assert.equal(shown([project("site"), project("app")], null, null), "choose:site,app");
});

test("an empty workdesk shows nothing, never another workdesk's folder", () => {
  // The ids belong to projects on another workdesk; they're not in this
  // workdesk's list, so they can't be shown.
  assert.equal(shown([], "other-main", "other-main"), "none");
});

// --- What sets it -----------------------------------------------------------

function resetStore(projects: ProjectData[]) {
  useTerminalRuntimeStateStore.getState().reset();
  useProjectStore.setState({
    projects,
    focusedProjectId: null,
    focusedWorktreeId: null,
    panelWorktreeId: null,
  });
}

test("focusing a terminal shows its project, and clicking empty canvas keeps it", () => {
  resetStore([project("site", [terminal("t1")]), project("app", [terminal("t2")])]);
  const store = useProjectStore.getState();

  store.setFocusedTerminal("t2", { focusInput: false });
  assert.equal(useProjectStore.getState().panelWorktreeId, "app-main");

  // Clicking empty canvas clears focus (and the terminal's saved flag) …
  useProjectStore.getState().clearFocus();
  const state = useProjectStore.getState();
  assert.equal(state.focusedWorktreeId, null);
  // … but the panel keeps showing the project.
  assert.equal(state.panelWorktreeId, "app-main");
  assert.equal(shown(state.projects, state.panelWorktreeId, state.focusedWorktreeId), "app-main");
});

test("picking a project in the sessions list shows it", () => {
  resetStore([project("site"), project("app")]);
  useProjectStore.getState().setFocusedWorktree("site", "site-main");
  assert.equal(useProjectStore.getState().panelWorktreeId, "site-main");
});

test("unfocusing a terminal doesn't change the panel", () => {
  resetStore([project("site", [terminal("t1", true)])]);
  useProjectStore.getState().setFocusedTerminal("t1", { focusInput: false });
  useProjectStore.getState().setFocusedTerminal(null);
  assert.equal(useProjectStore.getState().panelWorktreeId, "site-main");
});

test("picking a project in the panel shows it without focusing anything", () => {
  resetStore([project("site"), project("app")]);
  useProjectStore.getState().setPanelWorktree("app-main");
  const state = useProjectStore.getState();
  assert.equal(state.panelWorktreeId, "app-main");
  assert.equal(state.focusedWorktreeId, null);
});

test("the panel can't be pointed at a worktree that isn't on the workdesk", () => {
  resetStore([project("site")]);
  useProjectStore.getState().setPanelWorktree("site-main");
  useProjectStore.getState().setPanelWorktree("elsewhere-main");
  assert.equal(useProjectStore.getState().panelWorktreeId, "site-main");
});
