import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkHydraInstructionsStatus, init } from "../src/init.ts";

async function runInit(dir: string): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  try {
    await init(dir);
  } finally {
    console.log = originalLog;
  }

  return logs;
}

test("init writes Hydra instructions to AGENTS.md and has CLAUDE.md import it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-init-"));
  const logs = await runInit(dir);

  const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
  const agentsMd = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");

  // One copy, in AGENTS.md; Claude Code reads it through the import.
  assert.match(agentsMd, /## Hydra Orchestration Toolkit/);
  assert.doesNotMatch(claudeMd, /## Hydra Orchestration Toolkit/);
  assert.match(claudeMd, /^@AGENTS\.md$/m);
  assert.deepEqual(logs, [
    "Created AGENTS.md with hydra instructions",
    "Created CLAUDE.md, importing AGENTS.md",
  ]);
});

test("init moves an old Hydra block out of CLAUDE.md into AGENTS.md and keeps the rest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-init-update-"));
  // The legacy heading, so the legacy → current heading migration is covered too.
  const staleSection = [
    "# Project Notes",
    "",
    "## Hydra Sub-Agent Tool",
    "",
    "Old Hydra instructions.",
    "",
    "## Team Rules",
    "",
    "- Keep the repo tidy.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), staleSection, "utf-8");

  const logs = await runInit(dir);

  const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
  const agentsMd = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");

  assert.doesNotMatch(claudeMd, /## Hydra/);
  assert.match(claudeMd, /^# Project Notes\n\n## Team Rules\n\n- Keep the repo tidy\.\n\n## Shared Agent Instructions/);
  assert.match(claudeMd, /^@AGENTS\.md$/m);
  assert.equal(agentsMd.match(/## Hydra Orchestration Toolkit/g)?.length, 1);

  // Headline phrasing + the four design-principle bullets are present.
  assert.match(agentsMd, /`result\.json` is the only completion evidence\./);
  assert.match(agentsMd, /Why this design/);
  assert.match(agentsMd, /SWF decider pattern/);
  assert.match(agentsMd, /Parallel-first/);
  assert.match(agentsMd, /Typed result contract/);
  assert.match(agentsMd, /Lead intervention points/);

  // Workflow patterns + agent launch rule + workflow control + telemetry.
  assert.match(agentsMd, /Workflow patterns:/);
  assert.match(agentsMd, /hydra spawn --task/);
  assert.match(agentsMd, /tacit terminal create --prompt/);
  assert.match(agentsMd, /Do not use `tacit terminal input`/);
  assert.match(agentsMd, /Workflow control:/);
  assert.match(agentsMd, /Telemetry polling:/);
  assert.match(agentsMd, /tacit telemetry get --workbench <workbenchId> --repo \./);
  assert.match(agentsMd, /tacit telemetry events --terminal <terminalId> --limit 20/);

  // Slim result contract is reflected in the rendered section.
  assert.match(agentsMd, /schema_version `hydra\/result\/v0\.1`/);
  assert.match(agentsMd, /completed\/stuck\/error/);
  assert.match(agentsMd, /report_file/);

  assert.deepEqual(logs, [
    "Created AGENTS.md with hydra instructions",
    "Moved hydra instructions out of CLAUDE.md, which now imports AGENTS.md",
  ]);
});

test("init is idempotent when the current Hydra block is already present", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-init-idempotent-"));

  await runInit(dir);
  const logs = await runInit(dir);

  assert.deepEqual(logs, [
    "AGENTS.md already contains current hydra instructions",
    "CLAUDE.md already imports AGENTS.md",
  ]);
});

test("init treats duplicate legacy blocks as outdated and removes them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-init-duplicate-"));

  await runInit(dir);

  const agentsPath = path.join(dir, "AGENTS.md");
  fs.appendFileSync(
    agentsPath,
    [
      "",
      "",
      "## Hydra Sub-Agent Tool",
      "",
      "Old Hydra instructions.",
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.equal(checkHydraInstructionsStatus(dir), "outdated");

  const logs = await runInit(dir);
  const agentsMd = fs.readFileSync(agentsPath, "utf-8");

  assert.equal(checkHydraInstructionsStatus(dir), "current");
  assert.equal(agentsMd.match(/## Hydra Orchestration Toolkit/g)?.length, 1);
  assert.doesNotMatch(agentsMd, /## Hydra Sub-Agent Tool/);
  assert.deepEqual(logs, [
    "Updated hydra instructions in AGENTS.md",
    "CLAUDE.md already imports AGENTS.md",
  ]);
});
