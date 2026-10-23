import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkInstructions,
  claudeImportsAgentsFile,
  writeInstructions,
  type InstructionSection,
} from "../shared/agent-instructions.ts";

// Tacit's instructions live once, in AGENTS.md, which Codex, OpenCode and
// Antigravity read. Claude Code ignores AGENTS.md when any CLAUDE.md is in
// the folder or above it, so CLAUDE.md imports it with one line instead of
// holding a second copy.

const TASKS: InstructionSection = {
  heading: "Tacit Pin System",
  text: "## Tacit Pin System\n\nUse `tacit task`.\n",
};
const WORKFLOWS: InstructionSection = {
  heading: "Hydra Orchestration Toolkit",
  formerHeadings: ["Hydra Sub-Agent Tool"],
  text: "## Hydra Orchestration Toolkit\n\nUse `hydra dispatch`.\n",
};

function folder(t: test.TestContext, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-instructions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf-8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("a new folder gets the text in AGENTS.md and only an import in CLAUDE.md", (t) => {
  const dir = folder(t);
  assert.equal(checkInstructions(dir, [WORKFLOWS, TASKS]).status, "missing");

  const results = writeInstructions(dir, [WORKFLOWS, TASKS]);
  assert.deepEqual(results.map((r) => [r.fileName, r.status]), [["AGENTS.md", "created"], ["CLAUDE.md", "created"]]);

  const agents = read(dir, "AGENTS.md");
  assert.match(agents, /## Hydra Orchestration Toolkit/);
  assert.match(agents, /## Tacit Pin System/);
  const claude = read(dir, "CLAUDE.md");
  assert.ok(claudeImportsAgentsFile(claude));
  assert.doesNotMatch(claude, /hydra dispatch|tacit task/, "CLAUDE.md holds a second copy of the text");
  assert.equal(checkInstructions(dir, [WORKFLOWS, TASKS]).status, "current");
});

test("people's own content in both files is kept, and Tacit's text is added once", (t) => {
  const dir = folder(t, {
    "AGENTS.md": "# Project\n\nRun `make test` before committing.\n",
    "CLAUDE.md": "# Claude notes\n\nPrefer small diffs.\n",
  });
  const results = writeInstructions(dir, [TASKS]);
  assert.deepEqual(results.map((r) => r.status), ["appended", "appended"]);
  assert.match(read(dir, "AGENTS.md"), /^# Project\n\nRun `make test` before committing\.\n\n## Tacit Pin System/);
  assert.match(read(dir, "CLAUDE.md"), /^# Claude notes\n\nPrefer small diffs\.\n\n## Shared Agent Instructions/);

  // Writing again changes nothing.
  assert.deepEqual(writeInstructions(dir, [TASKS]).map((r) => r.status), ["unchanged", "unchanged"]);
});

test("a CLAUDE.md that already imports AGENTS.md is left alone", (t) => {
  const mine = "# Mine\n\n@./AGENTS.md\n";
  const dir = folder(t, { "CLAUDE.md": mine });
  writeInstructions(dir, [TASKS]);
  assert.equal(read(dir, "CLAUDE.md"), mine);
});

test("an import written as an example in a code block doesn't count", () => {
  assert.equal(claudeImportsAgentsFile("```\n@AGENTS.md\n```\n"), false);
  assert.equal(claudeImportsAgentsFile("See @AGENTS.md for more.\n"), false);
  assert.equal(claudeImportsAgentsFile("@AGENTS.md\n"), true);
});

test("a project set up the old way moves to one copy, keeping everything else", (t) => {
  const oldSection = (s: InstructionSection) => s.text.replace("Use", "Old: use");
  const dir = folder(t, {
    "CLAUDE.md": `# Rules\n\nBe careful.\n\n${oldSection(WORKFLOWS)}\n${oldSection(TASKS)}\n## Team\n\nAsk first.\n`,
    "AGENTS.md": `${oldSection(WORKFLOWS)}\n${oldSection(TASKS)}`,
  });
  assert.equal(checkInstructions(dir, [WORKFLOWS, TASKS]).status, "outdated");

  const results = writeInstructions(dir, [WORKFLOWS, TASKS]);
  assert.deepEqual(results.map((r) => r.status), ["updated", "updated"]);

  const claude = read(dir, "CLAUDE.md");
  assert.doesNotMatch(claude, /Hydra Orchestration Toolkit|Tacit Pin System/);
  assert.match(claude, /^# Rules\n\nBe careful\.\n\n## Team\n\nAsk first\.\n\n## Shared Agent Instructions/);
  assert.ok(claudeImportsAgentsFile(claude));
  const agents = read(dir, "AGENTS.md");
  assert.equal(count(agents, "## Hydra Orchestration Toolkit"), 1);
  assert.doesNotMatch(agents, /Old: use/);
  assert.equal(checkInstructions(dir, [WORKFLOWS, TASKS]).status, "current");
});

test("text in AGENTS.md but CLAUDE.md missing the import is out of date", (t) => {
  const dir = folder(t, { "AGENTS.md": WORKFLOWS.text, "CLAUDE.md": "# Mine\n" });
  assert.equal(checkInstructions(dir, [WORKFLOWS]).status, "outdated");
});

test("a section under its former heading is replaced, and duplicates are removed", (t) => {
  const dir = folder(t, {
    "AGENTS.md": "## Hydra Sub-Agent Tool\n\nOld.\n\n## Notes\n\nKeep me.\n\n## Hydra Orchestration Toolkit\n\nAlso old.\n",
  });
  writeInstructions(dir, [WORKFLOWS]);
  const agents = read(dir, "AGENTS.md");
  assert.equal(count(agents, "## Hydra"), 1);
  assert.match(agents, /## Hydra Orchestration Toolkit\n\nUse `hydra dispatch`\.\n\n## Notes\n\nKeep me\.\n$/);
});

test("withdrawn sections are taken out of both files, and their presence is out of date", (t) => {
  const dir = folder(t, {
    "AGENTS.md": `# Project\n\n${WORKFLOWS.text}\n${TASKS.text}`,
    "CLAUDE.md": `${WORKFLOWS.text}\n## Mine\n\nKeep me.\n\n@AGENTS.md\n`,
  });
  assert.equal(checkInstructions(dir, [TASKS], [WORKFLOWS]).status, "outdated");
  // Without the withdrawal the same files would read as current for TASKS in AGENTS.md,
  // so it's the withdrawn section that makes them out of date.
  writeInstructions(dir, [TASKS], [WORKFLOWS]);
  assert.equal(read(dir, "AGENTS.md"), `# Project\n\n${TASKS.text}`);
  assert.equal(read(dir, "CLAUDE.md"), "## Mine\n\nKeep me.\n\n@AGENTS.md\n");
  assert.equal(checkInstructions(dir, [TASKS], [WORKFLOWS]).status, "current");
});

test("checking never writes, even when the instructions are out of date", (t) => {
  const dir = folder(t, { "AGENTS.md": "## Tacit Pin System\n\nOld.\n", "CLAUDE.md": "## Tacit Pin System\n\nOld.\n" });
  const before = [read(dir, "AGENTS.md"), read(dir, "CLAUDE.md")];
  assert.equal(checkInstructions(dir, [TASKS]).status, "outdated");
  assert.deepEqual([read(dir, "AGENTS.md"), read(dir, "CLAUDE.md")], before);
});
