import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectScanner } from "../electron/project-scanner.ts";
import { buildCanvasTerminalSections, buildProjectTree } from "../src/components/sessionPanelModel.ts";
import type { ProjectData } from "../src/types/index.ts";

// A folder that isn't a git repo has no branch. It used to be called "main"
// when added and "(unknown)" after the next refresh, so the Sessions list and
// the chat header showed a branch that doesn't exist.

function tempDir(t: test.TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a folder that isn't a git repo is one worktree with no branch, however it's scanned", async (t) => {
  const dir = tempDir(t, "tacit-plain-folder-");
  const scanner = new ProjectScanner();
  const plain = [{ path: dir, branch: "", isPrimary: true }];

  assert.deepEqual((await scanner.scanAsync(dir))?.worktrees, plain);
  assert.deepEqual(scanner.listWorktrees(dir), plain);
  assert.deepEqual(await scanner.listWorktreesAsync(dir), plain);
});

test("a git repo still has its branch", async (t) => {
  const dir = tempDir(t, "tacit-repo-folder-");
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
  const scanner = new ProjectScanner();
  const worktrees = await scanner.listWorktreesAsync(dir);
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].branch, "trunk");
});

test("a folder that is gone has no worktrees, so it's pruned", async () => {
  const scanner = new ProjectScanner();
  const gone = path.join(os.tmpdir(), "tacit-plain-folder-gone-does-not-exist");
  assert.deepEqual(scanner.listWorktrees(gone), []);
  assert.deepEqual(await scanner.listWorktreesAsync(gone), []);
});

test("a terminal in a folder without a branch is placed by the folder alone", () => {
  const projects = [
    {
      id: "p",
      name: "notes",
      path: "/tmp/notes",
      worktrees: [
        {
          id: "w",
          name: "",
          path: "/tmp/notes",
          isPrimary: true,
          terminals: [
            {
              id: "t",
              title: "opencode",
              type: "opencode",
              minimized: false,
              focused: false,
              ptyId: 1,
              status: "running",
              span: { cols: 1, rows: 1 },
            },
          ],
        },
      ],
    },
  ] as unknown as ProjectData[];

  const { focused, attention, progress, done, idle } = buildCanvasTerminalSections(projects, new Map(), new Map());
  const items = [...(focused ? [focused] : []), ...attention, ...progress, ...done, ...idle];
  assert.deepEqual(items.map((item) => item.locationLabel), ["notes"]);

  const tree = buildProjectTree(projects, new Map(), new Map());
  assert.equal(tree.projects[0].worktrees[0].worktreeName, "");
  assert.equal(tree.projects[0].worktrees[0].terminals[0].locationLabel, "notes");
});
