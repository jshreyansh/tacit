import test from "node:test";
import assert from "node:assert/strict";
import { filterLiveTerminals, treeTerminals } from "../src/toolbar/liveSessionsModel";
import type { CanvasTerminalItem, ProjectGroup } from "../src/components/sessionPanelModel";

function item(terminalId: string, title: string, worktreeName = "main"): CanvasTerminalItem {
  return {
    terminalId,
    projectId: "p",
    projectName: "tacit",
    worktreeId: worktreeName,
    worktreeName,
    title,
    locationLabel: `tacit / ${worktreeName}`,
    focused: false,
    state: "idle",
  };
}

const summary = { attention: 0, running: 0, freshDone: 0, done: 0, idle: 0 };

function tree(): ProjectGroup[] {
  return [
    {
      projectId: "p",
      projectName: "tacit",
      projectPath: "/repo/tacit",
      statusSummary: summary,
      worktrees: [
        { worktreeId: "main", worktreeName: "main", worktreePath: "/repo/tacit", isPrimary: true, statusSummary: summary, terminals: [item("a", "Fix the search ranking")] },
        { worktreeId: "t7", worktreeName: "t7-workdesk-views", worktreePath: "/repo/t7", isPrimary: false, statusSummary: summary, terminals: [item("b", "Terminal", "t7-workdesk-views"), item("c", "Opencode", "t7-workdesk-views")] },
      ],
    },
  ];
}

test("the Sessions search finds live terminals by title, project or worktree, every word", () => {
  const all = treeTerminals(tree());
  assert.deepEqual(all.map((t) => t.terminalId), ["a", "b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "").map((t) => t.terminalId), ["a", "b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "SEARCH").map((t) => t.terminalId), ["a"]);
  assert.deepEqual(filterLiveTerminals(all, "workdesk").map((t) => t.terminalId), ["b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "workdesk open").map((t) => t.terminalId), ["c"]);
  assert.deepEqual(filterLiveTerminals(all, "nothing-like-this"), []);
});
