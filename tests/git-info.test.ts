import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  checkoutGitRef,
  getGitBranches,
  getGitCommitDetail,
  getGitLog,
  initGitRepo,
  isGitRepo,
} from "../electron/git-info.ts";

async function withTempRepo(
  fn: (repoPath: string, remotePath: string, nonRepoPath: string) => Promise<void> | void,
) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-info-test-"));
  const repoPath = path.join(baseDir, "repo");
  const remotePath = path.join(baseDir, "remote.git");
  const nonRepoPath = path.join(baseDir, "plain");

  fs.mkdirSync(repoPath);
  fs.mkdirSync(nonRepoPath);
  execSync("git init --bare remote.git", {
    cwd: baseDir,
    stdio: "pipe",
  });
  execSync("git init -b main", {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.email "test@example.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });

  try {
    await fn(repoPath, remotePath, nonRepoPath);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

test("git info lists branches, topo log, commit detail, and supports checkout", async () => {
  await withTempRepo(async (repoPath, remotePath, nonRepoPath) => {
    fs.writeFileSync(path.join(repoPath, "README.md"), "root\n");
    execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "root commit"', { cwd: repoPath, stdio: "pipe" });
    execSync(`git remote add origin "${remotePath}"`, { cwd: repoPath, stdio: "pipe" });
    execSync("git push -u origin main", { cwd: repoPath, stdio: "pipe" });

    execSync("git checkout -b feature/git-panel", { cwd: repoPath, stdio: "pipe" });
    fs.writeFileSync(path.join(repoPath, "feature.txt"), "feature line\n");
    execSync("git add feature.txt", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "feature branch commit"', { cwd: repoPath, stdio: "pipe" });
    execSync("git push -u origin feature/git-panel", { cwd: repoPath, stdio: "pipe" });

    execSync("git checkout main", { cwd: repoPath, stdio: "pipe" });
    fs.writeFileSync(path.join(repoPath, "README.md"), "root\nmain line\n");
    execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "main branch commit"', { cwd: repoPath, stdio: "pipe" });
    execSync('git merge --no-ff feature/git-panel -m "merge feature branch"', {
      cwd: repoPath,
      stdio: "pipe",
    });

    assert.equal(await isGitRepo(repoPath), true);
    assert.equal(await isGitRepo(nonRepoPath), false);

    const branches = await getGitBranches(repoPath);
    const currentBranch = branches.find((branch) => branch.name === "main");
    const featureBranch = branches.find((branch) => branch.name === "feature/git-panel");
    const remoteBranch = branches.find((branch) => branch.name === "origin/feature/git-panel");

    assert.ok(currentBranch);
    assert.equal(currentBranch.isCurrent, true);
    assert.equal(currentBranch.isRemote, false);
    assert.equal(currentBranch.upstream, "origin/main");
    assert.equal(currentBranch.ahead > 0, true);
    assert.equal(currentBranch.behind, 0);
    assert.ok(featureBranch);
    assert.equal(featureBranch.isRemote, false);
    assert.ok(remoteBranch);
    assert.equal(remoteBranch.isRemote, true);

    const log = await getGitLog(repoPath, 10);
    assert.equal(log[0]?.message, "merge feature branch");
    assert.equal(log[0]?.parents.length, 2);
    assert.equal(log[0]?.refs.some((ref) => ref.includes("HEAD -> main")), true);

    const detail = await getGitCommitDetail(repoPath, log[0].hash);
    assert.match(detail.message, /merge feature branch/);
    assert.match(detail.diff, /diff --git a\/feature\.txt b\/feature\.txt/);
    assert.equal(
      detail.files.some((file) => file.name === "feature.txt"),
      true,
    );

    await checkoutGitRef(repoPath, "feature/git-panel");
    const switchedBranches = await getGitBranches(repoPath);
    const switchedCurrent = switchedBranches.find(
      (branch) => branch.name === "feature/git-panel",
    );

    assert.ok(switchedCurrent);
    assert.equal(switchedCurrent.isCurrent, true);
  });
});

test("initGitRepo turns a plain directory into a repository", async () => {
  await withTempRepo(async (_repoPath, _remotePath, nonRepoPath) => {
    assert.equal(await isGitRepo(nonRepoPath), false);

    await initGitRepo(nonRepoPath);

    assert.equal(await isGitRepo(nonRepoPath), true);
    const branches = await getGitBranches(nonRepoPath);
    assert.equal(branches.some((branch) => branch.name === "main"), true);
  });
});

test("getGitCommitDetail returns null for a missing commit hash", async () => {
  await withTempRepo(async (repoPath) => {
    fs.writeFileSync(path.join(repoPath, "README.md"), "root\n");
    execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "root commit"', { cwd: repoPath, stdio: "pipe" });

    const detail = await getGitCommitDetail(
      repoPath,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );

    assert.equal(detail, null);
  });
});


test("History leaves out Tacit's undo checkpoints", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-log-cp-"));
  const run = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "pipe" }).toString().trim();
  run("git init -q -b main && git config user.email t@t && git config user.name t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  run("git add a.txt && git commit -q -m 'real commit'");
  const tree = run("git write-tree");
  const cp = run(`git commit-tree ${tree} -m '{"v":1,"phase":"end"}'`);
  run(`git update-ref refs/tacit/checkpoints/t1/1-end ${cp}`);
  const log = await getGitLog(repo, 10);
  assert.deepEqual(log.map((e) => e.message), ["real commit"]);
  fs.rmSync(repo, { recursive: true, force: true });
});
