import { AssignmentManager } from "../hydra/src/assignment/manager";
import type { AssignmentStatus } from "../hydra/src/assignment/types";

/**
 * The role and status of each terminal a Hydra workbench dispatched, for the
 * label on the wire from its Lead (src/canvas/ConnectionLayer.tsx). Without
 * it, the wire to a Hydra worker looked like any other, and nothing on the
 * canvas said a review was running, stuck or done.
 *
 * Read from the assignment files Hydra already writes; only changes are sent.
 */

export interface HydraWireStatus {
  terminalId: string;
  role: string;
  status: AssignmentStatus;
  /**
   * The worker is waiting for the user: at a question in its terminal (a
   * permission, a folder to trust, an update) rather than working.
   */
  needsYou?: boolean;
}

/**
 * A worker with no agent session this long after it appeared hasn't begun
 * its work: its CLI is at a question before the first turn (trust this
 * folder, update now, sign in). Workers are started with their task, so a
 * session normally attaches within seconds.
 */
export const NOT_STARTED_AFTER_MS = 20_000;

/** Whether a working worker is waiting on the user, from its telemetry. */
export function workerNeedsYou(
  status: AssignmentStatus,
  snapshot: { pty_alive?: boolean; session_attached?: boolean; turn_state?: string } | null,
  waitingFor: number,
): boolean {
  if (status !== "pending" && status !== "claimed" && status !== "in_progress") return false;
  if (!snapshot?.pty_alive) return false;
  if (snapshot.turn_state === "awaiting_input") return true;
  return !snapshot.session_attached && waitingFor >= NOT_STARTED_AFTER_MS;
}

export function readHydraStatus(worker: {
  terminalId: string;
  workflowId: string;
  assignmentId: string;
  repoPath: string;
}): HydraWireStatus | null {
  try {
    const assignment = new AssignmentManager(worker.repoPath, worker.workflowId).load(worker.assignmentId);
    if (!assignment) return null;
    return { terminalId: worker.terminalId, role: assignment.role, status: assignment.status };
  } catch {
    // A workbench mid-write or cleaned up: nothing to show, not an error.
    return null;
  }
}

/** Remembers what was last sent, so only changes go to the window. */
export class HydraStatusFeed {
  private readonly last = new Map<string, string>();
  private readonly firstSeen = new Map<string, number>();

  /** How long a worker has been on the feed, from the first time it was seen. */
  seenFor(terminalId: string, now: number): number {
    const first = this.firstSeen.get(terminalId);
    if (first === undefined) {
      this.firstSeen.set(terminalId, now);
      return 0;
    }
    return now - first;
  }

  changes(statuses: HydraWireStatus[]): HydraWireStatus[] {
    const out: HydraWireStatus[] = [];
    const seen = new Set<string>();
    for (const status of statuses) {
      seen.add(status.terminalId);
      const key = `${status.role}:${status.status}:${status.needsYou ? "needs-you" : ""}`;
      if (this.last.get(status.terminalId) === key) continue;
      this.last.set(status.terminalId, key);
      out.push(status);
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
    for (const id of [...this.firstSeen.keys()]) if (!seen.has(id)) this.firstSeen.delete(id);
    return out;
  }
}
