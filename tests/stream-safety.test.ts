import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { endStream, orFailure, spawnDetached, watchFailure, writeChunk } from "../electron/stream-safety";
import { TranscriptKeeper } from "../electron/transcript-keeper";

// A stream or process that fails reports it to the code waiting on it,
// instead of crashing the main process with an unhandled 'error' (SHR-138).

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stream-safety-${name}-`));
}

test("writing to a file that can't be opened rejects; nothing is thrown at the process", async () => {
  const out = fs.createWriteStream(path.join(tempDir("missing"), "no-such-dir", "file.txt"));
  const failure = watchFailure(out);
  // The file opens after the call returns: a first write is only buffered,
  // and the failure comes back from the next wait.
  await writeChunk(out, "hello\n", failure);
  await assert.rejects(endStream(out, failure), /ENOENT/);
  await assert.rejects(writeChunk(out, "more\n", failure), /ENOENT/, "and every later write says so too");
  assert.match(String(failure.error()), /ENOENT/);
});

test("a wait for 'drain' ends when the stream fails instead of hanging", async () => {
  // A tiny buffer, so the first write asks the caller to wait for 'drain';
  // then the stream fails before draining.
  const out = fs.createWriteStream(path.join(tempDir("drain"), "f.txt"), { highWaterMark: 1 });
  const failure = watchFailure(out);
  const waiting = writeChunk(out, "more than one byte", failure);
  out.destroy(new Error("disk full"));
  await assert.rejects(waiting, /disk full/);
});

test("any step can be raced against the stream failing", async () => {
  const out = fs.createWriteStream(path.join(tempDir("race"), "f.txt"));
  const failure = watchFailure(out);
  const never = new Promise<void>(() => {});
  const step = orFailure(never, failure);
  out.destroy(new Error("write failed"));
  await assert.rejects(step, /write failed/);
});

test("a stream that works writes and ends normally", async () => {
  const file = path.join(tempDir("ok"), "f.txt");
  const out = fs.createWriteStream(file);
  const failure = watchFailure(out);
  await writeChunk(out, "one\n", failure);
  await writeChunk(out, Buffer.from("two\n"), failure);
  await endStream(out, failure);
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
  assert.equal(failure.error(), null);
});

test("a process that can't start is reported to the caller", async () => {
  const err = await new Promise<Error>((resolve) => spawnDetached("/no/such/installer", [], resolve));
  assert.match(err.message, /ENOENT/);
});

test("the transcript keeper reports a copy it can't write and carries on", async (t) => {
  const agentDir = tempDir("agent");
  const sessionFile = path.join(agentDir, "s-1.jsonl");
  fs.writeFileSync(sessionFile, '{"type":"user"}\n');
  const recordDir = tempDir("record");
  // A folder that can't be written to: opening the copy fails
  // asynchronously, the way a full or read-only disk does.
  const folder = path.join(recordDir, "transcripts/claude");
  fs.mkdirSync(folder, { recursive: true });
  fs.chmodSync(folder, 0o500);
  t.after(() => fs.chmodSync(folder, 0o700));
  const target = path.join(folder, "s-1.jsonl");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.map(String).join(" ")));

  await new TranscriptKeeper(recordDir).keep([
    { provider: "claude", sessionId: "s-1", sessionFile },
  ]);
  assert.match(warnings.join("\n"), /couldn't copy claude session s-1: EACCES/);
  assert.equal(fs.existsSync(target), false);
});
