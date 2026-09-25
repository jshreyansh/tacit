import { CHROME_INSET } from "../stores/canvasStore";
import { TITLE_STRIP_HEIGHT } from "../toolbar/titleStripHeight";

/**
 * Where every floating surface starts and stops vertically.
 *
 * The rails, the panels beside them, and every drawer and overlay that used to
 * abut a welded window edge. They all share these two numbers so a drawer never
 * runs flush to the top while the rail beside it is inset — which is exactly
 * how the file editor and the Hub ended up looking bolted on next to chrome
 * that floats.
 */
export const CHROME_TOP = TITLE_STRIP_HEIGHT + CHROME_INSET;
export const CHROME_BOTTOM = CHROME_INSET;
/** Height of a full-height floating surface. */
export const CHROME_HEIGHT = `calc(100vh - ${CHROME_TOP + CHROME_BOTTOM}px)`;
