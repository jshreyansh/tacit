import type { Pin, UpdatePinInput } from "../types";

const DEFAULT_NOTE_TITLE = "Untitled";

/**
 * Every mutation here fires through `window.termcanvas.pins.*` and relies
 * on the existing global pin event subscription (see PinDrawer.tsx's
 * `window.termcanvas.pins.subscribe` effect, mounted unconditionally in
 * LeftPanel) to update `usePinStore` — the same convention every other
 * pin-mutating call site (PinDrawer, PinDetailDrawer) already follows.
 * `buildPinFlowNodes` (nodeProjection.ts) reads straight off that store, so
 * a created/updated/removed note reaches the canvas with no extra wiring.
 */

export function createNoteInScene(
  projectPath: string,
  position?: { x: number; y: number },
): Promise<Pin> {
  return window.termcanvas.pins.create({
    title: DEFAULT_NOTE_TITLE,
    repo: projectPath,
    body: "",
    status: "open",
    x: position?.x,
    y: position?.y,
  });
}

export function updatePinInScene(
  repo: string,
  id: string,
  patch: UpdatePinInput,
): void {
  void window.termcanvas.pins.update(repo, id, patch).catch((err) => {
    console.error("[scenePinActions] failed to update pin:", err);
  });
}

export function removePinFromScene(repo: string, id: string): void {
  void window.termcanvas.pins.remove(repo, id).catch((err) => {
    console.error("[scenePinActions] failed to remove pin:", err);
  });
}
