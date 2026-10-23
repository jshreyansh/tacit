import {
  checkInstructions,
  writeInstructions,
  type InstructionFileResult,
  type InstructionSection,
  type SectionStatus,
} from "../../shared/agent-instructions.ts";

const HYDRA_SECTION = `
## Hydra Orchestration Toolkit

Hydra is a Lead-driven orchestration toolkit. You (the Lead) make strategic
decisions at decision points; Hydra handles operational management.
\`result.json\` is the only completion evidence.

Why this design (vs. other coding-agent products):
- **SWF decider pattern, specialized for LLM deciders.** Hydra is the AWS SWF / Cadence / Temporal decider pattern. \`hydra watch\` is \`PollForDecisionTask\`; the Lead is the decider; \`lead_terminal_id\` enforces single-decider semantics.
- **Parallel-first, not bolted on.** \`dispatch\` + worktree + \`merge\` are first-class. Lead sequences nodes manually and passes context explicitly via \`--context-ref\`. Other products treat parallelism as open research; Hydra makes it the default.
- **Typed result contract.** Workers publish a schema-validated \`result.json\` (\`outcome: completed | stuck | error\`, optional \`stuck_reason: needs_clarification | needs_credentials | needs_context | blocked_technical\`). Other products return free-text final messages and require downstream parsing.
- **Lead intervention points.** \`hydra reset --feedback\` lets the Lead actually intervene at decision points instead of being block-and-join. A stale or wrong run is one \`reset\` away.

Core rules:
- Root cause first. Fix the implementation problem before changing tests.
- Do not hack tests, fixtures, or mocks to force a green result.
- Do not add silent fallbacks or swallowed errors.
- An assignment run is only complete when \`result.json\` exists and passes schema validation.

Workflow patterns:
1. Do the task directly when it is simple, local, or clearly faster without workflow overhead.
2. Use Hydra for ambiguous, risky, parallel, or multi-step work:
   \`\`\`
   hydra init --intent "<task>" --repo .
   hydra dispatch --workbench W --dispatch <id> --role <role> --intent "<desc>" --repo .
   hydra watch --workbench W --repo .
   # → DecisionPoint returned, decide next step
   hydra complete --workbench W --repo .
   \`\`\`
3. Use a direct isolated worker when only a separate worker is needed:
   \`hydra spawn --task "<specific task>" --repo . [--worktree .]\`

Agent launch rule:
- When dispatching Claude/Codex through Tacit CLI, start a fresh agent terminal with \`tacit terminal create --prompt "..."\`
- Do not use \`tacit terminal input\` for task dispatch; it is not a supported automation path

Workflow control:
- After dispatching, always call \`hydra watch\`. It returns at decision points.
1. Watch until decision point: \`hydra watch --workbench <workbenchId> --repo .\`
2. Inspect structured state: \`hydra status --workbench <workbenchId> --repo .\`
3. Reset a dispatch for rework: \`hydra reset --workbench W --dispatch N --feedback "..." --repo .\`
4. Approve a dispatch's output: \`hydra approve --workbench W --dispatch N --repo .\`
5. Merge parallel branches: \`hydra merge --workbench W --dispatches A,B --repo .\`
6. View event log: \`hydra ledger --workbench <workbenchId> --repo .\`
7. Clean up: \`hydra cleanup --workbench <workbenchId> --repo .\`

Telemetry polling:
1. Treat \`hydra watch\` as the main polling loop; do not infer progress from terminal prose alone.
2. Before deciding wait / retry / takeover, query:
   - \`tacit telemetry get --workbench <workbenchId> --repo .\`
   - \`tacit telemetry get --terminal <terminalId>\`
   - \`tacit telemetry events --terminal <terminalId> --limit 20\`
3. Trust \`derived_status\` and \`task_status\` as the primary decision signals.

\`result.json\` must contain (slim, schema_version \`hydra/result/v0.1\`):
- \`schema_version\`, \`workbench_id\`, \`assignment_id\`, \`run_id\` (passthrough IDs)
- \`outcome\` (completed/stuck/error — Hydra routes on this)
- \`report_file\` (path to a \`report.md\` written alongside \`result.json\`)

All human-readable content (summary, outputs, evidence, reflection) lives in
\`report.md\`. Hydra rejects any extra fields in \`result.json\`. Write \`report.md\`
first, then publish \`result.json\` atomically as the final artifact of the run.

When NOT to use: simple fixes, high-certainty tasks, or work that is faster to do directly in the current agent.
`;

/** Hydra's section of a project's AGENTS.md (see shared/agent-instructions.ts). */
export const HYDRA_INSTRUCTIONS: InstructionSection = {
  heading: "Hydra Orchestration Toolkit",
  formerHeadings: ["Hydra Sub-Agent Tool"],
  text: HYDRA_SECTION,
};

export type InitInstructionResult = InstructionFileResult;
export type HydraInjectStatus = SectionStatus;

/** Read-only check: are Hydra instructions present, current and in the shared layout? */
export function checkHydraInstructionsStatus(targetDir: string): HydraInjectStatus {
  return checkInstructions(targetDir, [HYDRA_INSTRUCTIONS]).status;
}

export function syncHydraInstructions(targetDir: string): InitInstructionResult[] {
  return writeInstructions(targetDir, [HYDRA_INSTRUCTIONS]);
}

export async function init(targetDir = process.cwd()): Promise<InitInstructionResult[]> {
  const results = syncHydraInstructions(targetDir);
  for (const result of results) {
    console.log(formatInitLog(result));
  }
  return results;
}

function formatInitLog(result: InitInstructionResult): string {
  if (result.fileName === "AGENTS.md") {
    switch (result.status) {
      case "created":
        return "Created AGENTS.md with hydra instructions";
      case "appended":
        return "Appended hydra instructions to AGENTS.md";
      case "updated":
        return "Updated hydra instructions in AGENTS.md";
      case "unchanged":
        return "AGENTS.md already contains current hydra instructions";
    }
  }
  switch (result.status) {
    case "created":
      return "Created CLAUDE.md, importing AGENTS.md";
    case "appended":
      return "Added an AGENTS.md import to CLAUDE.md";
    case "updated":
      return "Moved hydra instructions out of CLAUDE.md, which now imports AGENTS.md";
    case "unchanged":
      return "CLAUDE.md already imports AGENTS.md";
  }
}
