import type { Pin } from "../types";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { visibleCanvasCenter } from "../actions/dockActions";
import { flyToBounds } from "../utils/panToTerminal";
import { updateTask } from "./taskActions";

/** A task or note's size on the canvas when it has none of its own. */
export const PIN_DEFAULT_W = 300;
export const PIN_DEFAULT_H = 220;

/** Shows it on the canvas, putting it there first (in view) when it isn't. */
export async function showPinOnCanvas(pin: Pin): Promise<void> {
  useWorkdeskViewStore.getState().setMode("canvas");
  let placed = pin;
  if (typeof pin.x !== "number" || typeof pin.y !== "number") {
    const center = visibleCanvasCenter();
    placed = (await updateTask(pin, { x: Math.round(center.x - PIN_DEFAULT_W / 2), y: Math.round(center.y - PIN_DEFAULT_H / 2) })) ?? pin;
  }
  if (typeof placed.x === "number" && typeof placed.y === "number") flyToBounds(placed.x, placed.y, placed.w ?? PIN_DEFAULT_W, placed.h ?? PIN_DEFAULT_H);
}
