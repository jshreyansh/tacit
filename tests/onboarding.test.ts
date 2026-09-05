import test from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARDING_STEP_COUNT,
  isAgentTerminalType,
  onboardingStepIndex,
  resolveOnboardingStep,
} from "../shared/onboarding";

const facts = (projects: number, agentTerminals: number, importedProfiles: number) =>
  ({ projects, agentTerminals, importedProfiles });

test("the sequence follows the order the app becomes useful in", () => {
  assert.equal(resolveOnboardingStep(facts(0, 0, 0)), "space");
  assert.equal(resolveOnboardingStep(facts(1, 0, 0)), "agent");
  assert.equal(resolveOnboardingStep(facts(1, 1, 0)), "browser");
  assert.equal(resolveOnboardingStep(facts(1, 1, 1)), "done");
});

test("a step already satisfied out of order is not shown again", () => {
  // Importing a browser profile before opening a folder is allowed, and the
  // guide must still ask for the folder rather than skipping to the end.
  assert.equal(resolveOnboardingStep(facts(0, 0, 3)), "space");
  // Deriving from state rather than a counter is what makes this hold.
  assert.equal(resolveOnboardingStep(facts(2, 0, 3)), "agent");
});

test("a shell is not an agent", () => {
  // Opening a terminal is not the same as trying the thing the app is for.
  for (const type of ["claude", "codex", "kimi", "gemini", "opencode"]) {
    assert.equal(isAgentTerminalType(type), true, type);
  }
  for (const type of ["shell", "lazygit", "tmux", "wuu", "", null, undefined]) {
    assert.equal(isAgentTerminalType(type), false, String(type));
  }
});

test("a workspace that already has everything shows nothing", () => {
  assert.equal(resolveOnboardingStep(facts(4, 9, 2)), "done");
  assert.equal(onboardingStepIndex("done"), null);
});

test("progress dots know where they are", () => {
  assert.equal(onboardingStepIndex("space"), 0);
  assert.equal(onboardingStepIndex("agent"), 1);
  assert.equal(onboardingStepIndex("browser"), 2);
  assert.equal(ONBOARDING_STEP_COUNT, 3);
});
