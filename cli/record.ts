import fs from "fs";
import path from "path";
import { getTacitDataDir, resolveTacitInstance } from "../shared/tacit-instance";
import {
  exportRecord,
  filesForScope,
  isRecordDay,
  listRuns,
  toJsonLines,
  type RecordExportScope,
  type RecordFile,
} from "../shared/record-export";

/**
 * `tacit record`: the decision record, read from its files, so it works with
 * the app closed (SHR-46).
 *
 *   tacit record runs [--day D | --from D --to D]
 *   tacit record export (--run <id> | --day D | --from D --to D) [--out <dir>] [--with-transcripts]
 *
 * Without --out the entries go to stdout as JSON Lines, for jq, and what
 * was exported to stderr. With --out they're written to <dir>/entries.jsonl
 * with <dir>/manifest.json beside them, and --with-transcripts copies the
 * agents' transcripts the entries name into <dir>/transcripts.
 * TACIT_INSTANCE=dev reads the development app's record; --record-dir any other.
 */

export const RECORD_USAGE =
  "  record runs [--day D | --from D --to D]       List context runs (ids to export)\n" +
  "  record export --run <id> | --day D | --from D --to D [--out <dir>] [--with-transcripts]\n" +
  "                                              Export the record as JSON Lines";

export interface RecordIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function dayScope(args: readonly string[]): { from: string; to: string } | string | null {
  const day = flag(args, "--day");
  const from = flag(args, "--from") ?? day;
  const to = flag(args, "--to") ?? day ?? from;
  if (!from && !to) return null;
  if (!from || !to || !isRecordDay(from) || !isRecordDay(to)) return "Days are YYYY-MM-DD: --day 2026-10-19, or --from 2026-10-13 --to 2026-10-19.";
  if (from > to) return `--from ${from} is after --to ${to}.`;
  return { from, to };
}

function readFiles(dir: string, scope: RecordExportScope | null): RecordFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    throw new Error(`No record at ${dir}. Is this the right app? TACIT_INSTANCE=dev reads the development one; --record-dir any folder.`);
  }
  const wanted = scope ? filesForScope(names, scope) : filesForScope(names, { run: "" });
  return wanted.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));
}

/** Writes a file whole: to a temporary name beside it, then renamed over it. */
function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

export function runRecordCommand(command: string | undefined, args: readonly string[], io: RecordIo, json: boolean, env = process.env): number {
  const dir = flag(args, "--record-dir") ?? path.join(getTacitDataDir(resolveTacitInstance(env)), "record");

  if (command === "runs") {
    const days = dayScope(args);
    if (typeof days === "string") {
      io.stderr(`${days}\n`);
      return 1;
    }
    const runs = listRuns(readFiles(dir, days));
    // A run listed for a span of days is one that started in it.
    const shown = days ? runs.filter((r) => r.started_at && r.started_at.slice(0, 10) >= days.from && r.started_at.slice(0, 10) <= days.to) : runs;
    if (json) io.stdout(`${JSON.stringify(shown, null, 2)}\n`);
    else if (shown.length === 0) io.stdout("No runs.\n");
    else for (const r of shown) io.stdout(`${r.run_id}  ${r.started_at ?? "?"}  ${r.entries} entries  ${r.goal ?? "(untitled)"}\n`);
    return 0;
  }

  if (command === "export") {
    const run = flag(args, "--run");
    const days = dayScope(args);
    if (typeof days === "string") {
      io.stderr(`${days}\n`);
      return 1;
    }
    if (!!run === !!days) {
      io.stderr("Say what to export: --run <id> (from `tacit record runs`), or --day / --from --to.\n");
      return 1;
    }
    const scope: RecordExportScope = run ? { run } : days!;
    const { entries, manifest } = exportRecord(readFiles(dir, scope), scope);
    const out = flag(args, "--out");
    const summary =
      `${manifest.entries} entries from ${manifest.files.length} day file(s)` +
      (manifest.normalised_v1 ? `, ${manifest.normalised_v1} normalised from v1` : "") +
      (manifest.omitted_private ? `, ${manifest.omitted_private} private left out` : "") +
      (manifest.unreadable_lines ? `, ${manifest.unreadable_lines} unreadable line(s) skipped` : "") +
      (manifest.outside_refs ? `, ${manifest.outside_refs} reference(s) to entries outside it` : "") +
      `; ${manifest.transcripts.length} transcript(s) named.`;
    if (!out) {
      io.stdout(toJsonLines(entries));
      io.stderr(`${summary}\n`);
      return 0;
    }
    fs.mkdirSync(out, { recursive: true });
    writeWhole(path.join(out, "entries.jsonl"), toJsonLines(entries));
    const transcripts = manifest.transcripts.map((t) => ({ ...t, in_record: fs.existsSync(path.join(dir, t.path)) }));
    if (args.includes("--with-transcripts")) {
      for (const t of transcripts) {
        if (!t.in_record) continue;
        const target = path.join(out, t.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(dir, t.path), target);
      }
    }
    writeWhole(path.join(out, "manifest.json"), `${JSON.stringify({ ...manifest, record_dir: dir, transcripts }, null, 2)}\n`);
    io.stderr(`${summary}\nWrote ${path.join(out, "entries.jsonl")} and manifest.json.\n`);
    return 0;
  }

  io.stderr(`Usage:\n${RECORD_USAGE}\n`);
  return 1;
}
