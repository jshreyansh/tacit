/**
 * Starting agents without approvals (T15.1). Hydra workers and agents the
 * manager starts ask for it; a project allows it only once the person has
 * said so, and a tile that runs without approvals says which flags did it.
 * Pure, so the rules are tested without React.
 */

/** The person's answer for a project: let agents skip approvals, or have them ask. */
export type AgentApprovalChoice = "bypass" | "ask";

/** What a launch does: add the bypass flags, leave them out, or wait for an answer. */
export type LaunchApproval = "bypass" | "ask" | "needs-answer";

/**
 * Whether a launch that asked to skip approvals may. Only a launch that
 * asked, for an agent that has bypass flags, is ever held for an answer.
 */
export function launchApproval(
  requested: boolean,
  hasBypassArgs: boolean,
  choice: AgentApprovalChoice | undefined,
): LaunchApproval {
  if (!requested || !hasBypassArgs) return "ask";
  return choice ?? "needs-answer";
}

/** Flags that switch an agent's approvals or sandbox off. */
const BYPASS_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
]);

/**
 * The flags in a launch's arguments that run the agent without approvals,
 * whoever added them: Tacit for a worker, or the person's own command
 * override in Settings.
 */
export function bypassFlags(args: readonly string[]): string[] {
  const found: string[] = [];
  args.forEach((arg, i) => {
    if (BYPASS_FLAGS.has(arg)) found.push(arg);
    else if (arg === "--permission-mode" && args[i + 1] === "bypassPermissions") found.push(`${arg} ${args[i + 1]}`);
    else if (arg === "--permission-mode=bypassPermissions") found.push(arg);
  });
  return [...new Set(found)];
}
