import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { CHECKPOINT_REF_ROOT, CheckpointStore } from "../electron/checkpoints.ts";
import { lastUndoableTurn, resolveTurnRequest, TurnCheckpoints, turnsFromRefs } from "../electron/turn-checkpoints.ts";

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

function withRepo(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turn-checkpoints-test-")));
    try {
      sh(dir, "init", "-q", "-b", "main");
      write(dir, "a.txt", "hello\n");
      write(dir, "b.txt", "keep me\n");
      sh(dir, "add", ".");
      sh(dir, "commit", "-q", "-m", "init");
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** A keeper on a real store, with a clock the test moves. */
function keeper(options: { maxTurns?: number; start?: string; store?: CheckpointStore } = {}) {
  let now = new Date(options.start ?? "2026-10-30T10:00:00Z");
  const logs: string[] = [];
  const changed: string[] = [];
  const turns = new TurnCheckpoints(options.store ?? new CheckpointStore(), {
    now: () => now,
    maxTurns: options.maxTurns,
    log: (m) => logs.push(m),
    onChanged: (id) => changed.push(id),
  });
  return {
    turns,
    logs,
    changed,
    tick(ms = 1000) {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** One whole agent turn: start, the agent's edits, end. */
async function turn(k: ReturnType<typeof keeper>, id: string, dir: string, edit: () => void) {
  k.turns.turnStarted(id, dir);
  k.tick();
  // turnEnded waits for the start to be saved, but the agent's edits must
  // land after it, as they do in a real turn.
  await waitForStart(k, id);
  edit();
  k.tick();
  await k.turns.turnEnded(id);
  k.tick();
}

async function waitForStart(k: ReturnType<typeof keeper>, id: string) {
  const before = k.changed.filter((x) => x === id).length;
  for (let i = 0; i < 200; i++) {
    if (k.changed.filter((x) => x === id).length > before) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("start was never saved");
}

test(
  "a turn saves a start and an end, and undo puts the folder back to before it",
  withRepo(async (dir) => {
    const k = keeper();
    await turn(k, "term-1", dir, () => {
      write(dir, "a.txt", "goodbye\n");
      fs.rmSync(path.join(dir, "b.txt"));
      write(dir, "c.txt", "new\n");
    });

    const list = await k.turns.list("term-1", dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].seq, 1);
    assert.equal(list[0].filesChanged, 3);
    assert.equal(list[0].late, false);
    assert.ok(list[0].endedAt);

    const preview = await k.turns.preview("term-1", dir, 1);
    assert.equal(preview?.files.length, 3);
    assert.equal(preview?.headMoved, false);

    await k.turns.undo("term-1", dir, 1);
    assert.equal(read(dir, "a.txt"), "hello\n");
    assert.equal(read(dir, "b.txt"), "keep me\n");
    assert.equal(read(dir, "c.txt"), null);
    assert.equal(sh(dir, "status", "--porcelain"), "");

    const after = await k.turns.list("term-1", dir);
    assert.equal(after[0].undone, true);
    assert.equal(lastUndoableTurn(after), null, "an undone turn isn't offered again");

    await k.turns.redo("term-1", dir);
    assert.equal(read(dir, "a.txt"), "goodbye\n");
    assert.equal(read(dir, "c.txt"), "new\n");
    assert.equal((await k.turns.list("term-1", dir))[0].undone, false);
  }),
);

test(
  "turns number on from what the repo already holds, even after a restart",
  withRepo(async (dir) => {
    const first = keeper();
    await turn(first, "term-1", dir, () => write(dir, "a.txt", "one\n"));
    await turn(first, "term-1", dir, () => write(dir, "a.txt", "two\n"));

    const restarted = keeper({ start: "2026-10-30T11:00:00Z" });
    await turn(restarted, "term-1", dir, () => write(dir, "a.txt", "three\n"));
    assert.deepEqual((await restarted.turns.list("term-1", dir)).map((t) => t.seq), [3, 2, 1]);

    // Going back to before turn 2 takes back turn 3 as well.
    await restarted.turns.undo("term-1", dir, 2);
    assert.equal(read(dir, "a.txt"), "one\n");
    const list = await restarted.turns.list("term-1", dir);
    assert.deepEqual(list.map((t) => t.undone), [true, true, false]);
    assert.equal(lastUndoableTurn(list)?.seq, 1);
  }),
);

test(
  "a turn that changes nothing is listed but not offered for undo",
  withRepo(async (dir) => {
    const k = keeper();
    await turn(k, "term-1", dir, () => write(dir, "a.txt", "changed\n"));
    await turn(k, "term-1", dir, () => {});
    const list = await k.turns.list("term-1", dir);
    assert.deepEqual(list.map((t) => t.filesChanged), [0, 1]);
    assert.equal(lastUndoableTurn(list)?.seq, 1);
  }),
);

test(
  "a tool used before the start is saved marks the turn late",
  withRepo(async (dir) => {
    const k = keeper();
    k.turns.turnStarted("term-1", dir);
    k.turns.toolUsed("term-1"); // Before the snapshot can have finished.
    write(dir, "a.txt", "fast edit\n");
    await k.turns.turnEnded("term-1");
    assert.equal((await k.turns.list("term-1", dir))[0].late, true);

    await turn(k, "term-1", dir, () => {
      k.turns.toolUsed("term-1"); // After the start was saved.
      write(dir, "a.txt", "slow edit\n");
    });
    assert.equal((await k.turns.list("term-1", dir))[0].late, false);
  }),
);

test(
  "a commit made during the turn is reported, and kept",
  withRepo(async (dir) => {
    const k = keeper();
    await turn(k, "term-1", dir, () => {
      write(dir, "a.txt", "committed by the agent\n");
      sh(dir, "commit", "-q", "-am", "agent commit");
    });
    const head = sh(dir, "rev-parse", "HEAD");
    const preview = await k.turns.preview("term-1", dir, 1);
    assert.equal(preview?.headMoved, true);
    await k.turns.undo("term-1", dir, 1);
    assert.equal(read(dir, "a.txt"), "hello\n");
    assert.equal(sh(dir, "rev-parse", "HEAD"), head, "the branch isn't moved");
  }),
);

test(
  "two terminals in one folder keep separate turns",
  withRepo(async (dir) => {
    const k = keeper();
    await Promise.all([
      turn(k, "claude-1", dir, () => write(dir, "x.txt", "claude\n")),
      turn(k, "codex-1", dir, () => write(dir, "y.txt", "codex\n")),
    ]);
    assert.equal((await k.turns.list("claude-1", dir)).length, 1);
    assert.equal((await k.turns.list("codex-1", dir)).length, 1);
    assert.deepEqual(k.logs, []);
  }),
);

test(
  "old turns beyond the cap are dropped, newest kept",
  withRepo(async (dir) => {
    const k = keeper({ maxTurns: 3 });
    for (let i = 1; i <= 5; i++) await turn(k, "term-1", dir, () => write(dir, "a.txt", `${i}\n`));
    assert.deepEqual((await k.turns.list("term-1", dir)).map((t) => t.seq), [5, 4, 3]);
  }),
);

test(
  "checkpoints older than two weeks are dropped for any terminal in the folder",
  withRepo(async (dir) => {
    const old = keeper({ start: "2026-10-01T10:00:00Z" });
    await turn(old, "gone-1", dir, () => write(dir, "a.txt", "old\n"));
    const fresh = keeper({ start: "2026-10-30T10:00:00Z" });
    await turn(fresh, "term-1", dir, () => write(dir, "a.txt", "new\n"));
    assert.equal((await fresh.turns.list("gone-1", dir)).length, 0);
    assert.equal((await fresh.turns.list("term-1", dir)).length, 1);
  }),
);

test("a folder outside git makes no checkpoints and no noise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-checkpoints-nogit-"));
  try {
    const k = keeper();
    k.turns.turnStarted("term-1", dir);
    write(dir, "a.txt", "x\n");
    await k.turns.turnEnded("term-1");
    assert.deepEqual(await k.turns.list("term-1", dir), []);
    assert.deepEqual(k.logs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bad terminal ids and seqs are refused", withRepo(async (dir) => {
  const k = keeper();
  k.turns.turnStarted("../heads/main", dir);
  await k.turns.turnEnded("../heads/main");
  assert.equal(sh(dir, "for-each-ref", CHECKPOINT_REF_ROOT), "");
  assert.equal(await k.turns.preview("term-1", dir, 0), null);
  assert.equal(await k.turns.undo("term-1", dir, 1.5), null);
  assert.equal(await k.turns.undo("a/b", dir, 1), null);
}));

test("the turn list reads what each ref's message says", () => {
  const ref = (name: string, meta: Record<string, unknown>) => ({
    ref: `${CHECKPOINT_REF_ROOT}/t/${name}`,
    commit: "c",
    meta,
  });
  const list = turnsFromRefs([
    ref("1-start", { at: "2026-10-30T10:00:00Z" }),
    ref("1-end", { at: "2026-10-30T10:01:00Z", files: 2, late: true }),
    ref("2-start", { at: "2026-10-30T10:02:00Z" }),
    ref("3-end", { at: "2026-10-30T10:05:00Z", files: 1 }),
  ]);
  assert.deepEqual(
    list.map((t) => [t.seq, t.filesChanged, t.late, t.endedAt !== null]),
    [
      [2, null, false, false],
      [1, 2, true, true],
    ],
  );
  assert.equal(lastUndoableTurn(list)?.seq, 1, "a turn still running isn't the one undone");
});

test("requests from the window are checked before they reach git", () => {
  const terminals: Record<string, { worktree_path: string; task_status: string; pty_alive: boolean }> = {
    idle: { worktree_path: "/repo", task_status: "idle", pty_alive: true },
    busy: { worktree_path: "/repo", task_status: "running", pty_alive: true },
  };
  const of = (id: string) => terminals[id] ?? null;
  const read = { needsSeq: true, changesFiles: false };
  const change = { needsSeq: true, changesFiles: true };

  assert.deepEqual(resolveTurnRequest({ terminalId: "idle", seq: 2 }, change, of), { ok: true, terminalId: "idle", seq: 2, dir: "/repo" });
  assert.deepEqual(resolveTurnRequest({ terminalId: "busy", seq: 2 }, change, of), { ok: false, reason: "turn-running" });
  assert.equal(resolveTurnRequest({ terminalId: "busy", seq: 2 }, read, of).ok, true, "looking is fine while it runs");
  assert.deepEqual(resolveTurnRequest({ terminalId: "nope", seq: 1 }, read, of), { ok: false, reason: "unknown-terminal" });
  for (const bad of [{ terminalId: 7, seq: 1 }, { terminalId: "../x", seq: 1 }, { terminalId: "idle", seq: 0 }, { terminalId: "idle", seq: "1" }, { terminalId: "idle", seq: 1.5 }]) {
    assert.deepEqual(resolveTurnRequest(bad, change, of), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  }
  assert.equal(resolveTurnRequest({ terminalId: "idle" }, { needsSeq: false, changesFiles: true }, of).ok, true);
});

test(
  "undoing one agent's turn leaves another agent's work in the same folder alone",
  withRepo(async (dir) => {
    const k = keeper();
    await turn(k, "claude-1", dir, () => write(dir, "claude.txt", "from claude\n"));
    await turn(k, "codex-1", dir, () => {
      write(dir, "codex.txt", "from codex\n");
      write(dir, "a.txt", "codex edited a\n");
    });

    const preview = await k.turns.preview("claude-1", dir, 1);
    assert.deepEqual(preview?.files, [{ path: "claude.txt", kind: "added" }]);
    await k.turns.undo("claude-1", dir, 1);
    assert.equal(read(dir, "claude.txt"), null);
    assert.equal(read(dir, "codex.txt"), "from codex\n");
    assert.equal(read(dir, "a.txt"), "codex edited a\n");
  }),
);

test(
  "a file the person changed after the agent's turn is kept, and the preview says so",
  withRepo(async (dir) => {
    const k = keeper();
    await turn(k, "term-1", dir, () => {
      write(dir, "a.txt", "agent\n");
      write(dir, "b.txt", "agent\n");
    });
    write(dir, "a.txt", "agent, then me\n");
    const preview = await k.turns.preview("term-1", dir, 1);
    assert.deepEqual(preview?.files, [{ path: "b.txt", kind: "modified" }]);
    assert.deepEqual(preview?.kept, ["a.txt"]);
    await k.turns.undo("term-1", dir, 1);
    assert.equal(read(dir, "a.txt"), "agent, then me\n");
    assert.equal(read(dir, "b.txt"), "keep me\n");

    // Redo brings back only what the undo changed.
    write(dir, "a.txt", "me again\n");
    assert.deepEqual(await k.turns.redo("term-1", dir), [{ path: "b.txt", kind: "modified" }]);
    assert.equal(read(dir, "b.txt"), "agent\n");
    assert.equal(read(dir, "a.txt"), "me again\n");
    assert.equal(await k.turns.redo("term-1", dir), null, "there's nothing left to redo");
  }),
);

test(
  "a folder too big to save says so instead of failing quietly",
  withRepo(async (dir) => {
    const k = keeper({ store: new CheckpointStore({ maxFiles: 1 }) });
    k.turns.turnStarted("term-1", dir);
    await waitForStart(k, "term-1");
    write(dir, "a.txt", "changed\n");
    await k.turns.turnEnded("term-1");
    assert.equal(k.turns.skippedFor("term-1"), "too-many-files");
    assert.deepEqual(await k.turns.list("term-1", dir), []);
    assert.deepEqual(k.logs, []);
  }),
);
