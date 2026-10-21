import { CHROME_INSET } from "../stores/canvasStore";
import { TITLE_STRIP_CSS, titleStripHeight } from "../toolbar/titleStripHeight";

/**
 * Where every floating surface starts and stops vertically.
 *
 * The rails, the panels beside them, and every drawer and overlay that used to
 * abut a welded window edge. They all share these two numbers so a drawer never
 * runs flush to the top while the rail beside it is inset — which is exactly
 * how the file editor and the Hub ended up looking bolted on next to chrome
 * that floats.
 *
 * The top follows the title strip, which is 0 in full screen (see
 * titleStripHeight.ts): styles take the CSS forms, math calls `chromeTop()`.
 */
export const CHROME_TOP = `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`;
export const CHROME_BOTTOM = CHROME_INSET;
/** Height of a full-height floating surface. */
export const CHROME_HEIGHT = `calc(100vh - ${TITLE_STRIP_CSS} - ${CHROME_INSET + CHROME_BOTTOM}px)`;

/** The top of the floating surfaces now, in px, for layout math. */
export function chromeTop(): number {
  return titleStripHeight() + CHROME_INSET;
}
