/**
 * A terminal's size in character cells, as its process is told it. The
 * renderer measures it from the tile; main checks it before passing it to
 * the PTY, since it comes over IPC.
 */
export interface PtySize {
  cols: number;
  rows: number;
}

/** What a terminal starts at when nothing better is known. */
export const DEFAULT_PTY_SIZE: PtySize = { cols: 80, rows: 24 };

const MAX_COLS = 2000;
const MAX_ROWS = 1000;

/** The size, if both are whole numbers a terminal could have; otherwise null. */
export function validPtySize(cols: unknown, rows: unknown): PtySize | null {
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 2 || cols > MAX_COLS || rows < 1 || rows > MAX_ROWS) return null;
  return { cols, rows };
}
