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

  constructor(dirPath: string, maxFileBytes = 8 * 1024 * 1024) {
    this.dirPath = dirPath;
    this.maxFileBytes = maxFileBytes;
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
      const entry = this.buildEntry(event, canvasId, now, context);
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
    return buildCaptureEnvelope(
      normalizedEvent,
      canvasId,
      now.toISOString(),
      randomUUID(),
      context,
    );
  }
}

/**
 * Lives beside the app's other per-instance artifacts (snapshots, pins) rather
 * than in one shared location, so a dev build's test entries never land in the
 * record a packaged build is accumulating. JSONL merges trivially if the two
 * ever need to become one history.
 */
export function getCaptureDir(termcanvasDir: string): string {
  return path.join(termcanvasDir, "record");
}
