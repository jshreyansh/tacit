import { useCanvasStore } from "../stores/canvasStore";
import { useSessionStore } from "../stores/sessionStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { panToTerminal } from "../utils/panToTerminal";
import { terminalHoldingSession } from "./sessionResume";

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
  // On the canvas it opens in the Manager panel, beside the list of chats.
  void useSessionStore.getState().loadReplay(filePath);
  useChatDockStore.getState().showReader(null);
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
  useChatDockStore.getState().showReader(null);
}

/**
 * A live chat picked in the list beside the manager's chat. That panel is
 * the manager's alone: on the canvas the chat's tile is flown to and
 * focused; in the grid it opens as its tab.
 */
export function openListedLiveChat(terminalId: string): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.setOpenNode({ kind: "terminal", id: terminalId });
    return;
  }
  panToTerminal(terminalId);
}

/**
 * A finished session picked in the list: read, never in the manager's
 * place. A tile already holding it is flown to; in the grid it opens as a
 * tab; on the canvas, in the pane beside the manager's chat, where its
 * Continue picks it up as a chat of its own. Nothing starts by clicking.
 */
export function openListedPastSession(entry: { filePath: string; sessionId: string }): void {
  const holding = terminalHoldingSession(entry.sessionId);
  if (holding) {
    openListedLiveChat(holding);
    return;
  }
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.openSession(entry.filePath);
    return;
  }
  void useSessionStore.getState().loadReplay(entry.filePath);
  useCanvasPageStore.getState().open("session");
}

/** All the tasks: a tab in the grid, a page beside the sheet on the canvas. */
export function openAllTasks(): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") {
    view.openTasks();
    return;
  }
  useCanvasPageStore.getState().open("tasks");
}
