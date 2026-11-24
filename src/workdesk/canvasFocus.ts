import { isCanvasTerminal } from "../components/sessionPanelModel";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { noteById } from "../board/noteStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore, type SelectedItem } from "../stores/selectionStore";
import type { OpenNode } from "../stores/workdeskViewStore";
import type { ProjectData } from "../types";

export interface CanvasFocusInput {
  projects: readonly ProjectData[];
  selectedItems: readonly SelectedItem[];
  hasBrowser: (id: string) => boolean;
  hasTask: (id: string) => boolean;
  hasNote: (id: string) => boolean;
}

/** A node the grid has a tab for, or a task, whose page is on the board. */
export type CanvasFocus = OpenNode | { kind: "task"; id: string };

const BROWSER_CARD_PREFIX = "browser:";

/**
 * The node you're on in the canvas, for the grid to open as its tab. A
 * terminal is focused, and the rest are selected: the focused terminal
 * comes first (clicking a browser, task or note takes its focus away, as
 * clicking empty canvas takes both), else the one browser, task or note
 * selected. Null with nothing chosen, or several boxed at once, or one the
 * grid has no tab for (a minimized or stashed terminal).
 */
export function resolveCanvasFocusedNode(input: CanvasFocusInput): CanvasFocus | null {
  for (const project of input.projects) {
    for (const worktree of project.worktrees) {
      const focused = worktree.terminals.find((t) => t.focused);
      if (focused) return isCanvasTerminal(focused) ? { kind: "terminal", id: focused.id } : null;
    }
  }
  if (input.selectedItems.length !== 1) return null;
  const [item] = input.selectedItems;
  if (item.type === "card" && item.cardId.startsWith(BROWSER_CARD_PREFIX)) {
    const id = item.cardId.slice(BROWSER_CARD_PREFIX.length);
    return input.hasBrowser(id) ? { kind: "browser", id } : null;
  }
  if (item.type === "task") return input.hasTask(item.taskId) ? { kind: "task", id: item.taskId } : null;
  if (item.type === "annotation") return input.hasNote(item.annotationId) ? { kind: "note", id: item.annotationId } : null;
  return null;
}

export function canvasFocusedNode(): CanvasFocus | null {
  return resolveCanvasFocusedNode({
    projects: useProjectStore.getState().projects,
    selectedItems: useSelectionStore.getState().selectedItems,
    hasBrowser: (id) => id in useBrowserCardStore.getState().cards,
    hasTask: (id) => id in useRecordPlaceStore.getState().places,
    hasNote: (id) => noteById(id) !== null,
  });
}
