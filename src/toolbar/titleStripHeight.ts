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
 * Lives in a leaf module so helpers outside the toolbar (zoom actions,
 * fit-all math) can read it without pulling in React.
 *
 * This is the one number for the top inset. It used to be a 44 that three
 * components redeclared locally and three more hard-coded inline, which is
 * how a change here silently disagreed with itself by sixteen pixels.
 */
export const TITLE_STRIP_HEIGHT = 28;
