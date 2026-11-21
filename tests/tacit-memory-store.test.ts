import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../electron/memory-store.ts";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-memory-"));
  const root = path.join(base, "memory");
  const claude = path.join(base, "claude-projects");
  // /repo is the main folder; /repo/.worktrees/wb is a linked worktree of it.
  const git = (cwd: string) => {
    if (cwd.startsWith("/repo/.worktrees/wb")) return { top: "/repo/.worktrees/wb", common: "/repo/.git" };
    if (cwd.startsWith("/repo")) return { top: "/repo", common: ".git" };
    return null;
  };
  return { base, root, claude, store: new MemoryStore(root, claude, git) };
}

test("every worktree of a repository shares one folder memory", () => {
  const { store } = setup();
  assert.deepEqual(store.placeOf("/repo"), { folder: "/repo", worktree: null });
  assert.deepEqual(store.placeOf("/repo/.worktrees/wb"), { folder: "/repo", worktree: "/repo/.worktrees/wb" });
  assert.deepEqual(store.placeOf("/elsewhere"), { folder: "/elsewhere", worktree: null });

  const main = store.placeOf("/repo");
  const wt = store.placeOf("/repo/.worktrees/wb");
  store.write("folder", wt, { name: "run-tests", kind: "howto", description: "Tests", body: "pnpm test", author: "terminal:a" });
  assert.deepEqual(store.list("folder", main).map((n) => n.name), ["run-tests"]);
  // The worktree's own notes stay with it.
  store.write("worktree", wt, { name: "wip", kind: "fact", description: "WIP", body: "halfway", author: "terminal:a" });
  assert.deepEqual(store.list("worktree", wt).map((n) => n.name), ["wip"]);
  assert.equal(store.dirFor("worktree", main), null);
});

test("writes update in place, mark replaced notes outdated, and skip repeats", () => {
  const { store } = setup();
  const place = { folder: "/repo" };
  const first = store.write("folder", place, { name: "deploy", kind: "fact", description: "Deploy", body: "script A", author: "terminal:a" }, "2026-11-20T10:00:00.000Z");
  assert.equal(first.action, "add");
  const again = store.write("folder", place, { name: "deploy", kind: "fact", description: "Deploy", body: "script A", author: "terminal:b" });
  assert.equal(again.action, "skip");
  const updated = store.write("folder", place, { name: "deploy", kind: "fact", description: "Deploy", body: "script B", author: "terminal:b" });
  assert.equal(updated.action, "update");
  assert.equal(store.get("folder", place, "deploy")?.body, "script B");
  assert.equal(store.get("folder", place, "deploy")?.created, "2026-11-20T10:00:00.000Z");

  store.write("folder", place, { name: "deploy-v2", kind: "fact", description: "Deploy v2", body: "script C", author: "terminal:b", replaces: "deploy" });
  assert.equal(store.get("folder", place, "deploy")?.status, "outdated");
  assert.equal(store.get("folder", place, "deploy")?.replacedBy, "deploy-v2");
});

test("pending notes are listed for review, and approving makes them live", () => {
  const { store } = setup();
  const place = { workdeskId: "canvas-1", folder: "/repo" };
  store.write("you", place, { name: "short-replies", kind: "preference", description: "Keep replies short", body: "They said so twice.", author: "terminal:a" });
  store.write("folder", place, { name: "from-docs", kind: "fact", description: "From the docs", body: "page said X", author: "terminal:a", tainted: true });
  assert.deepEqual(store.pending().map((n) => n.name).sort(), ["from-docs", "short-replies"]);
  assert.ok(store.approve("you", place, "short-replies"));
  assert.equal(store.get("you", place, "short-replies")?.status, "active");
  assert.deepEqual(store.pending().map((n) => n.name), ["from-docs"]);
});

test("forget marks outdated; the person's forget deletes", () => {
  const { store } = setup();
  const place = { folder: "/repo" };
  store.write("folder", place, { name: "x", kind: "fact", description: "X", body: "x", author: "terminal:a" });
  assert.ok(store.forget("folder", place, "x"));
  assert.equal(store.get("folder", place, "x")?.status, "outdated");
  assert.ok(store.forget("folder", place, "x", { delete: true }));
  assert.equal(store.get("folder", place, "x"), null);
  assert.equal(store.forget("folder", place, "nothing"), false);
});

test("the person can restore a note marked outdated from the Memory panel", () => {
  const { store } = setup();
  const place = { folder: "/repo" };
  const { filePath } = store.write("folder", place, { name: "y", kind: "fact", description: "Y", body: "y", author: "terminal:a" });
  assert.ok(filePath && store.actOn(filePath, "forget"));
  assert.equal(store.get("folder", place, "y")?.status, "outdated");
  // Approving is only for notes waiting for the person; restoring is its own action.
  assert.equal(store.actOn(filePath!, "approve"), false);
  assert.ok(store.actOn(filePath!, "restore"));
  assert.equal(store.get("folder", place, "y")?.status, "active");
  assert.equal(store.actOn(filePath!, "restore"), false);
});

test("Claude Code's own memory is read from the repository's folder, read-only", () => {
  const { store, claude } = setup();
  const dir = path.join(claude, "-repo", "memory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [x](x.md)\n");
  fs.writeFileSync(path.join(dir, "boundary.md"), "---\nname: boundary\ndescription: Use window.tacit\nmetadata:\n  type: project\n---\n\nAll capabilities via window.tacit.");
  // From a worktree, the same repository memory.
  const notes = store.claudeMemory(store.placeOf("/repo/.worktrees/wb").folder);
  assert.deepEqual(notes.map((n) => [n.name, n.native, n.kind]), [["boundary", "claude-memory", "fact"]]);
  assert.equal(fs.readdirSync(dir).length, 2, "nothing written into Claude's folder");
});

test("a workdesk id can't escape the memory folder", () => {
  const { store, root } = setup();
  const dir = store.dirFor("workdesk", { workdeskId: "../../evil" })!;
  assert.ok(dir.startsWith(path.join(root, "workdesks")), dir);
});
