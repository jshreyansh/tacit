import type { SceneDocument } from "./scene";
import type { BrowserIdentityProvenance } from "../../shared/browser-profile-import";

export interface WorkspaceCanvas {
  id: string;
  name: string;
  createdAt: number;
  scene: SceneDocument;
  /** Terminal id of the agent currently holding the "workspace manager"
   * role for this canvas — a designation, not a node type. See
   * docs/workspace_project_manager.md. Null/absent when unassigned. */
  workspaceManagerTerminalId?: string | null;
  /**
   * Which profile agents work as on this canvas. Asked once, the first time an
   * agent needs a browser here — never during import, which is global and
   * one-off and so cannot answer a per-canvas question.
   *
   * Absent means unanswered, which is what makes the prompt appear. Null is
   * different and deliberate: it records that the question was asked and
   * dismissed, so it is not re-asked on every action.
   */
  agentDefaultIdentityId?: string | null;
}

/** A named, persistent browser session (cookie jar) a browser card can be
 * assigned to. Cards sharing an identity share login state; different
 * identities never leak into each other. No credentials are stored here —
 * just the label for a Chromium session partition. */
export interface BrowserIdentity {
  id: string;
  name: string;
  createdAt: number;
  provenance?: BrowserIdentityProvenance;
  /**
   * Whether agents may act as this profile. Restricts agents only — the user
   * can always open a node on any profile themselves, which is the asymmetry
   * that lets a personal mailbox stay one click away for its owner and out of
   * reach for an agent.
   *
   * Absent means allowed: profiles imported before this existed keep working,
   * and the product decision is that a first agent task hitting a permission
   * wall is worse than the alternative. The toggle sits on the import result
   * row so the choice is made while reviewing each profile.
   */
  agentAllowed?: boolean;
}

/** Absent means allowed; see `agentAllowed`. */
export function isAgentAllowed(identity: { agentAllowed?: boolean }): boolean {
  return identity.agentAllowed !== false;
}

export interface WorkspaceDocument {
  version: 3;
  activeCanvasId: string;
  canvases: WorkspaceCanvas[];
  identities: BrowserIdentity[];
  activeIdentityId: string;
}

export const DEFAULT_CANVAS_NAME = "Default";
export const DEFAULT_IDENTITY_ID = "identity-default";
/**
 * The built-in profile holds no one's session. It was called "Default", which
 * made the signed-out one sound like the correct choice — and it collided with
 * Chrome's own `Default` profile directory, so an unnamed Chrome profile
 * imported as "Default 2" while the empty one kept the good name.
 */
export const DEFAULT_IDENTITY_NAME = "Guest";
