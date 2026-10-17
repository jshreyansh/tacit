import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { transcriptPath } from "../shared/capture";
import { maskSecrets } from "../shared/secret-mask";
import { exportOpenCodeSession } from "./opencode-session";
import { RECORD_DIR_MODE, RECORD_FILE_MODE } from "./capture-service";

/**
 * Keeps a copy of each agent session a run used, under the record
 * (`record/transcripts/<provider>/<session_id>.jsonl`), so an agent's own
 * cleanup can't take it before the week's analysis (Claude deletes
 * transcripts after `cleanupPeriodDays`, 30 by default). SHR-115.
 *
 * One copy per session, not per run: transcripts only grow, so the latest
 * copy holds every earlier run's part, and a session used by many short runs
 * isn't copied many times. Secrets are masked line by line on the way.
 * Claude's subagent transcripts (`<session>/subagents/`) come along.
 */

export interface TranscriptSource {
  provider: string;
  sessionId: string;
  /** Claude's and Codex's transcript file; OpenCode's database. */
  sessionFile: string | null;
}

export class TranscriptKeeper {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly recordDir: string) {}

  /** Copies each session's transcript. Copies run one at a time, in order. */
  keep(sources: TranscriptSource[]): Promise<void> {
    const run = this.queue.then(async () => {
      for (const source of sources) {
        try {
          await this.keepOne(source);
        } catch (error) {
          // The record still names the session; only this copy is missing.
          console.warn(
            `[TranscriptKeeper] couldn't copy ${source.provider} session ${source.sessionId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    });
    this.queue = run;
    return run;
  }

  private async keepOne(source: TranscriptSource): Promise<void> {
    const relative = transcriptPath(source.provider, source.sessionId);
    if (!relative || !source.sessionFile) return;
    const target = path.join(this.recordDir, relative);
    if (source.provider === "opencode") {
      const lines = exportOpenCodeSession(source.sessionFile, source.sessionId);
      if (!lines) throw new Error("OpenCode's database couldn't be read");
      writeMasked(target, lines);
      return;
    }
    await copyMasked(source.sessionFile, target);
    if (source.provider === "claude") await this.keepClaudeSubagents(source.sessionFile, target);
  }

  /** `<session>/subagents/*` beside the session file, to `<copy>/subagents/`. */
  private async keepClaudeSubagents(sessionFile: string, target: string): Promise<void> {
    const from = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
    let names: string[];
    try {
      names = fs.readdirSync(from);
    } catch {
      return; // No subagents in this session.
    }
    const to = path.join(target.replace(/\.jsonl$/, ""), "subagents");
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+\.(jsonl|json)$/.test(name)) continue;
      await copyMasked(path.join(from, name), path.join(to, name));
    }
  }
}

/** Copies a text file line by line, masked, replacing the target at the end. */
async function copyMasked(from: string, to: string): Promise<void> {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: RECORD_DIR_MODE });
  const temp = `${to}.${process.pid}.tmp`;
  const out = fs.createWriteStream(temp, { encoding: "utf-8", mode: RECORD_FILE_MODE });
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(from, { encoding: "utf-8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!out.write(`${maskSecrets(line)}\n`)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    fs.renameSync(temp, to);
  } catch (error) {
    out.destroy();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function writeMasked(to: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: RECORD_DIR_MODE });
  const temp = `${to}.${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.map((line) => `${maskSecrets(line)}\n`).join(""), { encoding: "utf-8", mode: RECORD_FILE_MODE });
  fs.renameSync(temp, to);
}
