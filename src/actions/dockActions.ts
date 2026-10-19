import { useCanvasStore } from "../stores/canvasStore";
import { useProjectStore } from "../stores/projectStore";
import { getVisibleCanvasWorldRect } from "../canvas/viewportBounds";
import { createTerminalInScene } from "./terminalSceneActions";
import { addBrowserCardToScene } from "./sceneCardActions";
import { createNoteInScene, createTaskInScene } from "./scenePinActions";
import type { TerminalType } from "../types";

/**
 * The "add something to the canvas" actions, separated from the control that
 * offers them.
 *
 * They used to live in AddNodeDock.tsx, which meant the onboarding sequence
 * imported a toolbar component to spawn an agent. When the dock became the
 * left rail that import would have pointed at a different component for no
 * reason, so the actions moved to where they belong: callers ask for the
 * behaviour, not for the button that used to own it.
 */

/** Centre of the currently visible canvas area, in flow coordinates — same
 * viewport/panel bookkeeping createTerminalInScene already uses for its own
 * auto-placement, just reduced to a single point rather than full
 * collision-aware placement (each create action still resolves its own
 * final spot from there). */
export function visibleCanvasCenter(): { x: number; y: number } {
  const canvasState = useCanvasStore.getState();
  const rect = getVisibleCanvasWorldRect(
    canvasState.viewport,
    canvasState.rightPanelCollapsed,
    canvasState.rightPanelWidth,
  );
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Adds a terminal (or an agent's) to the canvas; its id, or null with no project open. */
export function addTerminal(type: TerminalType): string | null {
  const { focusedProjectId, focusedWorktreeId, projects } =
    useProjectStore.getState();
  let projectId = focusedProjectId;
  let worktreeId = focusedWorktreeId;
  if (!projectId || !worktreeId) {
    const fallbackProject = projects[0];
    const fallbackWorktree = fallbackProject?.worktrees[0];
    if (!fallbackProject || !fallbackWorktree) return null;
    projectId = fallbackProject.id;
    worktreeId = fallbackWorktree.id;
  }
  return createTerminalInScene({
    projectId,
    worktreeId,
    type,
    position: visibleCanvasCenter(),
  }).id;
}

/** Adds a browser, in the given profile or the default one; its id. */
export function addBrowser(identityId?: string): string {
  return addBrowserCardToScene(visibleCanvasCenter(), undefined, "user", identityId);
}

export function addTask() {
  const { focusedProjectId, projects } = useProjectStore.getState();
  const project =
    projects.find((p) => p.id === focusedProjectId) ?? projects[0];
  if (!project) return;
  void createTaskInScene(project.path, visibleCanvasCenter());
}

/** Adds a note to the canvas; resolves to its id, or null with no project open. */
export function addNote(): Promise<string | null> {
  const { focusedProjectId, projects } = useProjectStore.getState();
  const project =
    projects.find((p) => p.id === focusedProjectId) ?? projects[0];
  if (!project) return Promise.resolve(null);
  return createNoteInScene(project.path, visibleCanvasCenter()).then((pin) => pin.id);
}
