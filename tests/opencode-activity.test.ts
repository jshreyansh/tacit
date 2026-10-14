import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeActivity } from "../electron/opencode-activity.ts";

async function tempDb(): Promise<{ dir: string; dbPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-opencode-activity-"));
  const dbPath = path.join(dir, "opencode.db");
  fs.writeFileSync(dbPath, "");
  fs.writeFileSync(`${dbPath}-wal`, "");
  // macOS reports these creations to a directory watch started just after;
  // let them pass so a test's first wait isn't ended by its own setup.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { dir, dbPath };
}

/** Whether the promise settles within ms. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([promise.then(() => true as const), late]);
  clearTimeout(timer);
  return result;
}

test("a wait ends when OpenCode writes to its -wal file", async () => {
  const { dir, dbPath } = await tempDb();
  const activity = new OpenCodeActivity(dbPath, 60_000);
  try {
    const waiting = activity.next();
    assert.equal(await settlesWithin(waiting, 400), false, "nothing written yet");
    fs.appendFileSync(`${dbPath}-wal`, "page");
    assert.equal(await settlesWithin(waiting, 2_000), true);
  } finally {
    activity.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a -wal file SQLite replaced is still watched", async () => {
  const { dir, dbPath } = await tempDb();
  const activity = new OpenCodeActivity(dbPath, 60_000);
  try {
    const first = activity.next();
    fs.rmSync(`${dbPath}-wal`);
    fs.writeFileSync(`${dbPath}-wal`, "");
    assert.equal(await settlesWithin(first, 2_000), true, "the replacement is itself a write");
    const second = activity.next();
    assert.equal(await settlesWithin(second, 400), false);
    fs.appendFileSync(`${dbPath}-wal`, "page");
    assert.equal(await settlesWithin(second, 2_000), true);
  } finally {
    activity.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a wait ends on its timer when OpenCode has no database yet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-opencode-activity-"));
  const activity = new OpenCodeActivity(path.join(dir, "missing", "opencode.db"), 100);
  try {
    assert.equal(await settlesWithin(activity.next(), 1_000), true);
  } finally {
    activity.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
