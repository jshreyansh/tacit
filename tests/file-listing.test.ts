import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeFsError, listDirectory, listWorktreeFiles } from "../electron/file-listing.ts";

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-file-listing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function gitRepo(t: test.TestContext, files: string[]): string {
  const dir = tempDir(t);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "x");
  }
  return dir;
}

test("a git project lists its whole tree, untracked files included and ignored ones not", async (t) => {
  const dir = gitRepo(t, ["a.txt", "src/b.ts", "build/out.js", ".gitignore"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  const listing = await listWorktreeFiles(dir);
  assert.equal(listing.type, "git");
  assert.deepEqual([...(listing.type === "git" ? listing.paths : [])].sort(), [".gitignore", "a.txt", "src/b.ts"]);
});

test("a folder that isn't a git repository is never walked: it loads a folder at a time", async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "deep/deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, "deep/deeper/file.txt"), "x");
  assert.deepEqual(await listWorktreeFiles(dir), { type: "lazy", reason: "not-git" });
});

test("a git project over the limit loads a folder at a time", async (t) => {
  const dir = gitRepo(t, ["1.txt", "2.txt", "3.txt"]);
  assert.deepEqual(await listWorktreeFiles(dir, 2), { type: "lazy", reason: "large" });
  assert.equal((await listWorktreeFiles(dir, 3)).type, "git");
});

test("a folder lists one level, folders first, without .git, following links to folders", async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "zeta"));
  fs.mkdirSync(path.join(dir, "alpha/inner"), { recursive: true });
  fs.writeFileSync(path.join(dir, "b.txt"), "x");
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  fs.symlinkSync(path.join(dir, "zeta"), path.join(dir, "link-to-folder"));
  fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "broken-link"));
  assert.deepEqual(await listDirectory(dir), [
    { name: "alpha", isDirectory: true },
    { name: "link-to-folder", isDirectory: true },
    { name: "zeta", isDirectory: true },
    { name: "a.txt", isDirectory: false },
    { name: "b.txt", isDirectory: false },
    { name: "broken-link", isDirectory: false },
  ]);
});

test("a folder that can't be read rejects instead of listing as empty", async (t) => {
  const dir = tempDir(t);
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    await assert.rejects(listDirectory(locked), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  await assert.rejects(listDirectory(path.join(dir, "missing")), /ENOENT/);
});

test("a folder that can't be listed is explained in words", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  assert.match(describeFsError(err("EPERM")), /Privacy & Security/);
  assert.equal(describeFsError(err("EACCES")), "permission denied");
  assert.equal(describeFsError(err("ENOENT")), "it no longer exists");
});
