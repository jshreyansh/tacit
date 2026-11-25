import { useNotificationStore } from "../stores/notificationStore";

/** A burst of agents shows the latest few, not a column up the window. */
const MAX = 3;
let shown: Array<{ id: string; task: boolean }> = [];

export function keepToast(id: string, task: boolean): void {
  shown.push({ id, task });
  while (shown.length > MAX) useNotificationStore.getState().dismiss(shown.shift()!.id);
}

/** The board is open: what it says needs you is there, and these would be over it. */
export function clearTaskToasts(): void {
  for (const { id, task } of shown) if (task) useNotificationStore.getState().dismiss(id);
  shown = shown.filter((x) => !x.task);
}
