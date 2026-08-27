/**
 * Decide whether a wheel gesture belongs to a terminal's scrollback or to the
 * canvas camera.
 *
 * Why this exists
 * ---------------
 * Terminal tiles sit on a pan/zoom canvas, so exactly one of two consumers can
 * have any given wheel event: the canvas (pan) or the terminal under the cursor
 * (scrollback). `XyFlowCanvas` owns the whole gesture from a capture-phase
 * listener, so whatever it does not explicitly hand off is swallowed by
 * `preventDefault()` + `stopPropagation()` before the terminal ever sees it.
 *
 * The previous rule was "only the single globally-focused tile may scroll".
 * That made scrollback unreachable for every other terminal on the canvas —
 * wheeling over them panned the camera instead, and the only way to see more
 * output was to make the card taller.
 *
 * The rule here is browser-style scroll chaining, which resolves the conflict
 * without giving either side a blanket claim:
 *
 * - Horizontal-dominant gestures always pan. A terminal has no horizontal axis,
 *   and horizontal panning across a dense canvas must not snag on tiles.
 * - The focused terminal owns the wheel outright, in both directions, even with
 *   no scrollback. It is "active" — mouse-reporting TUIs (vim, htop, fzf) need
 *   the raw events, and that is the pre-existing contract.
 * - An unfocused terminal claims a vertical gesture only while it still has
 *   buffer to travel in that direction. At the end of its scrollback the
 *   gesture chains onward to the canvas, so panning across the scene keeps
 *   working and a terminal with no scrollback at all (alt-screen TUIs) is
 *   transparent to panning.
 *
 * Kept free of DOM/xterm types so it can be unit-tested in plain node.
 */

export type WheelConsumer = "terminal" | "canvas";

/** Which directions the hovered terminal can still travel. */
export interface TerminalScrollRoom {
  canScrollUp: boolean;
  canScrollDown: boolean;
}

export interface TerminalWheelInput {
  deltaX: number;
  deltaY: number;
  /** True when the cursor is over a terminal's rendering surface. */
  overTerminal: boolean;
  /** True when that terminal is the scene's focused tile. */
  terminalFocused: boolean;
  /** Null when the terminal's scroll position is unknown (renderer not ready). */
  room: TerminalScrollRoom | null;
}

export function resolveTerminalWheelConsumer(
  input: TerminalWheelInput,
): WheelConsumer {
  if (!input.overTerminal) {
    return "canvas";
  }

  // The focused tile is active: it gets every wheel event over its surface,
  // including horizontal ones and ones it has no room for, so mouse-reporting
  // applications keep receiving the gesture.
  if (input.terminalFocused) {
    return "terminal";
  }

  // A terminal has no horizontal axis; horizontal-dominant gestures are camera
  // pans even directly over a tile.
  if (Math.abs(input.deltaX) > Math.abs(input.deltaY)) {
    return "canvas";
  }

  if (input.deltaY === 0 || !input.room) {
    return "canvas";
  }

  const wantsHistory = input.deltaY < 0;
  const hasRoom = wantsHistory ? input.room.canScrollUp : input.room.canScrollDown;
  return hasRoom ? "terminal" : "canvas";
}

/**
 * Scroll room from xterm's public buffer API.
 *
 * `viewportY` is the buffer row currently at the top of the viewport and
 * `baseY` is that row when scrolled fully to the bottom, so the distance
 * between them is exactly the unseen scrollback above.
 */
export function scrollRoomFromXtermBuffer(buffer: {
  viewportY: number;
  baseY: number;
}): TerminalScrollRoom {
  return {
    canScrollUp: buffer.viewportY > 0,
    canScrollDown: buffer.viewportY < buffer.baseY,
  };
}

/**
 * Scroll room from a plain DOM scroll container — the wterm engine renders into
 * one of these rather than into an xterm buffer.
 */
export function scrollRoomFromScrollElement(element: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): TerminalScrollRoom {
  // Fractional device-pixel rounding leaves scrollTop a hair short of the true
  // maximum on HiDPI, so treat sub-pixel remainders as "at the end".
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  return {
    canScrollUp: element.scrollTop > 1,
    canScrollDown: element.scrollTop < maxScrollTop - 1,
  };
}
