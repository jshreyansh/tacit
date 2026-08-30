/**
 * The agent-facing half of browser profile permissions.
 *
 * Pure by construction: an agent names a profile the way a person does, and
 * "which identity did the software pick on my behalf" must be answerable
 * without an Electron window in the way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GUEST_PROFILE_ID } from "../shared/browser-agent-profiles";
import {
  checkAgentBrowserAction,
  decideAgentProfileForSpawn,
  listAgentProfiles,
  matchProfileSelector,
  type AgentProfileEntry,
} from "../shared/browser-agent-profile-access";

const guest: AgentProfileEntry = { id: GUEST_PROFILE_ID, name: "Guest", agentAllowed: true };
const work: AgentProfileEntry = {
  id: "identity-work",
  name: "Work",
  agentAllowed: true,
  fromChrome: true,
};
const personal: AgentProfileEntry = {
  id: "identity-personal",
  name: "Personal",
  agentAllowed: true,
  fromChrome: true,
};
/** Withheld: the user's mailbox stays one click away for them and out of reach here. */
const banking: AgentProfileEntry = {
  id: "identity-bank",
  name: "Banking",
  agentAllowed: false,
  fromChrome: true,
};

test("a profile is named the way a human names it, or not at all", () => {
  const candidates = [guest, work, personal];

  // The label off the node, in whatever case the agent happened to type.
  assert.deepEqual(matchProfileSelector("Work", candidates), {
    outcome: "matched",
    id: "identity-work",
  });
  assert.deepEqual(matchProfileSelector("work", candidates), {
    outcome: "matched",
    id: "identity-work",
  });
  assert.deepEqual(matchProfileSelector("  PERSONAL  ", candidates), {
    outcome: "matched",
    id: "identity-personal",
  });

  // Ids still work, for the agent that read one out of list_browser_profiles.
  assert.deepEqual(matchProfileSelector("identity-work", candidates), {
    outcome: "matched",
    id: "identity-work",
  });

  assert.deepEqual(matchProfileSelector("Nope", candidates), {
    outcome: "unknown",
    selector: "Nope",
  });
  assert.deepEqual(matchProfileSelector("   ", candidates), {
    outcome: "unknown",
    selector: "   ",
  });
});

test("two profiles answering to one name is refused, never guessed", () => {
  // Chrome imports produce this constantly: two accounts, one label.
  const dupeA: AgentProfileEntry = { id: "identity-a", name: "Work", agentAllowed: true };
  const dupeB: AgentProfileEntry = { id: "identity-b", name: "work", agentAllowed: true };
  const match = matchProfileSelector("Work", [dupeA, dupeB]);
  // Exact case still disambiguates — only one is literally "Work".
  assert.deepEqual(match, { outcome: "matched", id: "identity-a" });

  const bothLower = matchProfileSelector("WORK", [dupeA, dupeB]);
  assert.equal(bothLower.outcome, "ambiguous");
  assert.deepEqual(bothLower.outcome === "ambiguous" ? bothLower.names : [], ["Work", "work"]);

  const decision = decideAgentProfileForSpawn({
    requested: "WORK",
    candidates: [dupeA, dupeB],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, "profile_ambiguous");
  // The refusal has to name both, or the agent cannot act on it.
  assert.match(decision.ok === false ? decision.message : "", /Work.*work/);
});

test("a withheld profile is neither listable nor spawnable by name", () => {
  const candidates = [guest, work, banking];

  const listed = listAgentProfiles(candidates, "identity-work");
  assert.deepEqual(
    listed.map((p) => p.name),
    ["Guest", "Work"],
  );
  // Not listed-and-marked-forbidden: absent. A name an agent can read is a
  // name it can put in a request or a message to the user.
  assert.equal(
    listed.some((p) => p.id === "identity-bank"),
    false,
  );
  assert.deepEqual(listed[1], {
    id: "identity-work",
    name: "Work",
    isCanvasDefault: true,
    fromChrome: true,
  });
  // No account hint, no provenance internals, no source paths.
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    "fromChrome",
    "id",
    "isCanvasDefault",
    "name",
  ]);

  // Naming it outright still fails — and fails as *withheld*, not as missing,
  // so the agent stops rather than hunting for a typo that isn't there.
  const byName = decideAgentProfileForSpawn({ requested: "Banking", candidates });
  assert.equal(byName.ok, false);
  assert.equal(byName.ok === false && byName.code, "profile_not_permitted");
  assert.match(byName.ok === false ? byName.message : "", /Banking/);

  const byId = decideAgentProfileForSpawn({ requested: "identity-bank", candidates });
  assert.equal(byId.ok === false && byId.code, "profile_not_permitted");
});

test("the resolved profile and the reason for it are always reported", () => {
  const candidates = [guest, work, personal];

  const named = decideAgentProfileForSpawn({ requested: "Personal", candidates });
  assert.equal(named.ok, true);
  if (named.ok) {
    assert.equal(named.profileId, "identity-personal");
    assert.equal(named.profileName, "Personal");
    assert.equal(named.reason, "requested");
    assert.equal(named.isGuest, false);
    assert.match(named.summary, /"Personal"/);
  }

  // A task that began in one identity stays in it.
  const inherited = decideAgentProfileForSpawn({
    inherited: "identity-work",
    canvasDefault: "identity-personal",
    candidates,
  });
  assert.equal(inherited.ok && inherited.profileId, "identity-work");
  assert.equal(inherited.ok && inherited.reason, "inherited");

  const byDefault = decideAgentProfileForSpawn({
    canvasDefault: "identity-personal",
    candidates,
  });
  assert.equal(byDefault.ok && byDefault.reason, "canvas-default");
});

test("falling through to Guest says so, out loud", () => {
  // Only the built-in profile is available: nothing to choose, and nothing
  // signed in either. Reporting the first without the second is the bug.
  const decision = decideAgentProfileForSpawn({ candidates: [guest] });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.profileId, GUEST_PROFILE_ID);
    assert.equal(decision.isGuest, true);
    assert.match(decision.summary, /signed out/i);
  }
});

test("passing over the canvas default is reported, not hidden", () => {
  // The default holds no session for this site and exactly one other profile
  // does — the one case where a heuristic beats explicit intent, and so the
  // one case that most needs saying.
  const decision = decideAgentProfileForSpawn({
    canvasDefault: "identity-work",
    candidates: [
      { ...work, hasSessionForSite: false },
      { ...personal, hasSessionForSite: true },
    ],
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.profileId, "identity-personal");
    assert.equal(decision.reason, "only-session");
    assert.deepEqual(decision.overrodeCanvasDefault, { id: "identity-work", name: "Work" });
    assert.match(decision.summary, /"Work"/);
  }
});

test("no canvas default and several choices is an actionable refusal", () => {
  const decision = decideAgentProfileForSpawn({ candidates: [guest, work, personal, banking] });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.code, "profile_choice_required");
    // The agent has to be able to re-call with one of these.
    assert.deepEqual(
      (decision.choices ?? []).map((c) => c.name),
      ["Guest", "Work", "Personal"],
    );
    assert.match(decision.message, /profile/);
    // The withheld one is not offered as a choice.
    assert.equal(decision.message.includes("Banking"), false);
  }

  // Asked and dismissed (null) is still "no default" — it must not silently
  // become a pick.
  const dismissed = decideAgentProfileForSpawn({
    canvasDefault: null,
    candidates: [guest, work, personal],
  });
  assert.equal(dismissed.ok === false && dismissed.code, "profile_choice_required");
});

test("every profile withheld refuses rather than quietly using Guest", () => {
  const decision = decideAgentProfileForSpawn({
    candidates: [{ ...guest, agentAllowed: false }, banking],
  });
  assert.equal(decision.ok === false && decision.code, "no_profile_permitted");
});

test("revoking a profile stops the next action and leaves the node alone", () => {
  // A node already open on Work, mid-task.
  const nodes: Record<string, { identityId: string; url: string }> = {
    "browser-1": { identityId: "identity-work", url: "https://mail.example.com/thread/9" },
  };
  let candidates: AgentProfileEntry[] = [guest, work];

  assert.deepEqual(checkAgentBrowserAction(nodes["browser-1"].identityId, candidates), {
    allowed: true,
  });

  // The user flips the toggle off mid-run.
  candidates = [guest, { ...work, agentAllowed: false }];

  const refusal = checkAgentBrowserAction(nodes["browser-1"].identityId, candidates);
  assert.equal(refusal.allowed, false);
  if (!refusal.allowed) {
    // Typed, so this reports as a stuck task rather than an inexplicable error.
    assert.equal(refusal.code, "profile_revoked");
    assert.equal(refusal.profileId, "identity-work");
    assert.equal(refusal.profileName, "Work");
    assert.match(refusal.message, /Work/);
    // The refusal must not read as "we will continue as someone else".
    assert.match(refusal.message, /untouched/i);
  }

  // The check is a refusal, not a teardown: the page and session survive, and
  // the node becomes the user's alone to finish by hand or close.
  assert.deepEqual(nodes["browser-1"], {
    identityId: "identity-work",
    url: "https://mail.example.com/thread/9",
  });

  // Turning it back on resumes access without re-spawning anything.
  candidates = [guest, work];
  assert.deepEqual(checkAgentBrowserAction("identity-work", candidates), { allowed: true });
});

test("a node on a deleted profile is refused distinctly from a revoked one", () => {
  const refusal = checkAgentBrowserAction("identity-gone", [guest, work]);
  assert.equal(refusal.allowed, false);
  assert.equal(refusal.allowed === false && refusal.code, "profile_unknown");
});
