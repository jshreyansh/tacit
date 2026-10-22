import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileTreeWatcher } from "../electron/file-tree-watcher.ts";

// The watcher debounces 300ms; fs events on macOS can take a moment more.
const SETTLE_MS = 1200;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

// Folders made just before a watch starts can still be reported to it, so
// each test lets its setup settle before watching.
async function setup(t: test.TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tacit-tree-watcher-")));
  fs.mkdirSync(path.join(dir, "sub/deeper"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  const changes: string[] = [];
  const watcher = new FileTreeWatcher(new Set([".git"]), (dirPath) => changes.push(dirPath));
  t.after(() => {
    watcher.unwatchAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await settle();
  return { dir, changes, watcher };
}

test("a folder watched one level deep hears its own entries change, not deeper ones", async (t) => {
  const { dir, changes, watcher } = await setup(t);
  watcher.watch(dir, false);
  await settle();
  fs.writeFileSync(path.join(dir, "sub/deeper/inside.txt"), "x");
  await settle();
  assert.deepEqual(changes, [], "a change two levels down reached a one-level watch");
  fs.writeFileSync(path.join(dir, "top.txt"), "x");
  await settle();
  assert.deepEqual(changes, [dir]);
});

test("a whole-tree watch hears deep changes but not ones inside .git", async (t) => {
  const { dir, changes, watcher } = await setup(t);
  watcher.watch(dir, true);
  await settle();
  fs.writeFileSync(path.join(dir, ".git/index"), "x");
  await settle();
  assert.deepEqual(changes, [], "a change inside .git reached the tree");
  fs.writeFileSync(path.join(dir, "sub/deeper/inside.txt"), "x");
  await settle();
  assert.deepEqual(changes, [dir]);
});

test("two watchers of one folder share it: it stops only when both let go", async (t) => {
  const { dir, changes, watcher } = await setup(t);
  watcher.watch(dir, false);
  watcher.watch(dir, false);
  watcher.unwatch(dir, false);
  await settle();
  fs.writeFileSync(path.join(dir, "one.txt"), "x");
  await settle();
  assert.deepEqual(changes, [dir], "the folder stopped being watched while one watcher still wanted it");
  watcher.unwatch(dir, false);
  assert.deepEqual(watcher.getWatchedDirs(), []);
});

test("a one-level and a whole-tree watch of the same folder are separate", async (t) => {
  const { dir, watcher } = await setup(t);
  watcher.watch(dir, true);
  watcher.watch(dir, false);
  watcher.unwatch(dir, false);
  assert.deepEqual(watcher.getWatchedDirs(), [dir], "letting go of the one-level watch closed the whole-tree one");
});
