import { useCanvasRegistryStore } from "./stores/canvasRegistryStore";
import { useIdentityStore } from "./stores/identityStore";
import { useChatInputOverrideStore } from "./stores/chatInputOverrideStore";
import { applyCanvasSceneToLive } from "./canvas/canvasSceneIO";
import { logSlowRendererPath } from "./utils/devPerf";
import { DEFAULT_IDENTITY_ID, DEFAULT_IDENTITY_NAME } from "./types/workspace";
import type { WorkspaceDocument } from "./types/workspace";
import {
  readWorkspaceSnapshot,
  type RestoredWorkspaceSnapshot,
  type SkipRestoreSnapshot,
  type SceneWorkspaceSnapshot,
  type MultiCanvasWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./snapshotBridge";
import {
  refreshClaudeSessionStates,
} from "./terminal/terminalRuntimeStore";

export function restoreWorkspaceSnapshot(
  snapshot: RestoredWorkspaceSnapshot,
) {
  const workspace = snapshot.workspace ?? wrapSceneAsDefaultWorkspace(snapshot.scene);
  useCanvasRegistryStore
    .getState()
    .hydrate(workspace.canvases, workspace.activeCanvasId);
  useIdentityStore
    .getState()
    .hydrate(workspace.identities, workspace.activeIdentityId);
  useChatInputOverrideStore
    .getState()
    .hydrate(workspace.chatInputOverrides ?? []);
  applyCanvasSceneToLive(snapshot.scene);
}

function wrapSceneAsDefaultWorkspace(
  scene: RestoredWorkspaceSnapshot["scene"],
): WorkspaceDocument {
  const id = `canvas-default-${Date.now().toString(36)}`;
  return {
    version: 3 as const,
    activeCanvasId: id,
    canvases: [
      {
        id,
        name: "Default",
        createdAt: Date.now(),
        scene,
      },
    ],
    identities: [
      {
        id: DEFAULT_IDENTITY_ID,
        name: DEFAULT_IDENTITY_NAME,
        createdAt: Date.now(),
      },
    ],
    activeIdentityId: DEFAULT_IDENTITY_ID,
  };
}

export {
  type LegacyWorkspaceSnapshot,
  readWorkspaceSnapshot,
  type RestoredWorkspaceSnapshot,
  type SkipRestoreSnapshot,
  type SceneWorkspaceSnapshot,
  type MultiCanvasWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./snapshotBridge";

function buildMultiCanvasSnapshot(): MultiCanvasWorkspaceSnapshot {
  const startedAt = performance.now();
  const canvases = useCanvasRegistryStore.getState().syncActiveFromLive();
  const { activeCanvasId } = useCanvasRegistryStore.getState();
  const active =
    canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];

  logSlowRendererPath("snapshotState.build", startedAt, {
    thresholdMs: 20,
    details: {
      canvases: canvases.length,
      activeProjects: active.scene.projects.length,
    },
  });

  const { identities, activeIdentityId } = useIdentityStore.getState();
  const { overrides: chatInputOverrides } = useChatInputOverrideStore.getState();

  return {
    version: 3,
    workspace: {
      version: 3,
      activeCanvasId: active.id,
      canvases,
      identities: Object.values(identities),
      activeIdentityId,
      // Omitted entirely when empty, so a workspace where the box was never
      // mis-detected carries no trace of the feature.
      ...(chatInputOverrides.length > 0 ? { chatInputOverrides } : {}),
    },
    scene: active.scene,
  };
}

export function buildSnapshotState(): MultiCanvasWorkspaceSnapshot {
  return buildMultiCanvasSnapshot();
}

export function snapshotState(): string {
  const startedAt = performance.now();
  const serialized = JSON.stringify(buildSnapshotState(), null, 2);
  logSlowRendererPath("snapshotState.serialize", startedAt, {
    thresholdMs: 20,
    details: { bytes: serialized.length },
  });
  return serialized;
}

/**
 * Refresh live Claude session states (sessionId + permissionMode) from
 * disk, then build and serialize the snapshot.  Use this instead of
 * snapshotState() when the save is user-initiated or happens at close
 * time, so /resume switches and permission toggles are captured.
 */
export async function snapshotStateWithRefresh(): Promise<string> {
  await refreshClaudeSessionStates();
  return snapshotState();
}
