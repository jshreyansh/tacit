import type { PtySize } from "../../shared/pty-size";

/**
 * When a terminal's process is told its new size (SHR-96).
 *
 * Each resize makes a full-screen agent clear and repaint everything, so a
 * drag that resized the process every frame made Claude flash blank. Here
 * the first change after a quiet spell goes out at once (a maximise or a
 * layout snap is one change and isn't delayed), and while changes keep
 * coming only the last one is sent, once they've stopped for `settleMs`.
 * The tile itself still follows the drag every frame; only the process
 * waits.
 */

export const PTY_RESIZE_SETTLE_MS = 120;

export interface PtyResizerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface PtyResizer {
  /** Asks for the process to be this size. */
  request(size: PtySize): void;
  /** The size the process was last told, or started at. */
  readonly current: PtySize | null;
  /** Drops a waiting resize; nothing more is sent. */
  dispose(): void;
}

const same = (a: PtySize | null, b: PtySize | null) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

export function createPtyResizer(
  send: (size: PtySize) => void,
  options: { initial?: PtySize | null; settleMs?: number; timers?: PtyResizerTimers } = {},
): PtyResizer {
  const settleMs = options.settleMs ?? PTY_RESIZE_SETTLE_MS;
  const timers: PtyResizerTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let current: PtySize | null = options.initial ?? null;
  let waiting: PtySize | null = null;
  let timer: unknown = null;
  let disposed = false;

  const deliver = (size: PtySize) => {
    if (same(size, current)) return;
    current = size;
    send(size);
  };

  const settle = () => {
    timer = null;
    const last = waiting;
    waiting = null;
    if (last && !disposed) deliver(last);
  };

  return {
    request(size) {
      if (disposed) return;
      if (timer === null) {
        // A quiet spell: this change goes now, and opens a burst.
        deliver(size);
      } else {
        waiting = size;
        timers.clearTimeout(timer);
      }
      timer = timers.setTimeout(settle, settleMs);
    },
    get current() {
      return current;
    },
    dispose() {
      disposed = true;
      waiting = null;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
