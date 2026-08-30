/**
 * The per-canvas question: which profile do agents work as here?
 *
 * Asked once, on the canvas where the work is actually happening — not during
 * import, which is global and one-off and so cannot answer a question about a
 * canvas that does not exist yet. The answer lives on the canvas
 * (`WorkspaceCanvas.agentDefaultIdentityId`) and persists with the workspace.
 *
 * This store is only the renderer half: something asks it to open, the user
 * answers, and the answer is written through the canvas registry. Whoever
 * needs the answer — an agent resolving a profile, or a person opening it from
 * the UI — calls `requestCanvasDefault` and reads the canvas afterwards.
 *
 * See docs/architecture/browser-profile-adoption.md, "Agents and profiles".
 */
import { create } from "zustand";
import { useCanvasRegistryStore, getAgentDefaultIdentityId } from "./canvasRegistryStore";

interface AgentProfilePromptState {
  /** The canvas being asked about, or null when the prompt is closed. */
  canvasId: string | null;
}

interface AgentProfilePromptActions {
  /**
   * Open the prompt for a canvas (the active one by default). No-op if the
   * canvas does not exist, or if the prompt is already open for it.
   */
  requestCanvasDefault: (canvasId?: string) => void;
  /** Record the chosen profile for the canvas being asked about, and close. */
  choose: (identityId: string) => void;
  /**
   * Close without choosing. This writes `null`, which is an answer — "asked,
   * declined" — and is what stops the same question being asked again at the
   * agent's next action.
   */
  dismiss: () => void;
}

export type AgentProfilePromptStore = AgentProfilePromptState &
  AgentProfilePromptActions;

export const useAgentProfilePromptStore = create<AgentProfilePromptStore>(
  (set, get) => ({
    canvasId: null,

    requestCanvasDefault: (canvasId) => {
      const registry = useCanvasRegistryStore.getState();
      const targetId = canvasId ?? registry.activeCanvasId;
      if (!registry.canvases.some((c) => c.id === targetId)) return;
      if (get().canvasId === targetId) return;
      set({ canvasId: targetId });
    },

    choose: (identityId) => {
      const { canvasId } = get();
      if (!canvasId) return;
      useCanvasRegistryStore
        .getState()
        .setAgentDefaultIdentity(canvasId, identityId);
      set({ canvasId: null });
    },

    dismiss: () => {
      const { canvasId } = get();
      if (!canvasId) return;
      useCanvasRegistryStore.getState().setAgentDefaultIdentity(canvasId, null);
      set({ canvasId: null });
    },
  }),
);

/**
 * Whether this canvas has never been asked. Distinct from having answered
 * `null`, which is a decision and must not re-open the prompt.
 */
export function canvasDefaultUnanswered(canvasId?: string): boolean {
  return getAgentDefaultIdentityId(canvasId) === undefined;
}
