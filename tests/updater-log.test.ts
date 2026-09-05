import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdaterLog } from "../electron/updater-log";

function scratch(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-updater-log-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("every decision is recorded with the reason that produced it", () => {
  const { dir, cleanup } = scratch();
  try {
    const log = new UpdaterLog(dir);
    log.record({ outcome: "up-to-date", reason: "not-newer", currentVersion: "0.39.14", remoteVersion: "0.39.14" });
    log.record({ outcome: "skipped", reason: "location-not-writable", detail: "/Volumes/Tacit" });

    const entries = log.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.reason, "not-newer");
    assert.equal(entries[1]?.detail, "/Volumes/Tacit");
    // Without a timestamp, "it checked" and "it checked an hour ago" are the
    // same line, and the second is the one that explains a stale app.
    assert.match(entries[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test("the file stays bounded", () => {
  const { dir, cleanup } = scratch();
  try {
    const log = new UpdaterLog(dir);
    for (let i = 0; i < 260; i += 1) {
      log.record({ outcome: "up-to-date", reason: "not-newer", detail: String(i) });
    }
    const entries = log.read();
    assert.equal(entries.length, 200);
    // Oldest dropped, newest kept — a log that discards the latest check would
    // be worse than none.
    assert.equal(entries.at(-1)?.detail, "259");
  } finally {
    cleanup();
  }
});

test("a damaged line is skipped rather than losing the whole log", () => {
  const { dir, cleanup } = scratch();
  try {
    const log = new UpdaterLog(dir);
    log.record({ outcome: "newer", reason: "downloading" });
    fs.appendFileSync(log.path, "this is not json\n");
    log.record({ outcome: "newer", reason: "downloaded" });

    const entries = log.read();
    assert.deepEqual(entries.map((e) => e.reason), ["downloading", "downloaded"]);
  } finally {
    cleanup();
  }
});

test("reading a log that was never written is empty, not an error", () => {
  const { dir, cleanup } = scratch();
  try {
    assert.deepEqual(new UpdaterLog(path.join(dir, "nope")).read(), []);
  } finally {
    cleanup();
  }
});
