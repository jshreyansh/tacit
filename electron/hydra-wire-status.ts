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

  changes(statuses: HydraWireStatus[]): HydraWireStatus[] {
    const out: HydraWireStatus[] = [];
    const seen = new Set<string>();
    for (const status of statuses) {
      seen.add(status.terminalId);
      const key = `${status.role}:${status.status}`;
      if (this.last.get(status.terminalId) === key) continue;
      this.last.set(status.terminalId, key);
      out.push(status);
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
    return out;
  }
}
