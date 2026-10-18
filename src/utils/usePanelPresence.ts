import { useEffect, useState } from "react";
import { PANEL_TRANSITION_DURATION_MS } from "./panelAnimation";

/**
 * Keeps a panel in the page through its closing animation, and lets its
 * opening one start from closed: `mounted` while it shows or is closing,
 * `revealed` once it's open. Opening mounts it closed and reveals it on the
 * next frame; closing unreveals it and unmounts when the animation is over.
 */
export function usePanelPresence(open: boolean): { mounted: boolean; revealed: boolean } {
  const [mounted, setMounted] = useState(open);
  const [revealed, setRevealed] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the closed state has to be painted for the change to animate.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setRevealed(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setRevealed(false);
    const timer = window.setTimeout(() => setMounted(false), PANEL_TRANSITION_DURATION_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open]);
  return { mounted, revealed };
}
