import type { CaptureEvent, CaptureNodeRef } from "../shared/capture";
import type { ConnectionEndpoint } from "./stores/connectionStore";

/**
 * Renderer side of the decision record (shared/capture.ts explains what it is
 * for). Every call here is fire-and-forget by design: these fire from inside
 * click handlers and store actions, so capture must not be able to slow, block
 * or break the interaction it is observing.
 *
 * The try/catch is not defensive padding — `window.tacit` is absent in the
 * jsdom-free unit tests that exercise the action modules, and a throw here
 * would turn "recording failed" into "wiring two nodes failed".
 */
export function recordDecision(event: CaptureEvent): void {
  try {
    window.tacit?.capture?.record?.(event);
  } catch {
    // Losing an entry is acceptable; breaking the user's action is not.
  }
}

/** Tells main which canvas to attribute hook-driven entries to. */
export function setCaptureCanvas(canvasId: string | null): void {
  try {
    window.tacit?.capture?.setCanvas?.(canvasId);
  } catch {
    // Same reasoning as recordDecision.
  }
}

/** Same `kind:id` shape as endpointKey, for endpoints that arrive as objects. */
export function captureRef(endpoint: ConnectionEndpoint): CaptureNodeRef {
  return `${endpoint.kind}:${endpoint.id}`;
}
