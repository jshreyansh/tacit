import test from "node:test";
import assert from "node:assert/strict";

import { relocatedProject } from "../src/stores/projectStore.ts";
import { isMissingFolderError } from "../src/actions/missingFolders.ts";
import type { ProjectData } from "../src/types/index.ts";

const project: ProjectData = {
  id: "p1",
  name: "undo-test",
  path: "/tmp/old/undo-test",
  worktrees: [
    { id: "w1", name: "undo-test", path: "/tmp/old/undo-test", isPrimary: true, terminals: [] },
    { id: "w2", name: "feature", path: "/tmp/old/undo-test/.worktrees/feature", terminals: [] },
    { id: "w3", name: "elsewhere", path: "/tmp/other/feature-b", terminals: [] },
    { id: "w4", name: "sibling", path: "/tmp/old/undo-test-2", terminals: [] },
  ],
};

test("a moved folder takes the worktrees inside it along, and its name if it was named after it", () => {
  const moved = relocatedProject(project, "/Users/me/code/undo/");
  assert.equal(moved.path, "/Users/me/code/undo");
  assert.equal(moved.name, "undo");
  assert.deepEqual(
    moved.worktrees.map((w) => [w.name, w.path]),
    [
      ["undo", "/Users/me/code/undo"],
      ["feature", "/Users/me/code/undo/.worktrees/feature"],
      ["elsewhere", "/tmp/other/feature-b"],
      ["sibling", "/tmp/old/undo-test-2"],
    ],
  );
});

test("a folder someone renamed keeps its name when it moves", () => {
  assert.equal(relocatedProject({ ...project, name: "Undo tests" }, "/x/undo").name, "Undo tests");
});

test("both ways a start says the folder is gone are recognised", () => {
  assert.equal(isMissingFolderError("Error invoking remote method 'terminal:create': Error: Directory does not exist: /tmp/x"), true);
  assert.equal(isMissingFolderError("the terminal's folder doesn't exist"), true);
  assert.equal(isMissingFolderError("spawn codex ENOENT"), false);
});
