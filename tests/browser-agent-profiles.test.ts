import test from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_PROFILE_ID,
  mayAgentUseProfile,
  resolveAgentProfile,
  type AgentProfileCandidate,
} from "../shared/browser-agent-profiles";

const work: AgentProfileCandidate = { id: "identity-work", name: "Work", agentAllowed: true };
const personal: AgentProfileCandidate = { id: "identity-personal", name: "Personal", agentAllowed: true };
const locked: AgentProfileCandidate = { id: "identity-bank", name: "Banking", agentAllowed: false };
const guest: AgentProfileCandidate = { id: GUEST_PROFILE_ID, name: "Guest", agentAllowed: true };

test("an explicitly named profile is honoured, or refused by name", () => {
  const candidates = [work, personal, locked];
  assert.deepEqual(resolveAgentProfile({ requested: "identity-work", candidates }), {
    outcome: "resolved",
    profileId: "identity-work",
    reason: "requested",
  });

  // A profile the user withheld is refused, never quietly swapped for another:
  // an agent must not report work done "as Work" that happened as someone else.
  assert.deepEqual(resolveAgentProfile({ requested: "identity-bank", candidates }), {
    outcome: "refused",
    reason: "not-allowed",
    profileId: "identity-bank",
  });
  assert.deepEqual(resolveAgentProfile({ requested: "identity-nope", candidates }), {
    outcome: "refused",
    reason: "unknown-profile",
    profileId: "identity-nope",
  });
});

test("a task that began in one profile stays in it", () => {
  assert.deepEqual(
    resolveAgentProfile({
      inherited: "identity-personal",
      canvasDefault: "identity-work",
      candidates: [work, personal],
    }),
    { outcome: "resolved", profileId: "identity-personal", reason: "inherited" },
  );
});

test("revoking a profile stops it being inherited, immediately", () => {
  // The same in-flight task as above, after the user turned Personal off.
  const revoked = { ...personal, agentAllowed: false };
  assert.deepEqual(
    resolveAgentProfile({
      inherited: "identity-personal",
      canvasDefault: "identity-work",
      candidates: [work, revoked],
    }),
    { outcome: "resolved", profileId: "identity-work", reason: "canvas-default" },
  );
  assert.equal(mayAgentUseProfile("identity-personal", [work, revoked]), false);
  assert.equal(mayAgentUseProfile("identity-work", [work, revoked]), true);
});

test("the canvas default is passed over only when it provably cannot do the job", () => {
  const candidates = [
    { ...work, hasSessionForSite: false },
    { ...personal, hasSessionForSite: true },
  ];
  assert.deepEqual(
    resolveAgentProfile({ canvasDefault: "identity-work", candidates }),
    {
      outcome: "resolved",
      profileId: "identity-personal",
      reason: "only-session",
      overrodeCanvasDefault: "identity-work",
    },
  );

  // Two profiles could serve the site: the default's explicit intent wins.
  assert.deepEqual(
    resolveAgentProfile({
      canvasDefault: "identity-work",
      candidates: [
        { ...work, hasSessionForSite: false },
        { ...personal, hasSessionForSite: true },
        { id: "identity-third", name: "Third", agentAllowed: true, hasSessionForSite: true },
      ],
    }),
    { outcome: "resolved", profileId: "identity-work", reason: "canvas-default" },
  );

  // Unknown session state is not evidence of failure, so the default stands.
  assert.deepEqual(
    resolveAgentProfile({ canvasDefault: "identity-work", candidates: [work, personal] }),
    { outcome: "resolved", profileId: "identity-work", reason: "canvas-default" },
  );
});

test("with no canvas default, ask only when there is a real choice", () => {
  const asked = resolveAgentProfile({ candidates: [work, personal] });
  assert.equal(asked.outcome, "ask");
  assert.deepEqual(
    asked.outcome === "ask" ? asked.choices.map((c) => c.id) : [],
    ["identity-work", "identity-personal"],
    "only allowed profiles are offered",
  );

  // One allowed profile is not a choice; staging a question the user can only
  // answer one way is friction, not consent.
  assert.deepEqual(resolveAgentProfile({ candidates: [work, locked] }), {
    outcome: "resolved",
    profileId: "identity-work",
    reason: "canvas-default",
  });

  // Nothing permitted at all is refused rather than silently downgraded to the
  // signed-out profile, which would look like success and do nothing useful.
  assert.deepEqual(
    resolveAgentProfile({ candidates: [locked, { ...work, agentAllowed: false }] }),
    { outcome: "refused", reason: "none-allowed" },
  );
});

test("a single profile holding the session wins over a coin flip", () => {
  assert.deepEqual(
    resolveAgentProfile({
      candidates: [
        { ...work, hasSessionForSite: false },
        { ...personal, hasSessionForSite: true },
      ],
    }),
    { outcome: "resolved", profileId: "identity-personal", reason: "only-session" },
  );
});

test("guest is only ever reached deliberately", () => {
  // Guest is allowed like any other profile, so it can be chosen — but it is
  // never a silent substitute for one that was refused.
  assert.deepEqual(resolveAgentProfile({ requested: GUEST_PROFILE_ID, candidates: [guest, work] }), {
    outcome: "resolved",
    profileId: GUEST_PROFILE_ID,
    reason: "requested",
  });
  const refused = resolveAgentProfile({ requested: "identity-bank", candidates: [guest, locked] });
  assert.equal(refused.outcome, "refused");
});
