import { RESULT_SCHEMA_VERSION, validateRunResult, type RunResult } from "../hydra/src/protocol";

/**
 * A hand-off along a wire, tracked by Hydra's result contract.
 *
 * The receiver gets a task sheet in its own worktree, under `.hydra/` like a
 * Hydra workbench, and is asked to finish by writing `report.md` and then a
 * `result.json` in Hydra's schema (hydra/src/protocol.ts): outcome completed,
 * stuck with a reason, or error. Tacit checks for the result, validates it
 * with Hydra's own validator, and sends the outcome and the start of the
 * report back to whoever handed the work off. A stuck result is also put in
 * front of the user. Free text is never parsed for the outcome.
 *
 * What this doesn't do, and Hydra's own dispatch does: give the work a fresh
 * worktree and hold its merge for approval. The receiver here is an agent
 * the user wired up, already working in its own folder.
 */

/** The workbench id tracked hand-offs use in their result.json. */
export const HANDOFF_WORKBENCH_ID = "handoff";

/** A tracked hand-off that has had no result for this long is given up on. */
export const TRACKED_TIMEOUT_MS = 6 * 60 * 60_000;

/** How much of the report goes back with the outcome. */
const REPORT_EXCERPT = 1_500;

export interface TrackedHandoff {
  id: string;
  senderId: string;
  senderTitle: string;
  targetId: string;
  targetTitle: string;
  /** Absolute folder holding task.md, report.md and result.json. */
  dir: string;
  startedAt: number;
  /** Set once an invalid result.json has been reported, so it is said once. */
  invalidSeenAt?: number;
}

export interface TrackedDeps {
  writeFile: (file: string, content: string) => void;
  /** null when the file doesn't exist. */
  readFile: (file: string) => string | null;
  modifiedAt: (file: string) => number | null;
  /** To the agent that handed the work off. */
  tellSender: (handoff: TrackedHandoff, text: string) => Promise<void>;
  /** To the agent doing the work, about its result file. */
  tellTarget: (handoff: TrackedHandoff, text: string) => Promise<void>;
  /** A stuck or failed hand-off, put in front of the user. */
  flag: (handoff: TrackedHandoff, outcome: RunResult["outcome"], reason: string | undefined) => void;
  record: (handoff: TrackedHandoff, outcome: RunResult["outcome"] | "timed_out", reason?: string) => void;
  now: () => number;
  join: (...parts: string[]) => string;
}

export function taskSheet(input: {
  handoff: TrackedHandoff;
  work: string;
  why: string;
  role?: { name: string; description: string; body: string } | null;
}): string {
  const { handoff, work, why, role } = input;
  return [
    `# Hand-off from ${handoff.senderTitle}`,
    "",
    `Handed off over a wire on the Tacit canvas, by ${handoff.senderTitle} (terminal ${handoff.senderId}) to ${handoff.targetTitle} (terminal ${handoff.targetId}). It is tracked because ${why}.`,
    "",
    "## The work",
    "",
    work,
    ...(role ? ["", `## Your role: ${role.name}`, "", role.description, "", role.body.trim()] : []),
    "",
    "## When you finish, or if you get stuck",
    "",
    resultInstructions(handoff),
    "",
  ].join("\n");
}

export function resultInstructions(handoff: TrackedHandoff): string {
  const example = {
    schema_version: RESULT_SCHEMA_VERSION,
    workbench_id: HANDOFF_WORKBENCH_ID,
    assignment_id: handoff.id,
    run_id: handoff.id,
    outcome: "completed",
    report_file: "report.md",
  };
  return [
    `1. Write ${handoff.dir}/report.md: what you did, what's left, and anything ${handoff.senderTitle} needs to know.`,
    `2. Then write ${handoff.dir}/result.json, exactly this shape, last:`,
    "",
    JSON.stringify(example, null, 2),
    "",
    `outcome is "completed", "stuck" or "error". When it is "stuck", add "stuck_reason": one of "needs_clarification", "needs_credentials", "needs_context", "blocked_technical". No other fields.`,
  ].join("\n");
}

/** What the receiving agent is told, after the hand-off text itself. */
export function trackedNotice(handoff: TrackedHandoff, why: string): string {
  return `This hand-off is tracked (${why}). Your task sheet is ${handoff.dir}/task.md. When you finish, or if you get stuck, write ${handoff.dir}/report.md and then ${handoff.dir}/result.json as the sheet says; ${handoff.senderTitle} gets the outcome.`;
}

export function outcomeText(handoff: TrackedHandoff, result: RunResult, report: string | null): string {
  const what =
    result.outcome === "completed" ? "finished it"
    : result.outcome === "stuck" ? `is stuck (${result.stuck_reason})`
    : "hit an error";
  const excerpt = report
    ? report.length > REPORT_EXCERPT
      ? `${report.slice(0, REPORT_EXCERPT)}…`
      : report
    : "(no report)";
  return `[Tracked hand-off: ${handoff.targetTitle} (terminal ${handoff.targetId}) ${what}. Full report: ${handoff.dir}/report.md]\n\n${excerpt}`;
}

export class TrackedHandoffs {
  private readonly pending = new Map<string, TrackedHandoff>();

  constructor(private readonly deps: TrackedDeps) {}

  start(input: {
    handoff: TrackedHandoff;
    work: string;
    why: string;
    role?: { name: string; description: string; body: string } | null;
  }): void {
    this.deps.writeFile(this.deps.join(input.handoff.dir, "task.md"), taskSheet(input));
    this.pending.set(input.handoff.id, input.handoff);
  }

  pendingFor(targetId: string): TrackedHandoff[] {
    return [...this.pending.values()].filter((h) => h.targetId === targetId);
  }

  async sweep(): Promise<void> {
    for (const handoff of [...this.pending.values()]) {
      const resultFile = this.deps.join(handoff.dir, "result.json");
      const raw = this.deps.readFile(resultFile);
      if (raw === null) {
        if (this.deps.now() - handoff.startedAt > TRACKED_TIMEOUT_MS) {
          this.pending.delete(handoff.id);
          this.deps.record(handoff, "timed_out");
          await this.deps.tellSender(handoff, `[Tracked hand-off: no result from ${handoff.targetTitle} (terminal ${handoff.targetId}) after 6 hours; it is no longer tracked. Its task sheet: ${handoff.dir}/task.md]`);
        }
        continue;
      }
      let result: RunResult;
      try {
        result = validateRunResult(JSON.parse(raw), {
          workbench_id: HANDOFF_WORKBENCH_ID,
          assignment_id: handoff.id,
          run_id: handoff.id,
        });
      } catch (err) {
        // Said once per version of the file, so a fix gets checked again.
        const modified = this.deps.modifiedAt(resultFile) ?? 0;
        if (handoff.invalidSeenAt !== modified) {
          handoff.invalidSeenAt = modified;
          await this.deps.tellTarget(
            handoff,
            `[Your result.json for the tracked hand-off isn't valid: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. Fix ${resultFile}.]\n\n${resultInstructions(handoff)}`,
          );
        }
        continue;
      }
      this.pending.delete(handoff.id);
      const reportFile = result.report_file.startsWith("/")
        ? result.report_file
        : this.deps.join(handoff.dir, result.report_file.replace(/^\.\//, ""));
      const report = this.deps.readFile(reportFile);
      this.deps.record(handoff, result.outcome, result.stuck_reason);
      if (result.outcome !== "completed") this.deps.flag(handoff, result.outcome, result.stuck_reason);
      await this.deps.tellSender(handoff, outcomeText(handoff, result, report));
    }
  }
}
