/**
 * Where a new user is in getting started.
 *
 * Derived from what the workspace actually contains rather than from a stored
 * counter. Someone who quits halfway, imports a browser profile before opening
 * a folder, or restores an old workspace should not be shown a step they have
 * already finished — and a counter would have to be kept in step with every
 * path that creates a project, a terminal or a profile.
 *
 * The order is the order the app becomes useful in: a place to work, something
 * working in it, then the sessions that make that work real. Each step is only
 * shown once the one before it is genuinely done.
 */

export type OnboardingStep = "space" | "agent" | "browser" | "done";

/** Terminal types that are an agent rather than a plain shell or a tool. */
const AGENT_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "kimi",
  "gemini",
  "opencode",
]);

export function isAgentTerminalType(type: unknown): boolean {
  return typeof type === "string" && AGENT_TERMINAL_TYPES.has(type);
}

export interface OnboardingFacts {
  /** Projects on the canvas. */
  projects: number;
  /** Terminals running an agent — a shell does not count as having tried one. */
  agentTerminals: number;
  /**
   * Browser profiles imported from a real browser. The default profile ships
   * with every workspace and is signed into nothing, so it is not evidence
   * that anyone has done this step.
   */
  importedProfiles: number;
}

export function resolveOnboardingStep(facts: OnboardingFacts): OnboardingStep {
  if (facts.projects <= 0) return "space";
  if (facts.agentTerminals <= 0) return "agent";
  if (facts.importedProfiles <= 0) return "browser";
  return "done";
}

/** Position in the sequence, for the progress dots. Null once there is nothing left. */
export function onboardingStepIndex(step: OnboardingStep): number | null {
  const order: OnboardingStep[] = ["space", "agent", "browser"];
  const at = order.indexOf(step);
  return at === -1 ? null : at;
}

export const ONBOARDING_STEP_COUNT = 3;
