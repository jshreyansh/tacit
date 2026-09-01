import { shouldRunAutoSaveBackstop } from "./workspaceStore";

/**
 * The autosave state machine, lifted out of App's effect so it can be driven
 * by a test with an injected clock instead of by five real seconds of waiting.
 *
 * Two independent triggers, both required:
 *  - a debounce, restarted on every fresh `markDirty`, so a burst of edits
 *    costs one write rather than one per edit;
 *  - a backstop interval, because the debounce is restartable and therefore
 *    starvable: a store that marks dirty faster than the debounce window
 *    would otherwise push the write out forever.
 */

export interface AutoSaveSchedulerState {
  dirty: boolean;
  lastDirtyAt: number | null;
  lastSavedAt: number | null;
}

export interface AutoSaveSource<S extends AutoSaveSchedulerState> {
  getState: () => S;
  subscribe: (listener: (state: S, prev: S) => void) => () => void;
}

/** Timer/clock seam. Real timers in the app; controllable ones in tests. */
export interface AutoSaveClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export const realAutoSaveClock: AutoSaveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface AutoSaveScheduler {
  /** Drop a pending debounced save without running it — used by the
   * quit flush, which saves through its own refreshing path instead. */
  cancelPendingSave: () => void;
  stop: () => void;
}

export const AUTO_SAVE_DEBOUNCE_MS = 5000;
export const AUTO_SAVE_BACKSTOP_MS = 60_000;

export function startAutoSaveScheduler<S extends AutoSaveSchedulerState>({
  source,
  save,
  debounceMs = AUTO_SAVE_DEBOUNCE_MS,
  backstopMs = AUTO_SAVE_BACKSTOP_MS,
  clock = realAutoSaveClock,
}: {
  source: AutoSaveSource<S>;
  save: () => void;
  debounceMs?: number;
  backstopMs?: number;
  clock?: AutoSaveClock;
}): AutoSaveScheduler {
  let debounceTimer: unknown = null;

  const cancelPendingSave = () => {
    if (debounceTimer !== null) {
      clock.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const unsubscribe = source.subscribe((state, prev) => {
    if (state.dirty && state.lastDirtyAt !== prev.lastDirtyAt) {
      cancelPendingSave();
      debounceTimer = clock.setTimeout(() => {
        debounceTimer = null;
        save();
      }, debounceMs);
    }

    if (!state.dirty && prev.dirty) {
      cancelPendingSave();
    }
  });

  const backstopTimer = clock.setInterval(() => {
    const { dirty, lastDirtyAt, lastSavedAt } = source.getState();
    if (
      shouldRunAutoSaveBackstop({
        dirty,
        lastDirtyAt,
        lastSavedAt,
        now: clock.now(),
        intervalMs: backstopMs,
      })
    ) {
      save();
    }
  }, backstopMs);

  return {
    cancelPendingSave,
    stop: () => {
      unsubscribe();
      cancelPendingSave();
      clock.clearInterval(backstopTimer);
    },
  };
}
