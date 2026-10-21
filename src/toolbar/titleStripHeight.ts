/**
 * Height of the window's title strip — the drag region at the top of the
 * window, and on macOS the space the traffic lights sit in.
 *
 * It is 28px because it cannot be zero, not because anything is drawn in it.
 * macOS runs this window as `titleBarStyle: "hiddenInset"` with the lights
 * positioned at (14, 14) over the web content, and the strip carries the only
 * `WebkitAppRegion: "drag"` in the app — without it the window cannot be moved
 * and the lights land on the canvas. Windows declares the same number as
 * `titleBarOverlay.height` for its own min/max/close.
 *
 * Except in full screen. There the OS hides the lights and draws its own
 * title bar over the app only while the pointer is at the top edge, and a
 * full-screen window can't be dragged; the strip is empty space, so it
 * collapses to 0 and everything starts at the top inset like every other
 * edge. Main says when the window enters or leaves full screen.
 *
 * Read it two ways, both live:
 * - In styles, `var(--title-strip)` (`TITLE_STRIP_CSS`): a change reaches
 *   every surface without a render.
 * - In layout math (canvas fit, pan, clamps), `titleStripHeight()` at the time
 *   of the calculation, never a copy taken at import.
 *
 * Lives in a leaf module so helpers outside the toolbar (zoom actions,
 * fit-all math) can read it without pulling in React.
 */
export const TITLE_STRIP_HEIGHT = 28;

export const TITLE_STRIP_CSS = "var(--title-strip, 28px)";

let fullScreen = false;

/** The strip's height now: 28, or 0 while the window is full screen. */
export function titleStripHeight(): number {
  return fullScreen ? 0 : TITLE_STRIP_HEIGHT;
}

/** Called when the window enters or leaves full screen; sets the CSS variable. */
export function setWindowFullScreen(value: boolean): void {
  fullScreen = value;
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--title-strip", `${titleStripHeight()}px`);
  }
}
