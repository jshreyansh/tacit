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
export const DEFAULT_IDENTITY_NAME = "Default";
