import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkProjectInstructions,
  holdsHomeFolder,
  setUpProjectInstructions,
} from "../electron/project-instructions.ts";

// Which folders are offered Tacit's agent instructions, and what they get.
// Tasks and Notes work in any folder, so a plain folder (research notes, say)
// is offered them too; multi-agent workflows need git, so only a repo gets
// that section. The home folder is never offered: every agent started
// anywhere under it would read what's written there.

function tempDir(t: test.TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t: test.TestContext): string {
  const dir = tempDir(t, "tacit-instr-repo-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf-8");

test("the home folder, and folders holding it, are never offered or written", async (t) => {
  const root = tempDir(t, "tacit-instr-home-");
  const home = path.join(root, "Users", "someone");
  fs.mkdirSync(home, { recursive: true });

  for (const dir of [home, path.dirname(home), root]) {
    assert.ok(holdsHomeFolder(dir, home));
    assert.deepEqual(await checkProjectInstructions(dir, home), { offered: false, reason: "home" });
    const result = await setUpProjectInstructions(dir, home);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(dir, "CLAUDE.md")), false);
  }
  // A project inside the home folder is fine.
  const project = path.join(home, "notes");
  fs.mkdirSync(project);
  assert.equal(holdsHomeFolder(project, home), false);
  assert.equal((await checkProjectInstructions(project, home)).offered, true);
});

test("a plain folder is offered tasks and notes, without the multi-agent section", async (t) => {
  const dir = tempDir(t, "tacit-instr-plain-");
  const status = await checkProjectInstructions(dir, "/nowhere");
  assert.deepEqual(status, {
    offered: true,
    status: "missing",
    workflows: false,
    removesWorkflows: false,
    files: [
      { name: "AGENTS.md", exists: false, git: null },
      { name: "CLAUDE.md", exists: false, git: null },
    ],
  });

  const result = await setUpProjectInstructions(dir, "/nowhere");
  assert.equal(result.ok, true);
  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /## Tacit Pin System/);
  assert.doesNotMatch(agents, /## Hydra/);
  assert.match(read(dir, "CLAUDE.md"), /^@AGENTS\.md$/m);
  const after = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(after.offered && after.status === "current");
});

test("a git repo gets both sections, and the prompt says which files git tracks", async (t) => {
  const dir = gitRepo(t);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "AGENTS.md\n");
  execFileSync("git", ["add", "CLAUDE.md", ".gitignore"], { cwd: dir });

  const status = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(status.offered);
  assert.equal(status.workflows, true);
  assert.equal(status.removesWorkflows, false);
  assert.deepEqual(status.files, [
    { name: "AGENTS.md", exists: false, git: "ignored" },
    { name: "CLAUDE.md", exists: true, git: "tracked" },
  ]);

  await setUpProjectInstructions(dir, "/nowhere");
  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /## Hydra Orchestration Toolkit/);
  assert.match(agents, /## Tacit Pin System/);
  assert.match(read(dir, "CLAUDE.md"), /^# Team rules\n\n## Shared Agent Instructions[\s\S]*^@AGENTS\.md$/m);
});

test("a plain folder an older Tacit gave the multi-agent section loses it on update", async (t) => {
  // Older versions wrote both sections into both files of any folder,
  // git or not. Hydra's workers each need a git branch, so there the
  // section only describes commands that fail.
  const dir = tempDir(t, "tacit-instr-had-hydra-");
  const old = "## Hydra Orchestration Toolkit\n\nOld hydra.\n\n## Tacit Pin System\n\nOld pins.\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), old);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), `# My notes\n\nBe brief.\n\n${old}`);

  const status = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(status.offered);
  assert.equal(status.status, "outdated");
  assert.equal(status.workflows, false);
  assert.equal(status.removesWorkflows, true);

  const result = await setUpProjectInstructions(dir, "/nowhere");
  assert.equal(result.ok, true);
  const agents = read(dir, "AGENTS.md");
  assert.doesNotMatch(agents, /Hydra/);
  assert.match(agents, /^## Tacit Pin System/);
  const claude = read(dir, "CLAUDE.md");
  assert.doesNotMatch(claude, /Hydra|Tacit Pin System/);
  assert.match(claude, /^# My notes\n\nBe brief\.\n\n## Shared Agent Instructions[\s\S]*^@AGENTS\.md$/m);

  const after = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(after.offered);
  assert.equal(after.status, "current");
  assert.equal(after.removesWorkflows, false);
});

test("a plain folder holding only the multi-agent section is offered an update, not a fresh setup", async (t) => {
  const dir = tempDir(t, "tacit-instr-only-hydra-");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "## Hydra Orchestration Toolkit\n\nOld.\n");
  const status = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(status.offered && status.status === "outdated" && status.removesWorkflows);
});

test("checking an out-of-date project only reads it", async (t) => {
  // It used to rewrite both files on the spot, without asking.
  const dir = gitRepo(t);
  const old = "## Tacit Pin System\n\nOld.\n\n## Hydra Orchestration Toolkit\n\nOld.\n";
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), old);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), old);
  const status = await checkProjectInstructions(dir, "/nowhere");
  assert.ok(status.offered && status.status === "outdated");
  assert.equal(read(dir, "CLAUDE.md"), old);
  assert.equal(read(dir, "AGENTS.md"), old);
});

test("anything but an absolute path to a folder is refused", async (t) => {
  const dir = tempDir(t, "tacit-instr-args-");
  const file = path.join(dir, "file.txt");
  fs.writeFileSync(file, "x");
  for (const bad of ["relative/path", 42, null, file, path.join(dir, "missing")]) {
    await assert.rejects(checkProjectInstructions(bad, "/nowhere"));
    await assert.rejects(setUpProjectInstructions(bad, "/nowhere"));
  }
  assert.deepEqual(fs.readdirSync(dir), ["file.txt"]);
});
