import { panToTerminal } from "../utils/panToTerminal";

/**
 * A chat continued from history lives in its tile on the canvas: going to it
 * flies there and puts the cursor in its message box. The tile may not be
 * mounted yet (just created, or its body still loading), so the request
 * waits until it is.
 */

export const FOCUS_CHAT_TILE_EVENT = "tacit:focus-chat-tile";

let pending: string | null = null;

export function flyToChatTile(terminalId: string): void {
  panToTerminal(terminalId);
  pending = terminalId;
  window.dispatchEvent(new CustomEvent<string>(FOCUS_CHAT_TILE_EVENT, { detail: terminalId }));
}

/** True once for the tile a fly-in was asked for; the tile then focuses its box. */
export function takeChatTileFocus(terminalId: string): boolean {
  if (pending !== terminalId) return false;
  pending = null;
  return true;
}
