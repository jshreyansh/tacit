import { useSyncExternalStore } from "react";

/** The time, half a minute at a time, shared by every age on screen. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 30_000);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
export const useNow = (): number => useSyncExternalStore(subscribe, () => now);
