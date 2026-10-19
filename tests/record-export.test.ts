import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportRecord, listRuns, toJsonLines, type RecordFile } from "../shared/record-export";
import { runRecordCommand } from "../cli/record";

let n = 0;
/** A v2 entry as the writer leaves it. */
function entry(kind: string, fields: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  n++;
  return {
    kind,
    schema_version: 2,
    event_id: `e${n}`,
    at: `2026-10-19T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    canvas: "c1",
    task_id: null,
    session_id: null,
    actor_identity: { kind: "user", ref: "user" },
    node_ref: null,
    input_refs: [],
    output_refs: [],
    evidence: [],
    intent: "decision",
    privacy_scope: "workspace",
    provenance: { method: "main", source_schema_version: 2 },
    // A session entry's own session_id is the envelope's one field.
    ...fields,
    ...envelope,
  };
}
const day = (name: string, lines: unknown[], tail = ""): RecordFile => ({ name, text: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + tail });

const runA = [
  entry("run_started", { run_id: "run-a", goal: "fix login", started_by: "user" }),
  entry("prompt", { node: "terminal:1", text: "fix the login bug", source: "user" }, { task_id: "run-a", event_id: "pa" }),
  entry("session", { node: "terminal:1", session_id: "sess-1", provider: "claude" }, { task_id: "run-a" }),
  // Points at the paste before it (in the run) and at one from another run.
  entry("prompt", { node: "terminal:1", text: "use this", source: "user" }, { task_id: "run-a", input_refs: [{ ref: "event:pa", kind: "event" }, { ref: "event:elsewhere", kind: "event" }] }),
  entry("run_ended", { run_id: "run-a", reason: "ended", by: "user", transcripts: [{ node: "terminal:2", provider: "codex", session_id: "sess-2", path: "transcripts/codex/sess-2.jsonl" }] }),
];
const runB = [
  entry("run_started", { run_id: "run-b", goal: "write docs", started_by: "user" }),
  entry("prompt", { node: "terminal:3", text: "write the docs", source: "user" }, { task_id: "run-b" }),
];

test("a run's export holds every entry it wrote, across days, and nothing from another run", () => {
  const files = [day("2026-10-18.jsonl", [runA[0], runA[1], runB[0]]), day("2026-10-19.jsonl", [runA[2], runB[1], runA[3], runA[4]]), { name: "notes.txt", text: "not the record" }];
  const { entries, manifest } = exportRecord(files, { run: "run-a" });
  assert.deepEqual(entries.map((e) => e.event_id), runA.map((e) => e.event_id));
  assert.deepEqual(manifest.files, ["2026-10-18.jsonl", "2026-10-19.jsonl"]);
  assert.deepEqual(manifest.by_kind, { run_started: 1, prompt: 2, session: 1, run_ended: 1 });
  // The sessions it names, from its entries and its end's list, once each.
  assert.deepEqual(manifest.transcripts.map((t) => t.path), ["transcripts/claude/sess-1.jsonl", "transcripts/codex/sess-2.jsonl"]);
});

test("a span of days exports those days' files whole", () => {
  const files = [day("2026-10-17.jsonl", [runB[0]]), day("2026-10-18.jsonl", [runA[0]]), day("2026-10-19.jsonl", [runA[1]])];
  const { entries, manifest } = exportRecord(files, { from: "2026-10-18", to: "2026-10-19" });
  assert.deepEqual(entries.map((e) => e.event_id), [runA[0].event_id, runA[1].event_id]);
  assert.deepEqual(manifest.files, ["2026-10-18.jsonl", "2026-10-19.jsonl"]);
});

test("the output is plain JSON Lines: each line parses on its own, and empty is empty", () => {
  const { entries } = exportRecord([day("2026-10-19.jsonl", runA)], { run: "run-a" });
  const text = toJsonLines(entries);
  assert.ok(text.endsWith("\n"));
  const parsed = text.trimEnd().split("\n").map((line) => JSON.parse(line) as { event_id: string });
  assert.deepEqual(parsed.map((e) => e.event_id), runA.map((e) => e.event_id));
  const none = exportRecord([day("2026-10-19.jsonl", runA)], { run: "no-such-run" });
  assert.equal(toJsonLines(none.entries), "");
  assert.equal(none.manifest.entries, 0);
  assert.deepEqual(exportRecord([], { from: "2026-10-19", to: "2026-10-19" }).manifest.files, []);
});

test("v1 entries come out as v2, so the analysis sees one schema", () => {
  const v1 = { schema_version: 1, kind: "spawn", node: "terminal:9", by: "user", parent: null, detail: null, at: "2026-09-01T10:00:00.000Z", canvas: null };
  const { entries, manifest } = exportRecord([day("2026-09-01.jsonl", [v1])], { from: "2026-09-01", to: "2026-09-01" });
  assert.equal(entries[0].schema_version, 2);
  assert.deepEqual(entries[0].provenance, { method: "migration", source_schema_version: 1 });
  assert.equal(entries[0].actor_identity.kind, "user");
  assert.equal(manifest.normalised_v1, 1);
});

test("a reference to an entry outside the export is marked; one inside isn't", () => {
  const { entries, manifest } = exportRecord([day("2026-10-19.jsonl", runA)], { run: "run-a" });
  const withRefs = entries.find((e) => e.input_refs.length > 0)!;
  assert.deepEqual(withRefs.outside_refs, ["event:elsewhere"]);
  assert.equal(entries.filter((e) => e.outside_refs).length, 1);
  assert.equal(manifest.outside_refs, 1);
});

test("the export is not a way round privacy: private entries stay out, secrets are masked as the writer masks them", () => {
  const old = entry("prompt", { node: "terminal:1", text: "deploy with sk-ant-abcdefghijklmnopqrstuvwxyz0123 and the OTP is 482913", source: "user" }, { task_id: "run-a" });
  const hidden = entry("prompt", { node: "terminal:1", text: "between us", source: "user" }, { task_id: "run-a", privacy_scope: "private" });
  const redacted = entry("prompt", { node: "terminal:1", text: "[redacted]", source: "user" }, { task_id: "run-a", privacy_scope: "redacted" });
  const goal = entry("run_started", { run_id: "run-a", goal: "rotate sk-proj-abcdefghijklmnopqrstuvwx", started_by: "user" });
  const { entries, manifest } = exportRecord([day("2026-10-19.jsonl", [goal, old, hidden, redacted])], { run: "run-a" });
  const text = toJsonLines(entries);
  assert.ok(!text.includes("between us"));
  assert.ok(!text.includes("sk-ant-abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(!text.includes("sk-proj-abcdefghijklmnopqrstuvwx"));
  assert.ok(!text.includes("482913"));
  assert.ok(text.includes("[redacted]"));
  assert.equal(manifest.omitted_private, 1);
  assert.equal(manifest.entries, 3);
});

test("exporting while the app writes: a half-written last line is skipped, the rest is whole", () => {
  const live = day("2026-10-19.jsonl", runA, '{"kind":"prompt","node":"terminal:1","te');
  const { entries, manifest } = exportRecord([live], { run: "run-a" });
  assert.equal(entries.length, runA.length);
  assert.equal(manifest.unreadable_lines, 1);
});

test("runs are listed with their goal, start, end and size, to find one to export", () => {
  const runs = listRuns([day("2026-10-19.jsonl", [...runA, ...runB])]);
  assert.deepEqual(
    runs.map((r) => [r.run_id, r.goal, r.entries, r.ended_at !== null]),
    [
      ["run-a", "fix login", 5, true],
      ["run-b", "write docs", 2, false],
    ],
  );
});

test("the CLI writes entries and a manifest beside them, copies transcripts when asked, and says what's wrong with its arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-record-export-"));
  try {
    const record = path.join(dir, "record");
    fs.mkdirSync(path.join(record, "transcripts", "claude"), { recursive: true });
    fs.writeFileSync(path.join(record, "2026-10-19.jsonl"), day("2026-10-19.jsonl", [...runA, ...runB]).text);
    fs.writeFileSync(path.join(record, "transcripts", "claude", "sess-1.jsonl"), '{"type":"user"}\n');
    const out = path.join(dir, "out");
    const said: string[] = [];
    const io = { stdout: (s: string) => said.push(s), stderr: (s: string) => said.push(s) };

    assert.equal(runRecordCommand("export", ["--run", "run-a", "--out", out, "--with-transcripts", "--record-dir", record], io, false), 0);
    const lines = fs.readFileSync(path.join(out, "entries.jsonl"), "utf8").trimEnd().split("\n");
    assert.equal(lines.length, runA.length);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.transcripts.map((t: { path: string; in_record: boolean }) => [t.path, t.in_record]), [
      ["transcripts/claude/sess-1.jsonl", true],
      ["transcripts/codex/sess-2.jsonl", false],
    ]);
    assert.ok(fs.existsSync(path.join(out, "transcripts", "claude", "sess-1.jsonl")));
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith(".tmp")), []);

    // To stdout: just the entries, for jq.
    said.length = 0;
    const printed: string[] = [];
    assert.equal(runRecordCommand("export", ["--day", "2026-10-19", "--record-dir", record], { stdout: (s) => printed.push(s), stderr: () => {} }, false), 0);
    assert.equal(printed.join("").trimEnd().split("\n").length, runA.length + runB.length);

    assert.equal(runRecordCommand("export", ["--record-dir", record], io, false), 1);
    assert.equal(runRecordCommand("export", ["--run", "run-a", "--day", "2026-10-19", "--record-dir", record], io, false), 1);
    assert.equal(runRecordCommand("export", ["--day", "19-10-2026", "--record-dir", record], io, false), 1);
    assert.equal(runRecordCommand("export", ["--from", "2026-10-19", "--to", "2026-10-01", "--record-dir", record], io, false), 1);
    assert.throws(() => runRecordCommand("runs", ["--record-dir", path.join(dir, "missing")], io, false), /No record at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
