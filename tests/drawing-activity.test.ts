import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CaptureService } from "../electron/capture-service";
import { RecallService } from "../electron/recall-service";
import { drawingRequestEntry, type CanvasRequest } from "../shared/canvas-ops";

const request = (id: string, more: Partial<CanvasRequest> = {}): CanvasRequest => ({
  id,
  workdesk: "w",
  terminalId: "codex1",
  name: "Codex",
  agent: "codex",
  kind: "change",
  changes: [{ id: "e1", text: "jazz" }],
  targets: ["e1"],
  titles: ["maza"],
  at: 1,
  ...more,
});

test("Activity shows a drawing request as one line, saying how it ended", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-activity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = new CaptureService(dir);
  let at = Date.parse("2026-11-25T10:00:00Z");
  const write = (r: CanvasRequest, state: Parameters<typeof drawingRequestEntry>[1], note?: string) => capture.record(drawingRequestEntry(r, state, note), r.workdesk, new Date((at += 1000)));
  const rename = request("cr-1");
  const remove = request("cr-2", { kind: "delete", changes: undefined, ids: ["e2"], targets: ["e2"], titles: ["Old notes"] });
  const waiting = request("cr-3", { changes: [{ id: "e3", color: "green" }], targets: ["e3"], titles: ["Plan"] });
  const elsewhere = request("cr-4", { workdesk: "other" });
  write(rename, "asked");
  write(remove, "asked");
  write(waiting, "asked");
  write(elsewhere, "asked");
  write(rename, "allowed");
  write(remove, "denied", "keep them, I still need them; my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");

  const rows = new RecallService(dir, () => null).listRecord({ canvasId: "w" }).filter((r) => r.kind === "drawing_request");
  assert.equal(rows.length, 3, "one line for each request: its asking is folded into its end");
  assert.match(rows[0].summary, /^terminal:codex1 asked to delete "Old notes" — you said no: "keep them, I still need them; my key is /);
  assert.equal(rows[1].summary, `terminal:codex1 asked to rename "maza" to "jazz" — you allowed it once`);
  assert.equal(rows[2].summary, `terminal:codex1 asked to change "Plan" — waiting for your answer`);
  assert.doesNotMatch(rows[0].summary, /sk-ant-api03/, "what you wrote is masked like everything else in the record");
  assert.deepEqual(rows.map((r) => r.drawings), [["e2"], ["e1"], ["e3"]]);
  assert.deepEqual(rows.map((r) => r.intent), ["decision", "decision", "observation"], "your answers are decisions; the asking isn't yours");
});

test("every way a request ends has its words", () => {
  const r = request("cr-9", { titles: ["A", "B"], targets: ["a", "b"], changes: [{ id: "a", fill: "solid" }, { id: "b", fill: "solid" }] } as Partial<CanvasRequest>);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-activity-"));
  try {
    const capture = new CaptureService(dir);
    for (const [state, note] of [["allowed_always"], ["failed", "There's no drawing with the id a."], ["dropped"]] as const) {
      capture.record(drawingRequestEntry({ ...r, id: `cr-${state}` }, state, note), "w");
    }
    const lines = new RecallService(dir, () => null).listRecord({ canvasId: "w" }).map((x) => x.summary.replace(/^terminal:codex1 asked to change 2 drawings \("A", "B"\) — /, ""));
    assert.deepEqual(lines, ["not answered: its agent closed first", "you allowed it, but it couldn't be done: There's no drawing with the id a.", "you allowed it, and always for those drawings"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
