import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCaptureEnvelope,
  captureFileNameFor,
  truncateCaptureText,
  type CaptureEntry,
  type CaptureEvent,
  type CaptureHealth,
  type CaptureRecordContext,
} from "../shared/capture";
import { maskSecrets } from "../shared/secret-mask";

/**
 * Writes the decision record. See shared/capture.ts for what belongs in it.
 *
 * Plain JSONL, one file per local day, in a directory the user owns — no
 * database and no proprietary container, because the point of the record is
 * that it is portable. A record you cannot grep, diff or `git init` is the
 * lock-in this feature exists to avoid, and it would be ours.
 *
 * Every write is best-effort. Capture is an observer of real work: if it
 * cannot write, the correct behaviour is to lose the entry and count it, never
 * to surface an error into a session the user is in the middle of. `getHealth`
 * exists so silent loss is still *visible* on request.
 */
export class CaptureService {
  private readonly dirPath: string;
  private entriesWritten = 0;
  private writeErrors = 0;
  private lastWriteAt: string | null = null;
  private lastError: string | null = null;
  /** Per-file byte ceiling. A spine of choice points is small; anything near
   * this means something is writing activity, which is a bug worth noticing
   * rather than a file worth growing. */
  private readonly maxFileBytes: number;
  private readonly cappedFiles = new Set<string>();
  /** Which agent a node runs, for the entry's `harness` columns. */
  private readonly harnessOf: (ref: string) => string | null;
  /** Names this launch, so `seq` (which restarts at 1) stays unambiguous. */
  private readonly launch = randomUUID().slice(0, 8);
  private seq = 0;
  /**
   * The last value written per key, to skip an entry that repeats it: a
   * canvas's topology, and the URL a browser was last recorded on.
   */
  private readonly lastWritten = new Map<string, string>();
  /** The open run's id for an entry, its `task_id` (electron/run-tracker.ts). */
  private readonly taskIdFor: (event: CaptureEvent) => string | null;
  /** Sees each entry as it's built, whether or not the write lands. */
  private readonly onRecorded: (entry: CaptureEntry) => void;

  constructor(
    dirPath: string,
    maxFileBytes = 8 * 1024 * 1024,
    options: {
      harnessOf?: (ref: string) => string | null;
      taskIdFor?: (event: CaptureEvent) => string | null;
      onRecorded?: (entry: CaptureEntry) => void;
    } = {},
  ) {
    this.dirPath = dirPath;
    this.maxFileBytes = maxFileBytes;
    this.harnessOf = options.harnessOf ?? (() => null);
    this.taskIdFor = options.taskIdFor ?? (() => null);
    this.onRecorded = options.onRecorded ?? (() => {});
  }

  getHealth(): CaptureHealth {
    return {
      dirPath: this.dirPath,
      entriesWritten: this.entriesWritten,
      writeErrors: this.writeErrors,
      lastWriteAt: this.lastWriteAt,
      lastError: this.lastError,
    };
  }

  /**
   * Append one entry. Returns whether it landed, for tests — callers in the
   * app deliberately ignore it.
   */
  record(
    event: CaptureEvent,
    canvasId: string | null,
    now = new Date(),
    context: CaptureRecordContext = {},
  ): boolean {
    try {
      // Before anything reads it: an automatic run is named from the prompt.
      event = maskEventSecrets(event);
      const repeat = repeatKey(event, canvasId);
      if (repeat && this.lastWritten.get(repeat.key) === repeat.value) return true;
      // Asked before building: a prompt with no run open starts one, whose
      // run_started is written first.
      const taskId = context.taskId ?? this.taskIdFor(event);
      const entry = this.buildEntry(event, canvasId, now, { ...context, taskId });
      this.onRecorded(entry);
      const fileName = captureFileNameFor(now);
      const filePath = path.join(this.dirPath, fileName);

      if (this.cappedFiles.has(fileName)) return false;

      fs.mkdirSync(this.dirPath, { recursive: true });

      const line = `${JSON.stringify(entry)}\n`;

      // The line's own size is included so the cap is a true ceiling. Checking
      // only the existing size would let the last entry carry the file past it
      // — bounded overshoot, but then the cap isn't the number it claims.
      let currentSize = 0;
      try {
        currentSize = fs.statSync(filePath).size;
      } catch {
        // No file yet — the normal first write of the day.
      }
      if (currentSize + Buffer.byteLength(line, "utf-8") > this.maxFileBytes) {
        this.cappedFiles.add(fileName);
        this.lastError = `capture file ${fileName} would exceed the ${this.maxFileBytes} byte cap; skipping further entries today`;
        console.warn(`[CaptureService] ${this.lastError}`);
        return false;
      }

      fs.appendFileSync(filePath, line, "utf-8");
      if (repeat) this.lastWritten.set(repeat.key, repeat.value);
      this.entriesWritten++;
      this.lastWriteAt = entry.at;
      return true;
    } catch (err) {
      this.writeErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      // Warn, not error: a failed capture write is not a failure of the work
      // being captured, and shouldn't read like one in the log.
      console.warn("[CaptureService] failed to record entry:", this.lastError);
      return false;
    }
  }

  private buildEntry(
    event: CaptureEvent,
    canvasId: string | null,
    now: Date,
    context: CaptureRecordContext,
  ): CaptureEntry {
    let normalizedEvent = event;
    if (event.kind === "prompt" && typeof event.text === "string") {
      const { text, truncated } = truncateCaptureText(event.text);
      normalizedEvent = {
        ...event,
        text,
        ...(truncated ? { truncated: true as const } : {}),
      };
    }
    const entry = buildCaptureEnvelope(
      normalizedEvent,
      canvasId,
      now.toISOString(),
      context.eventId ?? randomUUID(),
      context,
    );
    const actor = entry.actor_identity.kind === "agent" ? entry.actor_identity.ref : null;
    return {
      ...entry,
      harness: entry.node_ref ? this.harnessOf(entry.node_ref) : null,
      actor_harness: actor ? this.harnessOf(actor) : null,
      // A failed write leaves a gap in seq rather than reusing the number.
      seq: ++this.seq,
      launch: this.launch,
    };
  }
}

/**
 * Lives beside the app's other per-instance artifacts (snapshots, pins) rather
 * than in one shared location, so a dev build's test entries never land in the
 * record a packaged build is accumulating. JSONL merges trivially if the two
 * ever need to become one history.
 */
/**
 * Entries that repeat the last one of their kind add nothing, and made up
 * most of the first 34 days of the record (10 Oct):
 *
 * - topology, a periodic checkpoint: 86% identical to the canvas's last one.
 * - a browser navigating to the URL it was already recorded on (a reload, or
 *   the tile remounting after a restart): 81% of navigations nobody asked for.
 *   A different URL, a new search included, is still written.
 */
function repeatKey(
  event: CaptureEvent,
  canvasId: string | null,
): { key: string; value: string } | null {
  if (event.kind === "topology") {
    return {
      key: `topology\0${canvasId ?? ""}`,
      value: JSON.stringify([event.terminals, event.browsers, event.notes, event.wires]),
    };
  }
  if (event.kind === "browser_action" && event.action === "navigate" && event.by === "system" && event.url) {
    return { key: `navigate\0${event.node}`, value: event.url };
  }
  return null;
}

export function getCaptureDir(tacitDir: string): string {
  return path.join(tacitDir, "record");
}

/** The event with secrets masked in the text a person or agent wrote. */
function maskEventSecrets(event: CaptureEvent): CaptureEvent {
  if (event.kind === "prompt" && typeof event.text === "string") {
    const text = maskSecrets(event.text);
    return text === event.text ? event : { ...event, text };
  }
  if ((event.kind === "run_started" || event.kind === "run_named") && typeof event.goal === "string") {
    const goal = maskSecrets(event.goal);
    return goal === event.goal ? event : { ...event, goal };
  }
  if (event.kind === "journal_write") {
    // A URL can carry a token in its query string.
    return {
      ...event,
      title: maskSecrets(event.title),
      taint_sources: event.taint_sources.map((read) => (read.url ? { ...read, url: maskSecrets(read.url) } : read)),
    };
  }
  if (event.kind === "handoff" && event.files) {
    return { ...event, files: event.files.map((file) => ({ ...file, path: maskSecrets(file.path) })) };
  }
  return event;
}
