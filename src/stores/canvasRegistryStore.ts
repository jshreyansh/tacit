/**
 * Canvas registry — multiple named canvases, each carrying its own
 * SceneDocument (projects + viewport + drawings + cards + stash). The
 * active canvas is the one currently mirrored into the live per-canvas
 * stores (useProjectStore, useCanvasStore, useDrawingStore, …); the
 * inactive ones live frozen in `canvases[*].scene` until you switch.
 *
 * Single-canvas users see no difference — first run seeds one entry
 * named "Default" and every action keeps editing that one. The plural
 * is opt-in via the create command.
 */
import { create } from "zustand";
import { recordManagerRoleChange } from "../managerRole";
import {
  applyCanvasSceneToLive,
  captureLiveCanvasScene,
} from "../canvas/canvasSceneIO";
import { buildSceneDocument } from "../canvas/sceneProjection";
import type { SceneDocument } from "../types/scene";
import type { WorkspaceCanvas } from "../types/workspace";
import { DEFAULT_CANVAS_NAME } from "../types/workspace";
import { useWorkspaceStore } from "./workspaceStore";

let canvasIdCounter = 0;

export function generateCanvasId(): string {
  return `canvas-${Date.now().toString(36)}-${++canvasIdCounter}`;
}

function emptyScene(): SceneDocument {
  return buildSceneDocument({
    viewport: { x: 0, y: 0, scale: 1 },
    projects: [],
    drawings: [],
    browserCards: {},
  });
}

function uniqueCanvasName(
  baseName: string,
  canvases: readonly WorkspaceCanvas[],
): string {
  const trimmed = baseName.trim() || DEFAULT_CANVAS_NAME;
  const taken = new Set(canvases.map((c) => c.name.toLowerCase()));
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${trimmed} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

interface CanvasRegistryState {
  canvases: WorkspaceCanvas[];
  activeCanvasId: string;
}

interface CanvasRegistryActions {
  /**
   * Replace the entire registry from a persisted document. Used during
   * snapshot restore. Caller is responsible for applying the active
   * canvas's scene to the live stores.
   */
  hydrate: (canvases: WorkspaceCanvas[], activeCanvasId: string) => void;
  /** Sync the live stores' state into the active canvas, then return the registry. */
  syncActiveFromLive: () => WorkspaceCanvas[];
  /** Create a new empty canvas, switch to it, mark dirty. Returns the new id. */
  createCanvas: (name?: string) => string;
  renameCanvas: (id: string, name: string) => void;
  /** Delete a canvas. If it was active, switch to a sibling. No-op if last canvas. */
  deleteCanvas: (id: string) => void;
  /** Switch to canvas `id`. Captures live state into the previous canvas first. */
  switchCanvas: (id: string) => void;
  cycleCanvas: (direction: 1 | -1) => void;
  /** Assign (or clear, with `null`) which terminal holds the workspace
   * manager role for canvas `id`. See docs/workspace_project_manager.md. */
  setWorkspaceManager: (id: string, terminalId: string | null) => void;
  /**
   * Record this canvas's answer to "which profile do agents work as here?".
   * `null` is not the same as never setting it: it records that the question
   * was asked and dismissed, so it is not re-asked at every action. Absent —
   * the state this never writes — is the only one that shows the prompt.
   */
  setAgentDefaultIdentity: (id: string, identityId: string | null) => void;
}

export type CanvasRegistryStore = CanvasRegistryState & CanvasRegistryActions;

function seedDefaultCanvas(): CanvasRegistryState {
  const id = generateCanvasId();
  return {
    canvases: [
      {
        id,
        name: DEFAULT_CANVAS_NAME,
        createdAt: Date.now(),
        scene: emptyScene(),
      },
    ],
    activeCanvasId: id,
  };
}

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

export const useCanvasRegistryStore = create<CanvasRegistryStore>(
  (set, get) => ({
    ...seedDefaultCanvas(),

    hydrate: (canvases, activeCanvasId) => {
      if (canvases.length === 0) {
        set(seedDefaultCanvas());
        return;
      }
      const activeId = canvases.some((c) => c.id === activeCanvasId)
        ? activeCanvasId
        : canvases[0].id;
      set({ canvases, activeCanvasId: activeId });
    },

    syncActiveFromLive: () => {
      const { canvases, activeCanvasId } = get();
      const liveScene = captureLiveCanvasScene();
      const next = canvases.map((c) =>
        c.id === activeCanvasId ? { ...c, scene: liveScene } : c,
      );
      set({ canvases: next });
      return next;
    },

    createCanvas: (name) => {
      const { canvases, activeCanvasId } = get();
      const liveScene = captureLiveCanvasScene();
      const updatedExisting = canvases.map((c) =>
        c.id === activeCanvasId ? { ...c, scene: liveScene } : c,
      );
      const id = generateCanvasId();
      const finalName = uniqueCanvasName(
        name?.trim() || `Canvas ${canvases.length + 1}`,
        updatedExisting,
      );
      const fresh: WorkspaceCanvas = {
        id,
        name: finalName,
        createdAt: Date.now(),
        scene: emptyScene(),
      };
      set({
        canvases: [...updatedExisting, fresh],
        activeCanvasId: id,
      });
      applyCanvasSceneToLive(fresh.scene);
      markDirty();
      return id;
    },

    renameCanvas: (id, name) => {
      const { canvases } = get();
      const target = canvases.find((c) => c.id === id);
      if (!target) return;
      const others = canvases.filter((c) => c.id !== id);
      const finalName = uniqueCanvasName(name, others);
      if (finalName === target.name) return;
      set({
        canvases: canvases.map((c) =>
          c.id === id ? { ...c, name: finalName } : c,
        ),
      });
      markDirty();
    },

    deleteCanvas: (id) => {
      const { canvases, activeCanvasId } = get();
      if (canvases.length <= 1) return;
      const remaining = canvases.filter((c) => c.id !== id);
      if (id !== activeCanvasId) {
        set({ canvases: remaining });
        markDirty();
        return;
      }
      const fallback = remaining[0];
      set({ canvases: remaining, activeCanvasId: fallback.id });
      applyCanvasSceneToLive(fallback.scene);
      markDirty();
    },

    switchCanvas: (id) => {
      const { canvases, activeCanvasId } = get();
      if (id === activeCanvasId) return;
      const target = canvases.find((c) => c.id === id);
      if (!target) return;
      const liveScene = captureLiveCanvasScene();
      const updated = canvases.map((c) =>
        c.id === activeCanvasId ? { ...c, scene: liveScene } : c,
      );
      set({ canvases: updated, activeCanvasId: id });
      applyCanvasSceneToLive(target.scene);
      markDirty();
    },

    cycleCanvas: (direction) => {
      const { canvases, activeCanvasId } = get();
      if (canvases.length < 2) return;
      const idx = canvases.findIndex((c) => c.id === activeCanvasId);
      if (idx === -1) return;
      const nextIdx =
        (idx + direction + canvases.length) % canvases.length;
      get().switchCanvas(canvases[nextIdx].id);
    },

    setWorkspaceManager: (id, terminalId) => {
      const { canvases } = get();
      if (!canvases.some((c) => c.id === id)) return;
      const previous =
        canvases.find((c) => c.id === id)?.workspaceManagerTerminalId ?? null;
      set({
        canvases: canvases.map((c) =>
          c.id === id
            ? { ...c, workspaceManagerTerminalId: terminalId }
            : c,
        ),
      });
      markDirty();

      // Recorded here, not at the call sites: the pill and the __tcApi surface
      // both land on this action, and only the latter used to record — so
      // assigning the role the normal way (through the pill) left no trace at
      // all. One choke point is the whole reason both now do.
      if (previous !== terminalId) {
        recordManagerRoleChange(id, terminalId);
      }
    },

    setAgentDefaultIdentity: (id, identityId) => {
      const { canvases } = get();
      if (!canvases.some((c) => c.id === id)) return;
      set({
        canvases: canvases.map((c) =>
          c.id === id ? { ...c, agentDefaultIdentityId: identityId } : c,
        ),
      });
      markDirty();
    },
  }),
);

export function getActiveCanvas(): WorkspaceCanvas {
  const { canvases, activeCanvasId } = useCanvasRegistryStore.getState();
  return (
    canvases.find((c) => c.id === activeCanvasId) ?? canvases[0]
  );
}

/** Terminal id currently holding the workspace manager role for a canvas
 * (defaults to the active canvas), or null if unassigned. */
export function getWorkspaceManagerTerminalId(canvasId?: string): string | null {
  const { canvases, activeCanvasId } = useCanvasRegistryStore.getState();
  const targetId = canvasId ?? activeCanvasId;
  const canvas = canvases.find((c) => c.id === targetId);
  return canvas?.workspaceManagerTerminalId ?? null;
}

/**
 * This canvas's agent profile default, in three states: a string is the
 * answer, `null` means asked and dismissed, and `undefined` means never
 * asked — which is what makes the prompt appear. Do not collapse the last two
 * with `?? null`; dismissing would then re-ask forever.
 */
export function getAgentDefaultIdentityId(
  canvasId?: string,
): string | null | undefined {
  const { canvases, activeCanvasId } = useCanvasRegistryStore.getState();
  const targetId = canvasId ?? activeCanvasId;
  const canvas = canvases.find((c) => c.id === targetId);
  if (!canvas || !("agentDefaultIdentityId" in canvas)) return undefined;
  return canvas.agentDefaultIdentityId;
}

/** The canvas (if any) whose workspace manager is `terminalId`. Used to
 * gate PM-only API routes without the caller having to know which canvas
 * it belongs to. */
export function findCanvasByWorkspaceManager(
  terminalId: string,
): WorkspaceCanvas | null {
  const { canvases } = useCanvasRegistryStore.getState();
  return (
    canvases.find((c) => c.workspaceManagerTerminalId === terminalId) ?? null
  );
}
