/**
 * The agent-facing half of browser profile permissions.
 *
 * `browser-agent-profiles.ts` answers "which profile, and may an agent use
 * it". This module answers the questions that sit either side of that, and it
 * is separate for one reason: an agent names a profile the way a person does —
 * by the label it reads on the node — while every store below speaks in ids.
 * Translating one into the other is where a wrong guess turns into work done
 * as the wrong person, so it is pure, and it is tested.
 *
 * Three jobs:
 *
 *  - `matchProfileSelector` turns a name or id into an id, refusing an
 *    ambiguous name rather than picking one.
 *  - `decideAgentProfileForSpawn` runs the cascade and produces a decision an
 *    agent can *say out loud*. Silent selection is the failure that put a
 *    signed-out Gemini in front of a user who assumed otherwise.
 *  - `checkAgentBrowserAction` re-checks permission at every action, because
 *    revoking a profile has to stop a task that is already running.
 *
 * See docs/architecture/browser-profile-adoption.md, "Agents and profiles".
 */

import {
  GUEST_PROFILE_ID,
  mayAgentUseProfile,
  resolveAgentProfile,
  type AgentProfileCandidate,
} from "./browser-agent-profiles";

export interface AgentProfileEntry extends AgentProfileCandidate {
  /**
   * Imported from a Chrome profile rather than created empty here. Reported
   * as a bare boolean: an agent may need to know a profile carries a real
   * person's session, and never needs to know whose or from where.
   */
  fromChrome?: boolean;
}

/** What an agent may see of a profile. No account hint, no provenance. */
export interface AgentProfileListEntry {
  id: string;
  name: string;
  isCanvasDefault: boolean;
  fromChrome: boolean;
}

export type ProfileSelectorMatch =
  | { outcome: "matched"; id: string }
  /** Two profiles answer to this name. Refused rather than guessed at. */
  | { outcome: "ambiguous"; selector: string; names: string[] }
  | { outcome: "unknown"; selector: string };

/**
 * Resolve what an agent typed into a profile id.
 *
 * Ids win over names, and exact wins over case-insensitive, so a profile
 * literally named after another one's id cannot shadow it. Names are matched
 * case-insensitively because an agent copies the label off the node, and
 * "work" and "Work" are the same request from a human's point of view.
 *
 * Matching deliberately spans *withheld* profiles too. Refusing "Banking"
 * with "you may not use that" is a fact the agent can act on; refusing it with
 * "no such profile" would send it hunting for a typo that isn't there.
 */
export function matchProfileSelector(
  selector: string,
  candidates: readonly AgentProfileEntry[],
): ProfileSelectorMatch {
  const trimmed = selector.trim();
  if (!trimmed) return { outcome: "unknown", selector };

  const exactId = candidates.find((c) => c.id === trimmed);
  if (exactId) return { outcome: "matched", id: exactId.id };

  const lower = trimmed.toLowerCase();
  const looseId = candidates.filter((c) => c.id.toLowerCase() === lower);
  if (looseId.length === 1 && looseId[0]) return { outcome: "matched", id: looseId[0].id };

  const exactName = candidates.filter((c) => c.name === trimmed);
  if (exactName.length === 1 && exactName[0]) {
    return { outcome: "matched", id: exactName[0].id };
  }

  const byName = candidates.filter((c) => c.name.trim().toLowerCase() === lower);
  if (byName.length === 1 && byName[0]) return { outcome: "matched", id: byName[0].id };
  if (byName.length > 1) {
    return { outcome: "ambiguous", selector: trimmed, names: byName.map((c) => c.name) };
  }
  return { outcome: "unknown", selector: trimmed };
}

/**
 * The profiles an agent may work as.
 *
 * A withheld profile is not listed at all — not listed-and-marked-forbidden.
 * The toggle means "this identity is not available to agents", and an agent
 * that can read the name off a list can name it in a request, in a prompt, or
 * in a message to the user. Absence is the only honest rendering.
 */
export function listAgentProfiles(
  candidates: readonly AgentProfileEntry[],
  canvasDefault?: string | null,
): AgentProfileListEntry[] {
  return candidates
    .filter((c) => c.agentAllowed)
    .map((c) => ({
      id: c.id,
      name: c.name,
      isCanvasDefault: !!canvasDefault && c.id === canvasDefault,
      fromChrome: c.fromChrome === true,
    }));
}

export interface AgentProfileSpawnRequest {
  /** A profile name or id the agent named outright. */
  requested?: string | null;
  /** The profile of a browser node this agent is already driving. */
  inherited?: string | null;
  /** This canvas's default. Null means asked and dismissed — not a default. */
  canvasDefault?: string | null;
  candidates: readonly AgentProfileEntry[];
}

export type AgentProfileRefusalCode =
  /** The name matched more than one profile. */
  | "profile_ambiguous"
  /** No profile by that name or id. */
  | "profile_unknown"
  /** It exists, and the user has withheld it from agents. */
  | "profile_not_permitted"
  /** Every profile is withheld. */
  | "no_profile_permitted"
  /** Several are permitted, none is this canvas's default: the agent picks. */
  | "profile_choice_required";

export type AgentProfileDecision =
  | {
      ok: true;
      profileId: string;
      profileName: string;
      reason: "requested" | "inherited" | "canvas-default" | "only-session" | "guest";
      /** Set when the canvas default was passed over; see the cascade. */
      overrodeCanvasDefault?: { id: string; name: string };
      /** True when this is the signed-out built-in profile. */
      isGuest: boolean;
      /** One line the agent can repeat to the user verbatim. */
      summary: string;
    }
  | {
      ok: false;
      code: AgentProfileRefusalCode;
      message: string;
      /** Present for `profile_choice_required`: re-call naming one of these. */
      choices?: AgentProfileListEntry[];
    };

function nameOf(candidates: readonly AgentProfileEntry[], id: string): string {
  return candidates.find((c) => c.id === id)?.name ?? id;
}

const WHY: Record<
  "requested" | "inherited" | "canvas-default" | "only-session" | "guest",
  string
> = {
  requested: "you named it",
  inherited: "it is the profile of the browser node you are already driving, so this task stays in one identity",
  "canvas-default": "it is this canvas's default profile for agents",
  "only-session": "it is the only permitted profile holding a session for this site",
  guest: "no profile was named and none applied",
};

/**
 * Run the cascade for a spawn, and say what happened.
 *
 * The `summary` is not decoration. The contract requires the chosen profile to
 * be visible in the agent's reply, and a Guest fall-through to be stated out
 * loud — a signed-out node reaching a user who assumed they were signed in is
 * the specific bug this whole path exists to prevent.
 */
export function decideAgentProfileForSpawn(
  request: AgentProfileSpawnRequest,
): AgentProfileDecision {
  const { candidates } = request;

  let requestedId: string | null = null;
  if (request.requested != null && request.requested.trim() !== "") {
    const match = matchProfileSelector(request.requested, candidates);
    if (match.outcome === "ambiguous") {
      return {
        ok: false,
        code: "profile_ambiguous",
        message: `More than one browser profile is called "${match.selector}" (${match.names.join(", ")}). Ask the user which one, or name it by id — call list_browser_profiles to see the ids.`,
      };
    }
    if (match.outcome === "unknown") {
      return {
        ok: false,
        code: "profile_unknown",
        message: `No browser profile called "${match.selector}". Call list_browser_profiles to see the ones you may use.`,
      };
    }
    requestedId = match.id;
  }

  const resolution = resolveAgentProfile({
    requested: requestedId,
    inherited: request.inherited ?? null,
    canvasDefault: request.canvasDefault ?? null,
    candidates,
  });

  if (resolution.outcome === "refused") {
    if (resolution.reason === "not-allowed") {
      const name = nameOf(candidates, resolution.profileId ?? "");
      return {
        ok: false,
        code: "profile_not_permitted",
        message: `The user has withheld the "${name}" browser profile from agents. It stays available to them, not to you. Call list_browser_profiles for the profiles you may use, or ask the user to allow this one in the profile manager.`,
      };
    }
    if (resolution.reason === "unknown-profile") {
      return {
        ok: false,
        code: "profile_unknown",
        message: `No browser profile called "${resolution.profileId ?? request.requested ?? ""}". Call list_browser_profiles to see the ones you may use.`,
      };
    }
    return {
      ok: false,
      code: "no_profile_permitted",
      message:
        "No browser profile is available to agents on this canvas. Ask the user to allow one in the profile manager, then try again.",
    };
  }

  if (resolution.outcome === "ask") {
    const choices = listAgentProfiles(resolution.choices, request.canvasDefault);
    const names = choices.map((c) => `"${c.name}"`).join(", ");
    return {
      ok: false,
      code: "profile_choice_required",
      message: `This canvas has no default browser profile for agents and more than one is permitted (${names}). Which identity this runs as changes what it can do, so it is not guessed: call spawn_browser again with profile set to one of them, or ask the user which to use.`,
      choices,
    };
  }

  const profileName = nameOf(candidates, resolution.profileId);
  const isGuest = resolution.profileId === GUEST_PROFILE_ID;
  const overrode = resolution.overrodeCanvasDefault
    ? { id: resolution.overrodeCanvasDefault, name: nameOf(candidates, resolution.overrodeCanvasDefault) }
    : undefined;

  let summary = `Opened as the "${profileName}" browser profile — ${WHY[resolution.reason]}.`;
  if (overrode) {
    summary += ` This canvas's default ("${overrode.name}") was passed over because it holds no session for this site and this one does.`;
  }
  if (isGuest) {
    summary += " Guest is the built-in empty profile: this page is signed out of everything. Say so before reporting anything that looks like signed-in state.";
  }

  return {
    ok: true,
    profileId: resolution.profileId,
    profileName,
    reason: resolution.reason,
    ...(overrode ? { overrodeCanvasDefault: overrode } : {}),
    isGuest,
    summary,
  };
}

export type AgentActionPermission =
  | { allowed: true }
  | {
      allowed: false;
      /** Typed so a refusal reports as a stuck task, not a mystery failure. */
      code: "profile_revoked" | "profile_unknown";
      profileId: string;
      profileName?: string;
      message: string;
    };

/**
 * May an agent act on this node right now?
 *
 * Checked per action rather than once at spawn, because turning a profile off
 * has to stop work already in flight — a decision made when the node opened is
 * worth nothing by the time the user revokes.
 *
 * A refusal never closes the node. Revoking means agents may no longer act as
 * this person; it does not mean discarding their page. The node keeps its
 * session and becomes the user's alone, to finish by hand or close.
 */
export function checkAgentBrowserAction(
  profileId: string,
  candidates: readonly AgentProfileEntry[],
): AgentActionPermission {
  const match = candidates.find((c) => c.id === profileId);
  if (!match) {
    return {
      allowed: false,
      code: "profile_unknown",
      profileId,
      message: `This browser node is on a profile that no longer exists (${profileId}), so agent access to it cannot be checked. The node is untouched — ask the user to reassign it to a profile you may use.`,
    };
  }
  if (!mayAgentUseProfile(profileId, candidates)) {
    return {
      allowed: false,
      code: "profile_revoked",
      profileId,
      profileName: match.name,
      message: `The user has withheld the "${match.name}" browser profile from agents, so this node is no longer yours to drive. The node, its page and its session are untouched and are the user's to continue by hand. Report this as blocked: restarting the work as another permitted profile, or handing it to the user, are the options — it cannot be continued as a different identity.`,
    };
  }
  return { allowed: true };
}
