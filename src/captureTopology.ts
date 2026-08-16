import { recordDecision } from "./capture";
import { useBrowserCardStore } from "./stores/browserCardStore";
import { useConnectionStore } from "./stores/connectionStore";
import { usePinStore } from "./stores/pinStore";
import { useProjectStore } from "./stores/projectStore";
import { endpointKey } from "./stores/connectionStore";
import type { CaptureNodeRef } from "../shared/capture";

/**
 * Periodic shape-of-the-canvas entry.
 *
 * The wire/unwire entries are a stream of changes, which means reading the
 * canvas as it stood at some past moment requires replaying all of them from
 * the beginning and trusting that none were dropped. A periodic absolute
 * snapshot makes any point in the record readable from the nearest one
 * forward, and turns a missed entry into a bounded gap rather than a
 * permanently wrong reconstruction.
 *
 * Throttled well below the wire entries on purpose — this is a checkpoint, not
 * a sample. Recording it on every change would just duplicate the stream.
 */
const MIN_TOPOLOGY_INTERVAL_MS = 10 * 60 * 1000;

let lastTopologyAt = 0;

interface TopologyShape {
  terminals: number;
  browsers: number;
  notes: number;
  wires: Array<[CaptureNodeRef, CaptureNodeRef, string]>;
}

export function readTopologyShape(): TopologyShape {
  let terminals = 0;
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (terminal.stashed) continue;
        terminals += 1;
      }
    }
  }

  // Only pins actually placed on the canvas count — buildPinFlowNodes skips
  // the rest, so counting all of them would report notes that aren't there.
  const notes = Object.values(usePinStore.getState().pinsByProject)
    .flat()
    .filter((pin) => pin.x != null && pin.y != null).length;

  const wires = Object.values(useConnectionStore.getState().connections).map(
    (connection) =>
      [
        endpointKey(connection.from),
        endpointKey(connection.to),
        connection.origin ?? "manual",
      ] as [CaptureNodeRef, CaptureNodeRef, string],
  );

  return {
    terminals,
    browsers: Object.keys(useBrowserCardStore.getState().cards).length,
    notes,
    wires,
  };
}

/**
 * Records a topology checkpoint if enough time has passed. Rides the autosave
 * heartbeat rather than owning a timer, so it can never fire while the stores
 * are mid-restore — the same reasoning snapshotHistory already relies on.
 */
export function recordTopologyCheckpoint(options: { force?: boolean } = {}): void {
  const now = Date.now();
  if (!options.force && now - lastTopologyAt < MIN_TOPOLOGY_INTERVAL_MS) return;
  const shape = readTopologyShape();
  // An empty canvas is the boot state, not a decision worth checkpointing.
  if (
    shape.terminals === 0 &&
    shape.browsers === 0 &&
    shape.notes === 0 &&
    shape.wires.length === 0
  ) {
    return;
  }
  lastTopologyAt = now;
  recordDecision({ kind: "topology", ...shape });
}

/** Test seam — resets the throttle so cases don't leak into each other. */
export function resetTopologyThrottleForTests(): void {
  lastTopologyAt = 0;
}
