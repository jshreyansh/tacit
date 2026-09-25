import { useProjectStore } from "../stores/projectStore";
import { useCanvasStore } from "../stores/canvasStore";
import { zoomToFitAllTerminals } from "./zoomActions";
import { useViewportFocusStore } from "../stores/viewportFocusStore";
import { getTerminalFocusOrder } from "../stores/projectFocus";
import { activateTerminalInScene } from "../actions/sceneSelectionActions";
import { panToTerminal } from "../utils/panToTerminal";
import {
} from "./viewportBounds";

function getAllTerminals() {
  const { projects } = useProjectStore.getState();
  return getTerminalFocusOrder(projects);
}

function getFocusedTerminalIndex(
  list: ReturnType<typeof getAllTerminals>,
) {
  const { projects } = useProjectStore.getState();
  for (const p of projects) {
    for (const w of p.worktrees) {
      for (const t of w.terminals) {
        if (t.focused) {
          return list.findIndex((item) => item.terminalId === t.id);
        }
      }
    }
  }
  return -1;
}


export function toggleClearFocus(): void {
  const list = getAllTerminals();
  const focusedIdx = getFocusedTerminalIndex(list);
  const store = useViewportFocusStore.getState();

  if (focusedIdx !== -1) {
    const focused = list[focusedIdx];
    store.setLastFocusedTerminalId(focused.terminalId);
    if (store.zoomedOutTerminalId === focused.terminalId) {
      panToTerminal(focused.terminalId);
      store.setZoomedOutTerminalId(null);
    } else {
      zoomToFitAllTerminals();
      store.setZoomedOutTerminalId(focused.terminalId);
    }
  } else if (store.lastFocusedTerminalId) {
    const restored = list.find(
      (item) => item.terminalId === store.lastFocusedTerminalId,
    );
    if (restored) {
      activateTerminalInScene(
        restored.projectId,
        restored.worktreeId,
        restored.terminalId,
      );
      panToTerminal(restored.terminalId);
      store.setZoomedOutTerminalId(null);
    } else {
      store.setLastFocusedTerminalId(null);
      store.setZoomedOutTerminalId(null);
    }
  } else if (list.length > 0) {
    const first = list[0];
    store.setLastFocusedTerminalId(first.terminalId);
    activateTerminalInScene(
      first.projectId,
      first.worktreeId,
      first.terminalId,
    );
    panToTerminal(first.terminalId);
    store.setZoomedOutTerminalId(null);
  }
}
