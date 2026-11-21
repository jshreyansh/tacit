import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBrief,
  claudeProjectDirName,
  parseNote,
  planWrite,
  searchNotes,
  serializeNote,
  slugify,
  type BriefInput,
  type MemoryDraft,
  type MemoryNote,
  type MemoryScope,
} from "../shared/memory.ts";

const T0 = "2026-11-20T10:00:00.000Z";
const T1 = "2026-11-20T11:00:00.000Z";

function note(partial: Partial<MemoryNote> & { name: string; scope?: MemoryScope }): MemoryNote {
  return {
    scope: "folder",
    kind: "fact",
    description: partial.name,
    body: `body of ${partial.name}`,
    author: "terminal:t1",
    harness: "claude",
    created: T0,
    updated: T0,
    status: "active",
    pendingReason: null,
    tainted: false,
    supersedes: null,
    replacedBy: null,
    sources: [],
    native: null,
    ...partial,
  };
}

const draft = (partial: Partial<MemoryDraft> & { name: string }): MemoryDraft => ({
  kind: "fact",
  description: partial.name,
  body: `body of ${partial.name}`,
  author: "terminal:t1",
  ...partial,
});

test("Claude's project folder names turn every non-alphanumeric character into a dash", () => {
  assert.equal(claudeProjectDirName("/Users/me/tacit"), "-Users-me-tacit");
  // The old naming left "." alone, so worktree memory never matched Claude's.
  assert.equal(claudeProjectDirName("/Users/me/tacit/.worktrees/wb-1"), "-Users-me-tacit--worktrees-wb-1");
  assert.equal(claudeProjectDirName("C:\\Users\\me\\proj"), "C--Users-me-proj");
});

test("slugs are filesystem-safe, so an agent-given name can't escape its folder", () => {
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("Release Steps!"), "release-steps");
  assert.equal(slugify("***"), "note");
});

test("a note round-trips through its file format", () => {
  const original = note({
    name: "release-steps",
    kind: "howto",
    description: 'Run "pnpm release:mac --local"',
    body: "1. bump\n2. build",
    sources: ["session:abc"],
    supersedes: "old-release",
  });
  const parsed = parseNote(serializeNote(original), { scope: "folder", fileName: "release-steps.md" });
  assert.ok(parsed);
  assert.deepEqual(parsed, original);
});

test("Claude Code's own memory files are read, including the metadata-block format", () => {
  const text = "---\nname: workdesk-naming\ndescription: Say workdesk\nmetadata:\n  type: feedback\n---\n\nAlways say workdesk.";
  const parsed = parseNote(text, { scope: "folder", fileName: "workdesk-naming.md", mtime: T1, native: "claude-memory" });
  assert.equal(parsed?.kind, "preference");
  assert.equal(parsed?.description, "Say workdesk");
  assert.equal(parsed?.native, "claude-memory");
  assert.equal(parsed?.status, "active");
});

test("writing the same name updates the note in place and keeps when it was created", () => {
  const existing = [note({ name: "release-steps", created: T0 })];
  const plan = planWrite(existing, "folder", draft({ name: "Release steps", body: "new steps" }), T1);
  assert.equal(plan.action, "update");
  if (plan.action === "skip") return;
  assert.equal(plan.note.created, T0);
  assert.equal(plan.note.updated, T1);
});

test("an unchanged rewrite and a repeat under another name are skipped, not appended", () => {
  const existing = [note({ name: "a", body: "Tests run with pnpm test" })];
  assert.deepEqual(
    (({ action, reason }: any) => ({ action, reason }))(planWrite(existing, "folder", draft({ name: "a", description: "a", body: "Tests run with pnpm test" }), T1)),
    { action: "skip", reason: "unchanged" },
  );
  const repeat = planWrite(existing, "folder", draft({ name: "b", body: "tests   run with PNPM test" }), T1);
  assert.equal(repeat.action, "skip");
  assert.equal(repeat.action === "skip" && repeat.reason, "duplicate");
});

test("replaces marks the old note outdated, pointing at the new one", () => {
  const existing = [note({ name: "deploy-target" })];
  const plan = planWrite(existing, "folder", draft({ name: "deploy-target-v2", replaces: "deploy-target" }), T1);
  assert.equal(plan.action, "add");
  if (plan.action === "skip") return;
  assert.equal(plan.note.supersedes, "deploy-target");
  assert.equal(plan.outdated?.status, "outdated");
  assert.equal(plan.outdated?.replacedBy, "deploy-target-v2");
});

test("a note shaped by web content, or an agent's note about the person, waits for approval", () => {
  const web = planWrite([], "folder", draft({ name: "x", tainted: true }), T1);
  assert.equal(web.action !== "skip" && web.note.status, "pending");
  assert.equal(web.action !== "skip" && web.note.pendingReason, "web");

  const aboutYou = planWrite([], "you", draft({ name: "likes-short-replies" }), T1);
  assert.equal(aboutYou.action !== "skip" && aboutYou.note.pendingReason, "you-scope");

  const fromYou = planWrite([], "you", draft({ name: "likes-short-replies", author: "you" }), T1);
  assert.equal(fromYou.action !== "skip" && fromYou.note.status, "active");
});

function briefInput(partial: Partial<BriefInput> = {}): BriefInput {
  return {
    harness: "claude",
    role: "worker",
    you: [note({ name: "say-workdesk", scope: "you", kind: "preference", description: "Say workdesk, not workspace" })],
    workdesk: [
      note({ name: "handover", scope: "workdesk", kind: "handover", description: "Workdesk handover", body: "Goal: ship memory v2." }),
      note({ name: "use-local-release", scope: "workdesk", kind: "decision", description: "Release locally only" }),
      note({ name: "activity-1", scope: "workdesk", kind: "event", description: "spawned a worker" }),
    ],
    folder: [note({ name: "run-tests", kind: "howto", description: "Run tests with pnpm test" })],
    worktree: [],
    native: {
      "claude-memory": [note({ name: "platform-boundary", native: "claude-memory", author: "claude-memory", description: "Capabilities go through window.tacit" })],
    },
    folderLabel: "tacit",
    worktreeLabel: null,
    ...partial,
  };
}

test("the brief gives every scope, handover and preferences first", () => {
  const brief = buildBrief(briefInput());
  const order = ["About you", "handover", "goals and decisions", "This folder"].map((h) => brief.text.indexOf(h));
  assert.ok(order.every((i) => i >= 0), brief.text);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(brief.text, /Goal: ship memory v2\./);
});

test("a CLI's own memory is left out of its brief and given to every other CLI", () => {
  const forClaude = buildBrief(briefInput({ harness: "claude" }));
  assert.doesNotMatch(forClaude.text, /window\.tacit/);
  const forCodex = buildBrief(briefInput({ harness: "codex" }));
  assert.match(forCodex.text, /Capabilities go through window\.tacit/);
  assert.match(forCodex.text, /from Claude's own memory/);
});

test("swapping the agent loses nothing: another CLI's brief holds the first one's and its own memory", () => {
  const input = briefInput({ role: "manager", digest: "What the user has been asking for:\n  - ship memory" });
  const claude = buildBrief({ ...input, harness: "claude" });
  const codex = buildBrief({ ...input, harness: "codex" });
  for (const included of claude.included) assert.ok(codex.included.includes(included), included);
  assert.ok(codex.included.includes("folder/platform-boundary"));
});

test("pending and outdated notes never reach a brief", () => {
  const brief = buildBrief(
    briefInput({
      you: [note({ name: "unapproved", scope: "you", status: "pending", pendingReason: "you-scope", description: "UNAPPROVED" })],
      folder: [note({ name: "old", status: "outdated", description: "OUTDATED" })],
    }),
  );
  assert.doesNotMatch(brief.text, /UNAPPROVED|OUTDATED/);
});

test("workers don't get the running log; managers get it and the record's digest", () => {
  assert.doesNotMatch(buildBrief(briefInput()).text, /spawned a worker/);
  const manager = buildBrief(briefInput({ role: "manager", digest: "What the user has been asking for:\n  - ship memory" }));
  assert.match(manager.text, /spawned a worker/);
  assert.match(manager.text, /ship memory/);
});

test("the brief stays within its budget, listing what didn't fit by title", () => {
  const many = Array.from({ length: 60 }, (_, i) => note({ name: `fact-${i}`, description: `Fact number ${i}`, body: "x".repeat(400) }));
  const brief = buildBrief(briefInput({ folder: many, budget: 4000 }));
  assert.ok(brief.text.length <= 4000 + 600 + 50, `brief was ${brief.text.length}`);
  assert.ok(brief.listed.length > 0 || brief.omitted > 0);
  assert.match(brief.text, /More, by title/);
});

test("a newer note from a CLI's memory wins over an older Tacit note of the same name", () => {
  const brief = buildBrief(
    briefInput({
      harness: "codex",
      folder: [note({ name: "deploy", description: "Deploy with script A", updated: T0 })],
      native: { "claude-memory": [note({ name: "deploy", native: "claude-memory", description: "Deploy with script B", updated: T1 })] },
    }),
  );
  assert.match(brief.text, /script B/);
  assert.doesNotMatch(brief.text, /script A/);
});

test("search matches every word, titles first, and skips pending notes", () => {
  const notes = [
    note({ name: "release-steps", description: "How to release", body: "pnpm release" }),
    note({ name: "misc", description: "Misc", body: "release notes are in CHANGELOG" }),
    note({ name: "secret", description: "release", status: "pending" }),
  ];
  const hits = searchNotes(notes, "release");
  assert.deepEqual(hits.map((h) => h.note.name), ["release-steps", "misc"]);
});
