import { activateCardInScene, activatePinInScene, clearSceneFocusAndSelection } from "../actions/sceneSelectionActions";
import { openFileInView, openPastSession } from "../actions/openSession";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { usePinStore } from "../stores/pinStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useSessionStore } from "../stores/sessionStore";
import { showPinOnCanvas } from "../tasks/showPinOnCanvas";
import { flyToBounds, panToTerminal } from "../utils/panToTerminal";
import { canvasFocusedNode } from "./canvasFocus";

/**
 * Switching between the canvas and the grid keeps you on the same node:
 * the node you're on in the canvas opens as the grid's tab, and the tab
 * open in the grid is the node you're on back in the canvas. With nothing
 * chosen in the canvas the grid opens on the overview; from the overview
 * the canvas opens with nothing chosen.
 */

/** The grid, on the node you're on in the canvas; with none, the overview. */
export function showGridOnFocusedNode(): void {
  // What's open in the pane comes along as the grid's tab: All tasks, a
  // finished chat, or a file.
  const page = useCanvasPageStore.getState();
  const view = useWorkdeskViewStore.getState();
  if (page.page === "tasks") {
    page.close();
    view.setMode("grid");
    view.openTasks();
    return;
  }
  if (page.page === "tool" && page.toolId) {
    const toolId = page.toolId;
    page.close();
    view.setMode("grid");
    view.openTool(toolId);
    return;
  }
  const sessionFile = page.page === "session" ? useSessionStore.getState().replayTimeline?.filePath : undefined;
  if (sessionFile) {
    page.close();
    view.setMode("grid");
    view.openSession(sessionFile);
    return;
  }
  const filePath = useCanvasStore.getState().fileEditorPath;
  if (filePath) {
    useCanvasStore.getState().closeFileEditor();
    view.setMode("grid");
    view.openFile(filePath);
    return;
  }
  useWorkdeskViewStore.getState().showGrid(canvasFocusedNode());
}

/** The canvas, on the node open in the grid's tab: focused, or selected, and in view. */
export async function showOpenNodeOnCanvas(): Promise<void> {
  const view = useWorkdeskViewStore.getState();
  const node = view.openNode;
  if (!node) {
    view.setMode("canvas");
    clearSceneFocusAndSelection();
    return;
  }
  switch (node.kind) {
    // A past session or a file: the canvas, with it in the reader or the editor.
    case "session":
      view.setMode("canvas");
      openPastSession(node.id);
      return;
    case "file":
      view.setMode("canvas");
      openFileInView(node.id);
      return;
    // A folder's changes, history or memory: the pane.
    case "tool":
      view.setMode("canvas");
      useCanvasPageStore.getState().openTool(node.id);
      return;
    // All the tasks: their page beside the sheet.
    case "tasks":
      view.setMode("canvas");
      useCanvasPageStore.getState().open("tasks");
      return;
    case "terminal":
      view.setMode("canvas");
      // Focuses and selects it too.
      panToTerminal(node.id);
      return;
    case "browser": {
      view.setMode("canvas");
      activateCardInScene(`browser:${node.id}`);
      const data = useBrowserCardStore.getState().cards[node.id];
      if (data) flyToBounds(data.x, data.y, data.w, data.h);
      return;
    }
    case "task":
    case "note": {
      const pin = Object.values(usePinStore.getState().pinsByProject).flat().find((p) => p.id === node.id);
      if (!pin) {
        view.setMode("canvas");
        clearSceneFocusAndSelection();
        return;
      }
      // One not on the canvas yet is put there.
      await showPinOnCanvas(pin);
      activatePinInScene(pin.id);
    }
  }
}

/** The view button, its shortcut and the command palette. */
export function toggleWorkdeskMode(): void {
  if (useWorkdeskViewStore.getState().mode === "grid") void showOpenNodeOnCanvas();
  else showGridOnFocusedNode();
}
