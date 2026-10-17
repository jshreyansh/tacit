import type { Pin } from "../../shared/pin";

/**
 * The chat's Pins view shows open pins or the rest (done and dropped),
 * each newest first. Pure, so the split is tested without a DOM.
 */
export function splitPinsByStatus(pins: readonly Pin[]): { open: Pin[]; done: Pin[] } {
  const newestFirst = [...pins].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  return {
    open: newestFirst.filter((pin) => pin.status === "open"),
    done: newestFirst.filter((pin) => pin.status !== "open"),
  };
}
