import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSessionFile, isSessionFile } from "../electron/manager-chat/session-file";

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-session-file-"));
  const write = (rel: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    return file;
  };
  return { dir, write };
}

test("a Claude session's record is found in any project folder", () => {
  const { dir, write } = home();
  const file = write(".claude/projects/-Users-me-repo/3c40b8c7-0982-4f1f-b755-d627e8102280.jsonl");
  write(".claude/projects/-Users-me-other/aaaaaaaa-0000-0000-0000-000000000000.jsonl");
  assert.equal(findSessionFile("claude", "3c40b8c7-0982-4f1f-b755-d627e8102280", dir), file);
  assert.equal(findSessionFile("claude", "bbbbbbbb-0000-0000-0000-000000000000", dir), null);
});

test("a Codex session's rollout is found by the id its name ends in", () => {
  const { dir, write } = home();
  write(".codex/sessions/2026/10/16/rollout-2026-10-16T09-00-00-01a14000-0000-7000-8000-000000000000.jsonl");
  const file = write(".codex/sessions/2026/10/17/rollout-2026-10-17T18-29-45-01a149f2-65e5-7a82-afcb-d973a82f448b.jsonl");
  assert.equal(findSessionFile("codex", "01a149f2-65e5-7a82-afcb-d973a82f448b", dir), file);
  assert.equal(findSessionFile("codex", "01a149f2-0000-0000-0000-000000000000", dir), null);
});

test("an id that isn't one finds nothing, and reaches no other folder", () => {
  const { dir, write } = home();
  write(".claude/secret.jsonl");
  write(".claude/projects/p/x.jsonl");
  for (const bad of ["../secret", "../../.claude/secret", "x", "", "a/b/c/d/e/f/g/h", "a".repeat(80)]) {
    assert.equal(findSessionFile("claude", bad, dir), null, bad);
    assert.equal(findSessionFile("codex", bad, dir), null, bad);
  }
});

test("no agent folders at all is no record, not an error", () => {
  const { dir } = home();
  assert.equal(findSessionFile("claude", "3c40b8c7-0982-4f1f-b755-d627e8102280", dir), null);
  assert.equal(findSessionFile("codex", "01a149f2-65e5-7a82-afcb-d973a82f448b", dir), null);
});

test("only an agent's session record opens as a past session: no other file, however the path is written", () => {
  const { dir, write } = home();
  const claude = write(".claude/projects/-Users-me-repo/3c40b8c7-0982-4f1f-b755-d627e8102280.jsonl");
  const codex = write(".codex/sessions/2026/10/17/rollout-2026-10-17T18-29-45-01a149f2.jsonl");
  const archived = write(".codex/archived_sessions/rollout-2026-10-01T00-00-00-0aa.jsonl");
  const kimi = write(".kimi/sessions/abc/def/context.jsonl");
  for (const file of [claude, codex, archived, kimi]) assert.equal(isSessionFile(file, dir), true, file);

  const outside = write("secrets/notes.jsonl");
  const elsewhere = write(".claude/settings.json");
  assert.equal(isSessionFile(outside, dir), false);
  assert.equal(isSessionFile(elsewhere, dir), false);
  // Stepping out with "..": resolved first, so refused.
  assert.equal(isSessionFile(path.join(dir, ".claude/projects/../../secrets/notes.jsonl"), dir), false);
  // A link inside the folder to a file outside it: refused.
  const link = path.join(dir, ".claude/projects/-Users-me-repo/link.jsonl");
  fs.symlinkSync(outside, link);
  assert.equal(isSessionFile(link, dir), false);
  // A folder, a missing file, not a string: refused.
  fs.mkdirSync(path.join(dir, ".codex/sessions/dir.jsonl"));
  assert.equal(isSessionFile(path.join(dir, ".codex/sessions/dir.jsonl"), dir), false);
  assert.equal(isSessionFile(path.join(dir, ".claude/projects/missing.jsonl"), dir), false);
  assert.equal(isSessionFile(42, dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
