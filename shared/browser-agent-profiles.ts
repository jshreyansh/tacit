/**
 * Which profile an agent acts as.
 *
 * An agent working in an imported profile can do anything its owner can — send
 * mail as them, post as them, spend their money. So this is a permission
 * decision before it is a defaulting decision, and both halves live here,
 * pure, because "which identity did the software choose on my behalf" is not a
 * question that should be answerable only by running the app.
 *
 * Two scopes, deliberately different:
 *
 *  - **Allowed** is global and set at import. It restricts agents only; the
 *    user can always open any profile themselves.
 *  - **Canvas default** is per canvas and asked once, at the first moment an
 *    agent needs a browser there.
 *
 * See docs/architecture/browser-profile-adoption.md, "Agents and profiles".
 */

export interface AgentProfileCandidate {
  id: string;
  name: string;
  /** Whether agents may act as this profile at all. Global, user-controlled. */
  agentAllowed: boolean;
  /** Whether this profile holds a session for the site in question. */
  hasSessionForSite?: boolean;
}

export interface AgentProfileRequest {
  /** A profile the agent named outright. */
  requested?: string | null;
  /** The profile of a node this agent is already driving. */
  inherited?: string | null;
  /** This canvas's default, once the user has set one. */
  canvasDefault?: string | null;
  candidates: readonly AgentProfileCandidate[];
}

export type AgentProfileResolution =
  | {
      outcome: "resolved";
      profileId: string;
      /** Why this one, so the agent can say it rather than assert a choice. */
      reason: "requested" | "inherited" | "canvas-default" | "only-session" | "guest";
      /**
       * Set when the canvas default was passed over because it had no session
       * for the site and exactly one other allowed profile did.
       */
      overrodeCanvasDefault?: string;
    }
  | {
      outcome: "refused";
      /** The agent named a profile it may not use, or none is permitted. */
      reason: "not-allowed" | "unknown-profile" | "none-allowed";
      profileId?: string;
    }
  | {
      outcome: "ask";
      /** More than one allowed profile and no default set for this canvas. */
      reason: "no-canvas-default";
      choices: readonly AgentProfileCandidate[];
    };

/** The built-in signed-out profile. Never carries anyone's session. */
export const GUEST_PROFILE_ID = "identity-default";

function allowedOnly(
  candidates: readonly AgentProfileCandidate[],
): AgentProfileCandidate[] {
  return candidates.filter((c) => c.agentAllowed);
}

function find(
  candidates: readonly AgentProfileCandidate[],
  id: string | null | undefined,
): AgentProfileCandidate | undefined {
  return id ? candidates.find((c) => c.id === id) : undefined;
}

export function resolveAgentProfile(
  request: AgentProfileRequest,
): AgentProfileResolution {
  const { requested, inherited, canvasDefault, candidates } = request;

  // 1. An explicit request is honoured or refused, never quietly substituted.
  //    Silently downgrading a named profile to another one would let an agent
  //    report work done "as Work" that happened as somebody else.
  if (requested) {
    const match = find(candidates, requested);
    if (!match) return { outcome: "refused", reason: "unknown-profile", profileId: requested };
    if (!match.agentAllowed) {
      return { outcome: "refused", reason: "not-allowed", profileId: requested };
    }
    return { outcome: "resolved", profileId: match.id, reason: "requested" };
  }

  const allowed = allowedOnly(candidates);
  if (allowed.length === 0) return { outcome: "refused", reason: "none-allowed" };

  // 2. Continuity: a task that began in one identity stays in it. Checked
  //    against the current allow-list, so a revoked profile stops being
  //    inherited the moment it is turned off.
  const inheritedMatch = find(allowed, inherited);
  if (inheritedMatch) {
    return { outcome: "resolved", profileId: inheritedMatch.id, reason: "inherited" };
  }

  const withSession = allowed.filter((c) => c.hasSessionForSite);

  // 3. The canvas default, unless following it produces the signed-out page
  //    this project exists to prevent and exactly one other profile can do the
  //    job. Explicit intent beats a heuristic — but not a provably failing one.
  const defaultMatch = find(allowed, canvasDefault);
  if (defaultMatch) {
    if (
      defaultMatch.hasSessionForSite === false &&
      withSession.length === 1 &&
      withSession[0] &&
      withSession[0].id !== defaultMatch.id
    ) {
      return {
        outcome: "resolved",
        profileId: withSession[0].id,
        reason: "only-session",
        overrodeCanvasDefault: defaultMatch.id,
      };
    }
    return { outcome: "resolved", profileId: defaultMatch.id, reason: "canvas-default" };
  }

  // 4. No default set. One allowed profile is not a choice, so do not stage a
  //    question the user can only answer one way.
  if (allowed.length === 1 && allowed[0]) {
    return { outcome: "resolved", profileId: allowed[0].id, reason: "canvas-default" };
  }
  if (withSession.length === 1 && withSession[0]) {
    return { outcome: "resolved", profileId: withSession[0].id, reason: "only-session" };
  }

  return { outcome: "ask", reason: "no-canvas-default", choices: allowed };
}

/**
 * Whether an agent may act on a node right now.
 *
 * Separate from resolution because it is checked again at every action, not
 * once at spawn: revoking a profile must stop a task that is already running,
 * and a decision made when the node opened is worth nothing by then.
 */
export function mayAgentUseProfile(
  profileId: string,
  candidates: readonly AgentProfileCandidate[],
): boolean {
  return find(candidates, profileId)?.agentAllowed === true;
}
