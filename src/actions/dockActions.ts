import { useCanvasStore } from "../stores/canvasStore";
import { useProjectStore } from "../stores/projectStore";
import { getVisibleCanvasWorldRect } from "../canvas/viewportBounds";
import { createTerminalInScene } from "./terminalSceneActions";
import { addBrowserCardToScene } from "./sceneCardActions";
import { placeSticky } from "../board/boardActions";
import { newTask } from "../tasks/taskActions";
import type { TerminalType } from "../types";
import { openNewAgentAsSet } from "./managerChatMode";

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
export function addTerminal(
  type: TerminalType,
  where?: { projectId: string; worktreeId: string },
): string | null {
  const { focusedProjectId, focusedWorktreeId, projects } =
    useProjectStore.getState();
  let projectId = where?.projectId ?? focusedProjectId;
  let worktreeId = where?.worktreeId ?? focusedWorktreeId;
  if (!projectId || !worktreeId) {
    const fallbackProject = projects[0];
    const fallbackWorktree = fallbackProject?.worktrees[0];
    if (!fallbackProject || !fallbackWorktree) return null;
    projectId = fallbackProject.id;
    worktreeId = fallbackWorktree.id;
  }
  const id = createTerminalInScene({
    projectId,
    worktreeId,
    type,
    position: visibleCanvasCenter(),
  }).id;
  openNewAgentAsSet(id);
  return id;
}

/** Adds a browser, in the given profile or the default one; its id. */
export function addBrowser(identityId?: string): string {
  return addBrowserCardToScene(visibleCanvasCenter(), undefined, "user", identityId);
}

/** A new task, to write; it goes on the canvas only if you put it there. */
export function addTask(): null {
  newTask();
  return null;
}

/** Adds a note to the canvas, ready to type in; its id. */
export function addNote(): string {
  return placeSticky(visibleCanvasCenter());
}
