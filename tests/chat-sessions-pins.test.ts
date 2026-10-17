import test from "node:test";
import assert from "node:assert/strict";
import { filterLiveTerminals, treeTerminals } from "../src/toolbar/liveSessionsModel";
import { splitPinsByStatus } from "../src/toolbar/pinsViewModel";
import { pinHandoffText, type Pin } from "../shared/pin";
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

function pin(id: string, status: Pin["status"], updated: string): Pin {
  return { id, title: id, status, repo: "/repo/tacit", body: "", links: [], created: updated, updated };
}

test("the Pins view splits open pins from done and dropped ones, newest first", () => {
  const { open, done } = splitPinsByStatus([
    pin("old-open", "open", "2026-10-01T00:00:00Z"),
    pin("done", "done", "2026-10-03T00:00:00Z"),
    pin("new-open", "open", "2026-10-05T00:00:00Z"),
    pin("dropped", "dropped", "2026-10-04T00:00:00Z"),
  ]);
  assert.deepEqual(open.map((p) => p.id), ["new-open", "old-open"]);
  assert.deepEqual(done.map((p) => p.id), ["dropped", "done"]);
});

test("a pin handed to the manager says it is context, then gives its title and body", () => {
  const text = pinHandoffText({ title: "  Export a context  ", body: "Keep the format small.\n" });
  assert.match(text, /^This is an existing Tacit pin provided as context/);
  assert.ok(text.endsWith("\n\n# Export a context\n\nKeep the format small."));
  // No title, no heading.
  assert.ok(!pinHandoffText({ title: " ", body: "Just a body" }).includes("#"));
  // Chinese pins get the Chinese instruction.
  assert.match(pinHandoffText({ title: "导出上下文", body: "" }), /^这是一个已有的 Tacit pin/);
});
