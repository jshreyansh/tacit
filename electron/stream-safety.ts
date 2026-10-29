import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

/**
 * Writing to files and starting processes without an unhandled 'error'.
 *
 * In Node an emitter that emits 'error' with nobody listening throws, and in
 * the main process that is an uncaught exception: the app goes down. A
 * write stream reports a failed open or write that way, asynchronously, so
 * a try/catch around the code that made it doesn't help; nor does a
 * spawned process that can't start. Waiting for 'drain' on a stream that
 * has failed never ends. (SHR-138: the transcript keeper and the Mac
 * updater.)
 *
 * `watchFailure` attaches the listener the moment a stream exists; the
 * helpers below wait on the stream or its failure, whichever comes first.
 */

export interface StreamFailure {
  /** Rejects with the stream's error, if it ever has one. */
  readonly failed: Promise<never>;
  /** The error, once there is one. */
  error(): Error | null;
}

export function watchFailure(stream: EventEmitter): StreamFailure {
  let error: Error | null = null;
  const failed = new Promise<never>((_, reject) => {
    stream.once("error", (err: Error) => {
      error = err;
      reject(err);
    });
  });
  // Awaited only through the helpers; seen here so a failure nobody is
  // waiting on at that moment isn't an unhandled rejection.
  failed.catch(() => {});
  return { failed, error: () => error };
}

/** Writes one chunk, waiting for 'drain' when the stream asks; rejects if it fails. */
export async function writeChunk(stream: Writable, chunk: string | Buffer, failure: StreamFailure): Promise<void> {
  const already = failure.error();
  if (already) throw already;
  if (stream.write(chunk)) return;
  await Promise.race([new Promise<void>((resolve) => stream.once("drain", () => resolve())), failure.failed]);
}

/** Ends the stream once everything is flushed; rejects if it fails. */
export async function endStream(stream: Writable, failure: StreamFailure): Promise<void> {
  const already = failure.error();
  if (already) throw already;
  await Promise.race([
    new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve()))),
    failure.failed,
  ]);
}

/** Waits for `step`, unless the stream fails first. */
export function orFailure<T>(step: Promise<T>, failure: StreamFailure): Promise<T> {
  return Promise.race([step, failure.failed]);
}

/**
 * Starts a process that outlives this one (the updater's installer).
 * `onError` hears that it couldn't start, which a detached spawn otherwise
 * throws as an uncaught exception.
 */
export function spawnDetached(command: string, args: string[], onError: (err: Error) => void): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", onError);
  child.unref();
}
