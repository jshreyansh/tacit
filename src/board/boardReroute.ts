/** An agent's arrows go round its boxes; when one is moved or grows, they're taken round again. */
import { useBoardStore } from "../stores/boardStore";
import { waysAgain } from "./agentDraw";

/** Part of the step that moved things: call it before that step ends. */
export function rerouteBroken(): void {
  const { elements, patch } = useBoardStore.getState();
  if (!elements.some((e) => e.type === "arrow" && e.via)) return;
  const patches = waysAgain(elements);
  if (Object.keys(patches).length) patch(patches);
}
