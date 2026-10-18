import { useCanvasStore } from "../stores/canvasStore";
import { useSessionStore } from "../stores/sessionStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";

/**
 * Opening a session from history, search or the session list. In the
 * workdesk view's grid it opens as a tab of its own, so several can be
 * read and continued side by side; on the canvas, in the reader beside the
 * docked chat.
 */
export function openPastSession(filePath: string): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.openSession(filePath);
    return;
  }
  useCanvasStore.getState().openSessionsOverlay();
  void useSessionStore.getState().loadReplay(filePath);
}

/** A file from Files, Memory or search: a tab in the grid, the editor drawer on the canvas. */
export function openFileInView(filePath: string): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.openFile(filePath);
    return;
  }
  useCanvasStore.getState().openFileEditor(filePath);
}

/** A session continued in chat: its terminal's tab in the grid, the reader on the canvas. */
export function openLiveChatSession(terminalId: string): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.setOpenNode({ kind: "terminal", id: terminalId });
    return;
  }
  useSessionStore.getState().openLiveChat(terminalId);
  useCanvasStore.getState().openSessionsOverlay();
}
