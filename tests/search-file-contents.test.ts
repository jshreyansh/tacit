import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { searchFileContents } from "../electron/search-handlers.ts";

function gitFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-content-search-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "dist-electron"));
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist-electron/\n");
  fs.writeFileSync(path.join(dir, "docs", "release.md"), "# Release steps\nRun release:mac --local (after the bump).\n");
  fs.writeFileSync(path.join(dir, "dist-electron", "main.js"), "Release steps, built copy\n");
  return dir;
}

test("finds the text as typed, case aside, with its line, and skips what git ignores", async () => {
  const dir = gitFolder();
  try {
    const hits = await searchFileContents(dir, "release STEPS");
    assert.deepEqual(hits.map((h) => [path.relative(dir, h.filePath), h.line]), [["docs/release.md", 1]]);
    const literal = await searchFileContents(dir, "--local (after");
    assert.equal(literal.length, 1);
    assert.equal(literal[0].line, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no match is an empty answer, quickly", async () => {
  const dir = gitFolder();
  try {
    const started = Date.now();
    assert.deepEqual(await searchFileContents(dir, "zzqx no such text"), []);
    assert.ok(Date.now() - started < 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
