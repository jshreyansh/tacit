import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWebTool, WebReadTracker } from "../electron/web-read-tracker.ts";
import { journalWriteEvent, writeJournalEntry, writeProjectNote, type JournalProvenance } from "../electron/memory-notes.ts";
import { parseMemoryFile } from "../electron/memory-service.ts";
import { TelemetryService } from "../electron/telemetry-service.ts";

const T0 = "2026-10-15T10:00:00.000Z";
const T1 = "2026-10-15T10:00:05.000Z";
const T2 = "2026-10-15T10:00:10.000Z";
const T3 = "2026-10-15T10:00:15.000Z";

test("a browser read in the current turn taints it; a new prompt starts clean", () => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  assert.deepEqual(reads.provenance("t1"), { tainted: false, taint_sources: [], last_web_read_at: null });

  reads.noteBrowserAction("t1", { browser: "browser:b1", action: "read", url: "https://example.com/a", at: T1 });
  assert.deepEqual(reads.provenance("t1"), {
    tainted: true,
    taint_sources: [{ kind: "browser", source: "browser:b1", action: "read", url: "https://example.com/a", at: T1 }],
    last_web_read_at: T1,
  });

  reads.noteTurnStart("t1", T2);
  assert.deepEqual(
    reads.provenance("t1"),
    { tainted: false, taint_sources: [], last_web_read_at: T1 },
    "the read was last turn: not tainted, but still the latest read",
  );
});

test("only browser actions that hand page text back count", () => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  reads.noteBrowserAction("t1", { browser: "browser:b1", action: "click", at: T1 });
  reads.noteBrowserAction("t1", { browser: "browser:b1", action: "reload", at: T1 });
  assert.equal(reads.provenance("t1").tainted, false);
  for (const action of ["navigate", "eval"]) {
    const fresh = new WebReadTracker();
    fresh.noteBrowserAction("t1", { browser: "browser:b1", action, at: T1 });
    assert.equal(fresh.provenance("t1").tainted, true, action);
  }
});

test("an agent's own web tools count; its other tools and Tacit's own MCP tools don't", () => {
  for (const tool of ["WebFetch", "WebSearch", "web_search", "webfetch", "websearch", "mcp__claude-in-chrome__get_page_text", "mcp__playwright__browser_navigate", "mcp__firecrawl__scrape"]) {
    assert.equal(isWebTool(tool), true, tool);
  }
  // Tacit's own browser tools are recorded as browser actions, with what they did.
  for (const tool of ["Read", "Bash", "Edit", "grep", "shell", "mcp__tacit__browser_read", "mcp__tacit__log_activity", "mcp__linear__list_issues"]) {
    assert.equal(isWebTool(tool), false, tool);
  }
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  reads.noteToolUse("t1", "Bash", T1);
  assert.equal(reads.provenance("t1").tainted, false);
  reads.noteToolUse("t1", "WebFetch", T1);
  reads.noteToolUse("t1", "WebFetch", T1); // the hook and the session file both report it
  assert.deepEqual(reads.provenance("t1").taint_sources, [{ kind: "tool", source: "WebFetch", at: T1 }]);
});

test("a read reported after a newer prompt belongs to the earlier turn", () => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T2);
  // A session file read late: the tool ran before this turn's prompt.
  reads.noteToolUse("t1", "WebFetch", T1);
  assert.deepEqual(reads.provenance("t1"), { tainted: false, taint_sources: [], last_web_read_at: T1 });
  // A prompt reported out of order doesn't move the turn back.
  reads.noteTurnStart("t1", T0);
  assert.equal(reads.provenance("t1").tainted, false);
});

test("terminals are tracked apart, and a closed one is forgotten", () => {
  const reads = new WebReadTracker();
  reads.noteToolUse("t1", "WebSearch", T1);
  assert.equal(reads.provenance("t1").tainted, true);
  assert.equal(reads.provenance("t2").tainted, false);
  reads.forget("t1");
  assert.deepEqual(reads.provenance("t1"), { tainted: false, taint_sources: [], last_web_read_at: null });
});

test("telemetry reports an agent's tools from hooks and session reading, not from replayed history", () => {
  const tools: string[] = [];
  const service = new TelemetryService({
    processPollIntervalMs: 0,
    onToolUse: (id, tool) => tools.push(`${id}:${tool}`),
  });
  try {
    service.registerTerminal({ terminalId: "t1", worktreePath: "/tmp/project", provider: "claude" });
    service.recordHookEvent("t1", { hook_event_name: "PreToolUse", tool_name: "WebFetch" });
    service.recordSessionTelemetry("t1", [
      { at: T1, event_type: "web_search_call", tool_name: "web_search", turn_state: "in_turn", meaningful_progress: true },
    ]);
    assert.deepEqual(tools, ["t1:WebFetch", "t1:web_search"]);

    // A session attached later replays its history: a WebFetch already in it
    // happened before Tacit was looking.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-tool-replay-"));
    try {
      const sessionFile = path.join(dir, "s-2.jsonl");
      fs.writeFileSync(sessionFile, `${JSON.stringify({
        type: "assistant",
        timestamp: T0,
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "WebFetch", input: { url: "https://example.com" } }] },
      })}\n`);
      service.registerTerminal({ terminalId: "t2", worktreePath: "/tmp/project", provider: "claude" });
      service.attachSessionSource({ terminalId: "t2", provider: "claude", sessionId: "s-2", confidence: "strong", sessionFile });
      assert.equal(service.getTerminalSnapshot("t2")?.last_session_event_kind, "tool_use", "the replay did read the tool");
      assert.deepEqual(tools, ["t1:WebFetch", "t1:web_search"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    service.dispose();
  }
});

function provenanceOf(reads: WebReadTracker, terminalId: string): JournalProvenance {
  return { node: `terminal:${terminalId}`, harness: "claude", session: "session-1", context: "run-test", ...reads.provenance(terminalId) };
}

function withMemoryDir(run: (memoryDir: string) => void): () => void {
  return () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-journal-"));
    try {
      run(memoryDir);
    } finally {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  };
}

test("a journal entry written after a browser read is stamped and recorded as tainted", withMemoryDir((memoryDir) => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  reads.noteBrowserAction("t1", { browser: "browser:b1", action: "read", url: "https://example.com/page", at: T1 });
  const provenance = provenanceOf(reads, "t1");

  const { filePath, fileName } = writeJournalEntry(memoryDir, { event: "Chose approach B", detail: "Because the page said so." }, provenance);

  const note = fs.readFileSync(filePath, "utf-8");
  assert.match(note, /^author: terminal:t1$/m);
  assert.match(note, /^harness: claude$/m);
  assert.match(note, /^context: run-test$/m);
  assert.match(note, /^tainted: true$/m);
  assert.match(note, /^tainted_by: browser:b1 read https:\/\/example\.com\/page$/m);
  assert.match(note, new RegExp(`^last_web_read_at: ${T1}$`, "m"));
  // The memory reader still reads it as before, and the index lists it.
  const parsed = parseMemoryFile(filePath);
  assert.equal(parsed?.description, "Chose approach B");
  assert.equal(parsed?.body.trim(), "Because the page said so.");
  assert.match(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8"), new RegExp(`\\(${fileName}\\)`));

  assert.deepEqual(journalWriteEvent(provenance, { tool: "log_activity", scope: "workspace", title: "Chose approach B", file: fileName }), {
    kind: "journal_write",
    by: "terminal:t1",
    tool: "log_activity",
    scope: "workspace",
    title: "Chose approach B",
    file: fileName,
    session: "session-1",
    tainted: true,
    taint_sources: [{ kind: "browser", source: "browser:b1", action: "read", url: "https://example.com/page", at: T1 }],
    last_web_read_at: T1,
  });
}));

test("a project memory note with no web read is stamped as not tainted", withMemoryDir((memoryDir) => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  reads.noteToolUse("t1", "Bash", T1);

  const { filePath } = writeProjectNote(
    memoryDir,
    { name: "Build command", description: "How to build", type: "reference", body: "pnpm build" },
    provenanceOf(reads, "t1"),
  );

  assert.equal(path.basename(filePath), "reference_build-command.md");
  const note = fs.readFileSync(filePath, "utf-8");
  assert.match(note, /^author: terminal:t1$/m);
  assert.match(note, /^tainted: false$/m);
  assert.doesNotMatch(note, /tainted_by|last_web_read_at/);
  assert.equal(parseMemoryFile(filePath)?.description, "How to build");
}));

test("a note written the turn after a web read isn't tainted but shows when the read was", withMemoryDir((memoryDir) => {
  const reads = new WebReadTracker();
  reads.noteTurnStart("t1", T0);
  reads.noteToolUse("t1", "WebFetch", T1);
  reads.noteTurnStart("t1", T3);

  const { filePath } = writeJournalEntry(memoryDir, { event: "Summarised the docs", detail: "" }, provenanceOf(reads, "t1"));

  const note = fs.readFileSync(filePath, "utf-8");
  assert.match(note, /^tainted: false$/m);
  assert.match(note, new RegExp(`^last_web_read_at: ${T1}$`, "m"));
}));

test("a URL's secret and a line break can't get into a note's frontmatter", withMemoryDir((memoryDir) => {
  const reads = new WebReadTracker();
  reads.noteBrowserAction("t1", {
    browser: "browser:b1",
    action: "navigate",
    url: "https://example.com/cb?key=sk-ant-abcdefghijklmnopqrstuvwxyz0123\ntype: feedback",
    at: T1,
  });
  const { filePath } = writeJournalEntry(memoryDir, { event: "x", detail: "" }, provenanceOf(reads, "t1"));
  const note = fs.readFileSync(filePath, "utf-8");
  assert.doesNotMatch(note, /sk-ant-abcdefghij/);
  assert.match(note, /\[masked:key\]/);
  assert.equal(parseMemoryFile(filePath)?.type, "project", "a URL can't add its own frontmatter line");
}));
