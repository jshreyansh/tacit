import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileTreeWatcher } from "../electron/file-tree-watcher.ts";
import type { WatchDirFailure } from "../shared/file-watch.ts";

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
  const watcher = new FileTreeWatcher(new Set([".git"]), (dirPath) => changes.push(dirPath), () => {});
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

test("main watches only so many folders, says so when it won't, and frees room on unwatch", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tacit-tree-watcher-")));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(dir, name));
  const watcher = new FileTreeWatcher(new Set(), () => {}, () => {}, 2);
  t.after(() => {
    watcher.unwatchAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const at = (name: string) => path.join(dir, name);
  assert.deepEqual(watcher.watch(at("a"), false), { ok: true });
  assert.deepEqual(watcher.watch(at("b"), false), { ok: true });
  const refused = watcher.watch(at("c"), false);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, "limit");
  assert.deepEqual(watcher.watch(at("a"), false), { ok: true }, "sharing a watched folder takes no room");
  watcher.unwatch(at("b"), false);
  assert.deepEqual(watcher.watch(at("c"), false), { ok: true });
  assert.deepEqual(watcher.getWatchedDirs().sort(), [at("a"), at("c")]);
});

test("a folder that no longer exists isn't watched, and says it's gone", (t) => {
  const watcher = new FileTreeWatcher(new Set(), () => {}, () => {});
  t.after(() => watcher.unwatchAll());
  const result = watcher.watch(path.join(os.tmpdir(), "tacit-no-such-folder", "x"), false);
  assert.equal(!result.ok && result.reason, "gone");
  assert.deepEqual(watcher.getWatchedDirs(), []);
});

test("watches that fail together are reported once, as failures, not changes, and stop", async (t) => {
  // macOS fails every folder watch in the process at once when it can't
  // watch any more; each used to come back as a change and re-list.
  const made: EventEmitter[] = [];
  t.mock.method(fs, "watch", () => {
    const fake = Object.assign(new EventEmitter(), { close() {} });
    made.push(fake);
    return fake;
  });
  t.mock.method(console, "warn", () => {});
  const changes: string[] = [];
  const reports: WatchDirFailure[][] = [];
  const watcher = new FileTreeWatcher(new Set(), (dirPath) => changes.push(dirPath), (failures) => reports.push(failures));
  t.after(() => watcher.unwatchAll());
  watcher.watch("/p/a", false);
  watcher.watch("/p", true);
  const emfile = Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
  for (const fake of made) fake.emit("error", emfile);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(changes, []);
  assert.deepEqual(reports, [[
    { dirPath: "/p/a", recursive: false, message: "macOS can't watch any more folders" },
    { dirPath: "/p", recursive: true, message: "macOS can't watch any more folders" },
  ]]);
  assert.deepEqual(watcher.getWatchedDirs(), []);
  assert.deepEqual(watcher.watch("/p/a", false), { ok: true }, "watching it again starts over");
  assert.equal(made.length, 3);
});
