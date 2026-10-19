import {
  maskCaptureSecrets,
  normalizeCaptureEntry,
  transcriptPath,
  type CaptureEntry,
  type CaptureNodeRef,
  type LegacyCaptureEntry,
} from "./capture";

/**
 * The record, exported for reading outside the app (SHR-46): the entries of
 * one run or a span of days, as JSON Lines, so jq, a notebook or SQLite can
 * sort, count and diff them without a viewer being built first.
 *
 * The record is already JSON Lines; what an export adds is the scope, one
 * schema (v1 entries normalised to v2), secrets masked as the writer masks
 * them now (entries from before it did included), private entries left out,
 * references to events outside the export marked, and the agents'
 * transcript copies listed. Pure: the CLI reads the files and writes the
 * result.
 */

export const RECORD_EXPORT_VERSION = 1;

/** One run (its `task_id`), or the days from `from` to `to`, as the record's file names (`YYYY-MM-DD`). */
export type RecordExportScope = { run: string } | { from: string; to: string };

/** A day file of the record, by name (`2026-10-19.jsonl`). */
export interface RecordFile {
  name: string;
  text: string;
}

/** An exported entry: the record's own, plus the event references it holds that the export doesn't. */
export type ExportedEntry = CaptureEntry & {
  /** `event:<id>` references (inputs, outputs, evidence) to entries outside this export. */
  outside_refs?: string[];
};

export interface ExportedTranscript {
  provider: string;
  session_id: string;
  node: CaptureNodeRef;
  /** Relative to the record directory. */
  path: string;
}

export interface RecordExportManifest {
  export_version: typeof RECORD_EXPORT_VERSION;
  scope: RecordExportScope;
  /** The day files read. */
  files: string[];
  entries: number;
  by_kind: Record<string, number>;
  /** v1 entries normalised to v2 on the way out. */
  normalised_v1: number;
  /** Entries whose privacy scope is `private`: not exported. */
  omitted_private: number;
  /** Lines that weren't a whole entry: a tail still being written, or a hard kill's. */
  unreadable_lines: number;
  /** References to entries outside the export, as also marked on each entry. */
  outside_refs: number;
  /** The agent sessions the entries name, and where their transcript copies are kept. */
  transcripts: ExportedTranscript[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function isRecordDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The day files a scope reads, in order: a run may span days, so it reads them all. */
export function filesForScope(names: readonly string[], scope: RecordExportScope): string[] {
  return names
    .filter((name) => {
      const day = DAY_FILE.exec(name)?.[1];
      if (!day) return false;
      return "run" in scope || (day >= scope.from && day <= scope.to);
    })
    .sort();
}

function inScope(entry: CaptureEntry, scope: RecordExportScope): boolean {
  if (!("run" in scope)) return true;
  if (entry.task_id === scope.run) return true;
  // A run's own start, naming and end say which run in `run_id`.
  return "run_id" in entry && entry.run_id === scope.run;
}

function eventRefs(entry: CaptureEntry): string[] {
  return [...entry.input_refs, ...entry.output_refs, ...entry.evidence].filter((r) => r.kind === "event").map((r) => r.ref);
}

export function exportRecord(files: readonly RecordFile[], scope: RecordExportScope): { entries: ExportedEntry[]; manifest: RecordExportManifest } {
  const read = files.filter((f) => filesForScope([f.name], scope).length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const entries: ExportedEntry[] = [];
  let unreadable = 0;
  let normalised = 0;
  let omittedPrivate = 0;
  for (const file of read) {
    for (const line of file.text.split("\n")) {
      if (!line.trim()) continue;
      let raw: CaptureEntry | LegacyCaptureEntry;
      try {
        raw = JSON.parse(line) as CaptureEntry | LegacyCaptureEntry;
      } catch {
        unreadable++;
        continue;
      }
      if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") {
        unreadable++;
        continue;
      }
      const entry = normalizeCaptureEntry(raw);
      if (!inScope(entry, scope)) continue;
      // The hatch is not a way round privacy: what's private stays in the app.
      if (entry.privacy_scope === "private") {
        omittedPrivate++;
        continue;
      }
      if (raw.schema_version !== entry.schema_version) normalised++;
      entries.push(maskCaptureSecrets(entry));
    }
  }

  const ids = new Set(entries.map((e) => `event:${e.event_id}`));
  let outside = 0;
  const marked = entries.map((entry): ExportedEntry => {
    const missing = eventRefs(entry).filter((ref) => !ids.has(ref));
    if (missing.length === 0) return entry;
    outside += missing.length;
    return { ...entry, outside_refs: missing };
  });

  const byKind: Record<string, number> = {};
  for (const e of marked) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  // Each session once: from the sessions the entries name, and the runs' own list of them.
  const transcripts = new Map<string, ExportedTranscript>();
  const addTranscript = (provider: string, sessionId: string, node: CaptureNodeRef) => {
    const where = transcriptPath(provider, sessionId);
    const key = `${provider}/${sessionId}`;
    if (where && !transcripts.has(key)) transcripts.set(key, { provider, session_id: sessionId, node, path: where });
  };
  for (const e of marked) {
    if (e.kind === "session") addTranscript(e.provider, e.session_id, e.node);
    if (e.kind === "run_ended") for (const t of e.transcripts ?? []) addTranscript(t.provider, t.session_id, t.node);
  }

  return {
    entries: marked,
    manifest: {
      export_version: RECORD_EXPORT_VERSION,
      scope,
      files: read.map((f) => f.name),
      entries: marked.length,
      by_kind: byKind,
      normalised_v1: normalised,
      omitted_private: omittedPrivate,
      unreadable_lines: unreadable,
      outside_refs: outside,
      transcripts: [...transcripts.values()],
    },
  };
}

/** Entries as JSON Lines: one entry a line, a newline after each (nothing at all when empty). */
export function toJsonLines(entries: readonly ExportedEntry[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

export interface RecordRun {
  run_id: string;
  goal: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Entries in the run, its own start and end included. */
  entries: number;
}

/** The runs the files hold, oldest first, so a run's id can be found to export it. */
export function listRuns(files: readonly RecordFile[]): RecordRun[] {
  const runs = new Map<string, RecordRun>();
  const run = (id: string) => {
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { run_id: id, goal: null, started_at: null, ended_at: null, entries: 0 }));
    return r;
  };
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!DAY_FILE.test(file.name)) continue;
    for (const line of file.text.split("\n")) {
      if (!line.trim()) continue;
      let entry: CaptureEntry;
      try {
        entry = normalizeCaptureEntry(JSON.parse(line) as CaptureEntry | LegacyCaptureEntry);
      } catch {
        continue;
      }
      const id = "run_id" in entry && typeof entry.run_id === "string" ? entry.run_id : entry.task_id;
      if (!id) continue;
      const r = run(id);
      r.entries++;
      if (entry.kind === "run_started") {
        r.started_at = entry.at;
        r.goal = maskCaptureSecrets(entry).goal;
      } else if (entry.kind === "run_named") {
        r.goal = maskCaptureSecrets(entry).goal;
      } else if (entry.kind === "run_ended") {
        r.ended_at = entry.idle_since ?? entry.at;
      }
    }
  }
  return [...runs.values()].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
}
