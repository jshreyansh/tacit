import { CHROME_GAP, CHROME_INSET, LEFT_RAIL_WIDTH, useCanvasStore } from "./canvasStore";
import { chatDockOffset, useChatDockStore } from "./chatDockStore";
import { useHubStore } from "./hubStore";

/**
 * Where the open chrome on the left ends: the rail, the docked chat, then
 * whichever one surface the rail opened beside it (the sessions panel, the
 * code panel with Files / Diff / Git / Memory, or the Hub; opening one
 * closes the others). Everything laid out after them (the workdesk view,
 * the file editor, the session reader) starts here, and follows as any of
 * them opens, closes or is dragged wider.
 */

/** The Hub's width; it hinges on the rail like the panels. */
export const HUB_WIDTH = 340;

export function leftChromeInset(state: {
  chat: number;
  leftPanelCollapsed: boolean;
  leftPanelWidth: number;
  codePanelCollapsed: boolean;
  codePanelWidth: number;
  hubOpen: boolean;
}): number {
  const panel = !state.leftPanelCollapsed
    ? state.leftPanelWidth
    : !state.codePanelCollapsed
      ? state.codePanelWidth
      : state.hubOpen
        ? HUB_WIDTH
        : 0;
  return CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + state.chat + (panel > 0 ? panel + CHROME_GAP : 0);
}

export function useLeftChromeInset(): number {
  const chat = useChatDockStore((s) => chatDockOffset(s, CHROME_GAP));
  const leftPanelCollapsed = useCanvasStore((s) => s.leftPanelCollapsed);
  const leftPanelWidth = useCanvasStore((s) => s.leftPanelWidth);
  const codePanelCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const codePanelWidth = useCanvasStore((s) => s.rightPanelWidth);
  const hubOpen = useHubStore((s) => s.open);
  return leftChromeInset({ chat, leftPanelCollapsed, leftPanelWidth, codePanelCollapsed, codePanelWidth, hubOpen });
}
