import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { CHECKPOINT_REF_ROOT, CheckpointStore, isSafeRefSegment, reposInside, type TurnSpan } from "../electron/checkpoints.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function write(dir: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function read(dir: string, file: string): string | null {
  const full = path.join(dir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
}

/** A repo with one commit, an ignored folder, and an ignore rule for logs. */
function withRepo(fn: (dir: string) => Promise<void>, options: { commit?: boolean } = {}) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-test-")));
    try {
      sh(dir, "init", "-q", "-b", "main");
      write(dir, ".gitignore", "ignored/\n*.log\n");
      write(dir, "a.txt", "hello\n");
      write(dir, "b.txt", "keep me\n");
      write(dir, "build/tracked.js", "tracked build file\n");
      if (options.commit !== false) {
        sh(dir, "add", ".");
        sh(dir, "commit", "-q", "-m", "init");
      }
      write(dir, "ignored/cache.bin", "ignored\n");
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const ref = (name: string) => `${CHECKPOINT_REF_ROOT}/t1/${name}`;

function commitOf(result: Awaited<ReturnType<CheckpointStore["snapshot"]>>): string {
  assert.ok(result.ok, `snapshot skipped: ${!result.ok ? result.reason : ""}`);
  return result.commit;
}

/** One agent turn in `dir`: a start snapshot, the edits, an end snapshot. */
async function turn(store: CheckpointStore, dir: string, n: number, edits: () => void): Promise<TurnSpan> {
  const start = commitOf(await store.snapshot(dir, ref(`${n}-start`), { seq: n }));
  edits();
  const end = commitOf(await store.snapshot(dir, ref(`${n}-end`), { seq: n }));
  return { start, end };
}

async function undo(store: CheckpointStore, dir: string, target: string, spans: TurnSpan[]) {
  const result = await store.undoTurns(dir, target, spans, { ref: ref("redo"), meta: { phase: "redo" } });
  assert.ok(!("reason" in result), "undo skipped");
  return result;
}

const sorted = <T extends { path: string }>(files: T[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

test(
  "a snapshot leaves HEAD, branch, staging and stash as they were",
  withRepo(async (dir) => {
    write(dir, "staged.txt", "staged\n");
    sh(dir, "add", "staged.txt");
    write(dir, "a.txt", "edited, unstaged\n");
    const state = () => ({
      head: sh(dir, "rev-parse", "HEAD"),
      branch: sh(dir, "branch", "--show-current"),
      cached: sh(dir, "diff", "--cached", "--name-status"),
      status: sh(dir, "status", "--porcelain"),
      stash: sh(dir, "stash", "list"),
    });
    const before = state();
    const commit = commitOf(await new CheckpointStore().snapshot(dir, ref("1-start"), { seq: 1 }));
    assert.deepEqual(state(), before);
    assert.equal(sh(dir, "rev-parse", ref("1-start")).trim(), commit);
  }),
);

test(
  "untracked files are saved, except ignored ones, .env files, dependency and build folders",
  withRepo(async (dir) => {
    write(dir, "new/untracked.txt", "new\n");
    write(dir, ".env", "SECRET=1\n");
    write(dir, "config/.env.local", "SECRET=2\n");
    write(dir, ".env2", "SECRET=3\n");
    write(dir, ".envrc", "export SECRET=4\n");
    write(dir, "secrets/.env/key", "SECRET=5\n");
    write(dir, "node_modules/x/index.js", "dep\n");
    write(dir, "web/dist/bundle.js", "built\n");
    write(dir, ".venv/lib/site.py", "venv\n");
    write(dir, "server.log", "log\n");
    write(dir, "build/tracked.js", "tracked build file, edited\n");
    const commit = commitOf(await new CheckpointStore().snapshot(dir, ref("1-start"), {}));
    const files = sh(dir, "ls-tree", "-r", "--name-only", commit).trim().split("\n");
    assert.ok(files.includes("new/untracked.txt"));
    assert.ok(files.includes("a.txt"));
    assert.equal(sh(dir, "show", `${commit}:build/tracked.js`), "tracked build file, edited\n", "tracked files in build folders are still saved");
    for (const unsaved of [".env", "config/.env.local", ".env2", ".envrc", "secrets/.env/key", "node_modules/x/index.js", "web/dist/bundle.js", ".venv/lib/site.py", "server.log", "ignored/cache.bin"]) {
      assert.ok(!files.includes(unsaved), `${unsaved} must not be saved`);
    }
  }),
);

test(
  "big untracked files aren't saved, and undo never removes them",
  withRepo(async (dir) => {
    const store = new CheckpointStore({ maxUntrackedBytes: 1024 });
    const span = await turn(store, dir, 1, () => {
      write(dir, "dataset.csv", "x".repeat(5000));
      write(dir, "small.txt", "small\n");
    });
    assert.ok(!sh(dir, "ls-tree", "-r", "--name-only", span.end).includes("dataset.csv"));
    const result = await undo(store, dir, span.start, [span]);
    assert.deepEqual(result.files, [{ path: "small.txt", kind: "added" }]);
    assert.equal(read(dir, "small.txt"), null);
    assert.equal(read(dir, "dataset.csv")?.length, 5000, "the big file is left alone");
  }),
);

test(
  "undo puts back what the turn changed, and leaves ignored files, staging and history alone",
  withRepo(async (dir) => {
    write(dir, "staged.txt", "staged\n");
    sh(dir, "add", "staged.txt");
    const store = new CheckpointStore();
    const span = await turn(store, dir, 1, () => {
      write(dir, "a.txt", "goodbye\n");
      fs.rmSync(path.join(dir, "b.txt"));
      write(dir, "c/deep/new.txt", "new\n");
      write(dir, "ignored/cache.bin", "changed\n");
    });

    const preview = await store.undoTurns(dir, span.start, [span]);
    assert.ok(!("reason" in preview));
    assert.deepEqual(sorted(preview.files), [
      { path: "a.txt", kind: "modified" },
      { path: "b.txt", kind: "deleted" },
      { path: "c/deep/new.txt", kind: "added" },
    ]);
    assert.deepEqual(preview.kept, []);
    assert.equal(read(dir, "a.txt"), "goodbye\n", "a preview changes nothing");

    await undo(store, dir, span.start, [span]);
    assert.equal(read(dir, "a.txt"), "hello\n");
    assert.equal(read(dir, "b.txt"), "keep me\n");
    assert.equal(read(dir, "c/deep/new.txt"), null);
    assert.equal(fs.existsSync(path.join(dir, "c")), false, "folders it emptied are removed");
    assert.equal(read(dir, "ignored/cache.bin"), "changed\n", "ignored files are never touched");
    assert.equal(sh(dir, "status", "--porcelain").trim(), "A  staged.txt", "staging is untouched");
    assert.equal(sh(dir, "log", "--oneline").trim().split("\n").length, 1);
  }),
);

test(
  "undo leaves files the turn didn't change, even ones changed by someone else meanwhile",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    const span = await turn(store, dir, 1, () => {
      write(dir, "a.txt", "claude's change\n");
      write(dir, "b.txt", "another agent's change, during the turn\n");
    });
    // The other agent's change landed during the turn, so it is in the
    // turn's diff; after the turn, more edits from it.
    write(dir, "other.txt", "another agent's new file\n");
    const result = await undo(store, dir, span.start, [span]);
    assert.deepEqual(sorted(result.files).map((f) => f.path), ["a.txt", "b.txt"]);
    assert.equal(read(dir, "other.txt"), "another agent's new file\n", "a file the turn didn't touch is never removed");
  }),
);

test(
  "a file changed again after the turn is kept, not overwritten",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    const span = await turn(store, dir, 1, () => {
      write(dir, "a.txt", "agent\n");
      write(dir, "b.txt", "agent too\n");
      write(dir, "made.txt", "agent made this\n");
    });
    write(dir, "a.txt", "agent, then the person\n");
    write(dir, "made.txt", "agent made this, the person edited it\n");

    const result = await undo(store, dir, span.start, [span]);
    assert.deepEqual(result.files, [{ path: "b.txt", kind: "modified" }]);
    assert.deepEqual(result.kept, ["a.txt", "made.txt"]);
    assert.equal(read(dir, "a.txt"), "agent, then the person\n");
    assert.equal(read(dir, "made.txt"), "agent made this, the person edited it\n");
    assert.equal(read(dir, "b.txt"), "keep me\n");
  }),
);

test(
  "going back two turns takes back both, judged by the last turn that touched each file",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    const one = await turn(store, dir, 1, () => {
      write(dir, "a.txt", "one\n");
      write(dir, "x.txt", "x\n");
    });
    const two = await turn(store, dir, 2, () => write(dir, "a.txt", "two\n"));
    const result = await undo(store, dir, one.start, [one, two]);
    assert.deepEqual(sorted(result.files), [
      { path: "a.txt", kind: "modified" },
      { path: "x.txt", kind: "added" },
    ]);
    assert.deepEqual(result.kept, []);
    assert.equal(read(dir, "a.txt"), "hello\n");
    assert.equal(read(dir, "x.txt"), null);
  }),
);

test(
  "redo puts the undone files back as they were",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    const span = await turn(store, dir, 1, () => {
      write(dir, "a.txt", "goodbye\n");
      fs.rmSync(path.join(dir, "b.txt"));
      write(dir, "c.txt", "new\n");
    });
    const undone = await undo(store, dir, span.start, [span]);
    assert.ok(undone.redo);
    write(dir, "unrelated.txt", "made after the undo\n");

    const redone = await store.restorePaths(dir, undone.redo, undone.files.map((f) => f.path));
    assert.ok(Array.isArray(redone));
    assert.equal(redone.length, 3);
    assert.equal(read(dir, "a.txt"), "goodbye\n");
    assert.equal(read(dir, "b.txt"), null);
    assert.equal(read(dir, "c.txt"), "new\n");
    assert.equal(read(dir, "unrelated.txt"), "made after the undo\n");
  }),
);

test(
  "in a subfolder, snapshots and undo stay inside it",
  withRepo(async (dir) => {
    write(dir, "pkg-a/x.txt", "a\n");
    write(dir, "pkg-b/y.txt", "b\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "packages");
    const pkgA = path.join(dir, "pkg-a");
    const store = new CheckpointStore();

    const start = commitOf(await store.snapshot(pkgA, ref("1-start"), {}));
    write(dir, "pkg-a/x.txt", "a, by the agent\n");
    write(dir, "pkg-b/y.txt", "b, by someone else\n");
    write(dir, "root.txt", "outside\n");
    const ended = await store.snapshotSince(pkgA, ref("1-end"), {}, start);
    assert.ok(ended.ok);
    assert.equal(ended.files, 1, "only the folder's own changes count");

    const result = await undo(store, pkgA, start, [{ start, end: ended.commit }]);
    assert.deepEqual(result.files, [{ path: "pkg-a/x.txt", kind: "modified" }]);
    assert.equal(read(dir, "pkg-a/x.txt"), "a\n");
    assert.equal(read(dir, "pkg-b/y.txt"), "b, by someone else\n");
    assert.equal(read(dir, "root.txt"), "outside\n");
  }),
);

test(
  "an agent in a new folder with nothing tracked yet still gets checkpoints",
  withRepo(async (dir) => {
    const fresh = path.join(dir, "fresh");
    write(fresh, "draft.md", "first\n");
    const store = new CheckpointStore();
    const span = await turn(store, fresh, 1, () => {
      write(fresh, "draft.md", "second\n");
      write(fresh, "more.md", "more\n");
    });
    const result = await undo(store, fresh, span.start, [span]);
    assert.deepEqual(sorted(result.files), [
      { path: "fresh/draft.md", kind: "modified" },
      { path: "fresh/more.md", kind: "added" },
    ]);
    assert.equal(read(fresh, "draft.md"), "first\n");
    assert.equal(read(fresh, "more.md"), null);
  }),
);

test(
  "file names that look like patterns are taken literally",
  withRepo(async (dir) => {
    write(dir, "a*.txt", "star\n");
    write(dir, "ab.txt", "plain\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "patterns");
    const store = new CheckpointStore();
    const span = await turn(store, dir, 1, () => {
      write(dir, "a*.txt", "star, changed\n");
      write(dir, "[x].txt", "brackets\n");
    });
    write(dir, "ab.txt", "plain, changed by someone else\n");
    const result = await undo(store, dir, span.start, [span]);
    assert.deepEqual(sorted(result.files).map((f) => f.path), ["[x].txt", "a*.txt"]);
    assert.equal(read(dir, "a*.txt"), "star\n");
    assert.equal(read(dir, "[x].txt"), null);
    assert.equal(read(dir, "ab.txt"), "plain, changed by someone else\n");
  }),
);

test(
  "paths with spaces and non-ASCII names survive a round trip",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    write(dir, "my notes/café 文件.txt", "one\n");
    const span = await turn(store, dir, 1, () => write(dir, "my notes/café 文件.txt", "two\n"));
    const result = await undo(store, dir, span.start, [span]);
    assert.deepEqual(result.files, [{ path: "my notes/café 文件.txt", kind: "modified" }]);
    assert.equal(read(dir, "my notes/café 文件.txt"), "one\n");
  }),
);

test(
  "works in a repo with no commits yet",
  withRepo(
    async (dir) => {
      const store = new CheckpointStore();
      const span = await turn(store, dir, 1, () => write(dir, "a.txt", "changed\n"));
      assert.equal(await store.headOf(dir), null);
      await undo(store, dir, span.start, [span]);
      assert.equal(read(dir, "a.txt"), "hello\n");
    },
    { commit: false },
  ),
);

test(
  "a linked worktree is snapshotted on its own, with refs shared by the repo",
  withRepo(async (dir) => {
    const linked = path.join(dir, "..", `${path.basename(dir)}-wt`);
    sh(dir, "worktree", "add", "-q", "-b", "feature", linked);
    try {
      const store = new CheckpointStore();
      const span = await turn(store, linked, 1, () => write(linked, "a.txt", "in the worktree\n"));
      assert.equal(read(dir, "a.txt"), "hello\n", "the main checkout is untouched");
      await undo(store, linked, span.start, [span]);
      assert.equal(read(linked, "a.txt"), "hello\n");
      assert.equal((await store.list(dir, "t1/")).length, 3, "start, end and redo, seen from the main checkout");
    } finally {
      sh(dir, "worktree", "remove", "--force", linked);
    }
  }),
);

test(
  "a folder with too many files gets no checkpoint, and says why",
  withRepo(async (dir) => {
    const store = new CheckpointStore({ maxFiles: 3 });
    const result = await store.snapshot(dir, ref("1-start"), {});
    assert.deepEqual(result, { ok: false, reason: "too-many-files" });
    assert.equal((await store.list(dir, "t1/")).length, 0);
  }),
);

test(
  "a sparse checkout gets no checkpoint, and says why",
  withRepo(async (dir) => {
    sh(dir, "config", "core.sparseCheckout", "true");
    const store = new CheckpointStore();
    assert.deepEqual(await store.snapshot(dir, ref("1-start"), {}), { ok: false, reason: "sparse-checkout" });
  }),
);

test("a folder outside git is unsupported, not an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-nogit-"));
  try {
    const store = new CheckpointStore();
    assert.deepEqual(await store.scopeOf(dir), { reason: "not-git" });
    assert.deepEqual(await store.snapshot(dir, ref("1-start"), {}), { ok: false, reason: "not-git" });
    assert.deepEqual(await store.list(dir, "t1/"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "refs list with their meta, and only checkpoint refs can be deleted",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    await store.snapshot(dir, ref("1-start"), { seq: 1, phase: "start" });
    await store.snapshot(dir, ref("1-end"), { seq: 1, phase: "end" });
    await store.snapshot(dir, `${CHECKPOINT_REF_ROOT}/t2/1-start`, { seq: 1 });

    const listed = await store.list(dir, "t1/");
    assert.deepEqual(listed.map((r) => r.meta?.phase).sort(), ["end", "start"]);
    await store.deleteRefs(dir, listed.map((r) => r.ref));
    assert.equal((await store.list(dir, "t1/")).length, 0);
    assert.equal((await store.list(dir, "t2/")).length, 1);
    await assert.rejects(store.deleteRefs(dir, ["refs/heads/main"]), /Not a checkpoint ref/);
    await assert.rejects(store.snapshot(dir, "refs/heads/main", {}), /Not a checkpoint ref/);
    assert.ok(sh(dir, "rev-parse", "main"), "branches are never deleted");
  }),
);

test(
  "snapshots of one folder run one at a time",
  withRepo(async (dir) => {
    const store = new CheckpointStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        write(dir, `f${i}.txt`, `${i}\n`);
        return store.snapshot(dir, ref(`${i + 1}-start`), { seq: i + 1 });
      }),
    );
    assert.equal(results.filter((r) => r.ok).length, 6);
    assert.equal((await store.list(dir, "t1/")).length, 6);
  }),
);

test("ref segments from callers are checked", () => {
  assert.ok(isSafeRefSegment("1793365156152-1"));
  assert.ok(isSafeRefSegment("12-start"));
  assert.ok(!isSafeRefSegment("../heads/main"));
  assert.ok(!isSafeRefSegment("a/b"));
  assert.ok(!isSafeRefSegment("x.lock"));
  assert.ok(!isSafeRefSegment(""));
  assert.ok(!isSafeRefSegment("a b"));
});

test("a parent folder names the repos inside it, two levels down, skipping hidden and dependency folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-parent-"));
  try {
    for (const repo of ["undo-hand", "apps/web", "node_modules/pkg", ".cache/clone", "a/b/too-deep"]) {
      fs.mkdirSync(path.join(dir, repo, ".git"), { recursive: true });
    }
    // A linked worktree has a .git file, not a folder.
    fs.mkdirSync(path.join(dir, "wt"));
    fs.writeFileSync(path.join(dir, "wt", ".git"), "gitdir: elsewhere\n");
    fs.mkdirSync(path.join(dir, "notes"));
    assert.deepEqual(reposInside(dir), ["apps/web", "undo-hand", "wt"]);
    assert.deepEqual(reposInside(path.join(dir, "notes")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
