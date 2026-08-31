/**
 * Renderer glue between the live stores and the pure permission logic in
 * shared/browser-agent-profile-access.ts.
 *
 * Everything here is lookup: the identity registry becomes candidates, the
 * active canvas supplies its default, and the connection graph supplies the
 * profile of whatever browser node this agent is already driving. No decision
 * is made in this file — decisions live in `shared/` where they are testable
 * without an app around them.
 */

import { useIdentityStore } from "../stores/identityStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { connectionsInvolving, useConnectionStore } from "../stores/connectionStore";
import { getAgentDefaultIdentityId } from "../stores/canvasRegistryStore";
import { useAgentProfilePromptStore } from "../stores/agentProfilePromptStore";
import { isAgentAllowed } from "../types/workspace";
import {
  checkAgentBrowserAction,
  decideAgentProfileForSpawn,
  listAgentProfiles,
  type AgentActionPermission,
  type AgentProfileDecision,
  type AgentProfileEntry,
  type AgentProfileListEntry,
} from "../../shared/browser-agent-profile-access";

/**
 * Every profile that exists, allowed or not.
 *
 * Withheld ones are included on purpose: the cascade needs them to refuse a
 * named profile as *withheld* rather than as *missing*, and the per-action
 * check needs them to tell a revoked profile from a deleted one. Filtering to
 * what an agent may see happens at the surface, in `listAgentProfiles`.
 */
export function agentProfileCandidates(): AgentProfileEntry[] {
  const { identities } = useIdentityStore.getState();
  return Object.values(identities).map((identity) => ({
    id: identity.id,
    name: identity.name,
    agentAllowed: isAgentAllowed(identity),
    fromChrome: identity.provenance != null,
  }));
}

/**
 * This canvas's default profile for agents.
 *
 * Absent means never asked; null means asked and dismissed. Both come back as
 * null here, because the cascade treats "no default" the same either way — the
 * difference only matters to the prompt that asks.
 */
export function canvasAgentDefaultProfileId(): string | null {
  return getAgentDefaultIdentityId() ?? null;
}

/**
 * The profile of the browser node this terminal is already driving.
 *
 * Same "most recently connected wins" rule as getBrowserBindingForTerminal in
 * App.tsx, and for the same reason: that is the node the browser_* tools
 * target, so it is the identity the task is already running as.
 */
export function inheritedAgentProfileId(terminalId: string | null | undefined): string | null {
  if (!terminalId) return null;
  const connections = connectionsInvolving(
    useConnectionStore.getState().connections,
    "terminal",
    terminalId,
  );
  let mostRecent: { id: string; createdAt: number } | null = null;
  for (const connection of connections) {
    const other = connection.from.kind === "browser" ? connection.from : connection.to;
    if (other.kind !== "browser") continue;
    if (!mostRecent || connection.createdAt > mostRecent.createdAt) {
      mostRecent = { id: other.id, createdAt: connection.createdAt };
    }
  }
  if (!mostRecent) return null;
  return useBrowserCardStore.getState().cards[mostRecent.id]?.identityId ?? null;
}

/** The profiles this agent may see and name. Withheld ones are absent. */
export function listAgentBrowserProfiles(): AgentProfileListEntry[] {
  return listAgentProfiles(agentProfileCandidates(), canvasAgentDefaultProfileId());
}

/**
 * Which profile a spawn should open as, and why — see the shared module.
 *
 * When the cascade cannot decide, two things happen and neither substitutes
 * for the other. The user is asked, once, on the canvas where the work is
 * happening (agentProfilePromptStore owns that question). And the agent is
 * refused with the list of choices, so it can name one itself rather than
 * block on a modal it cannot see and the user may not be sitting in front of.
 *
 * The prompt is only raised when the question has never been put. `null` means
 * asked and declined, and re-opening a modal the user just dismissed at every
 * subsequent spawn would turn a permission into nagging.
 */
/** How long the spawn waits for the user to answer the profile prompt. */
const CANVAS_DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

function decideOnce(options: {
  requesterTerminalId?: string | null;
  profile?: string | null;
}): AgentProfileDecision {
  return decideAgentProfileForSpawn({
    requested: options.profile ?? null,
    inherited: inheritedAgentProfileId(options.requesterTerminalId),
    canvasDefault: canvasAgentDefaultProfileId(),
    candidates: agentProfileCandidates(),
  });
}

/**
 * Resolves once the canvas has an answer — chosen or dismissed — or the wait
 * times out. Watching the canvas rather than the modal's own state means a
 * default set from anywhere else (the command palette, another node) also
 * releases the waiting spawn.
 */
function awaitCanvasDefault(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, CANVAS_DEFAULT_PROMPT_TIMEOUT_MS);
    const unsubscribe = useAgentProfilePromptStore.subscribe(() => {
      if (getAgentDefaultIdentityId() !== undefined) finish();
    });
    if (getAgentDefaultIdentityId() !== undefined) finish();
  });
}

export async function decideSpawnProfile(options: {
  requesterTerminalId?: string | null;
  profile?: string | null;
}): Promise<AgentProfileDecision> {
  const decision = decideOnce(options);
  if (
    decision.ok ||
    decision.code !== "profile_choice_required" ||
    getAgentDefaultIdentityId() !== undefined
  ) {
    return decision;
  }

  // Ask the user, and wait for the answer rather than refusing immediately.
  // Returning the refusal here as well made the agent ask a second time in its
  // own terminal, so the user answered the same question twice — once in the
  // modal and once in prose — with no sign the first answer had landed.
  useAgentProfilePromptStore.getState().requestCanvasDefault();
  await awaitCanvasDefault();
  return decideOnce(options);
}

/**
 * May an agent act on this node right now?
 *
 * Connected-browser nodes (a real Chrome the user paired) carry no Tacit
 * profile, so there is nothing here to allow or withhold; their own pairing is
 * the permission. Only managed nodes are gated.
 */
export function checkAgentActionOnCard(cardId: string): AgentActionPermission {
  const card = useBrowserCardStore.getState().cards[cardId];
  if (!card) return { allowed: true };
  if (card.backend && card.backend.kind !== "managed") return { allowed: true };
  return checkAgentBrowserAction(card.identityId, agentProfileCandidates());
}
