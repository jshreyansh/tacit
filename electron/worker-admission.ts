import {
  workerCapMessage,
  type WorkerCaps,
  type WorkerKind,
} from "../shared/worker-cap";

/**
 * The gate every manager spawn passes through (T3.4). The count and the spawn
 * happen one at a time per kind, so two requests arriving together at 7 of 8
 * can't both get the last slot. Terminals and browsers queue separately: a
 * browser spawn can wait on the person choosing a profile, and that must not
 * hold up terminals.
 */

export interface WorkerAdmissionDeps {
  caps: WorkerCaps;
  /** Open workers the managers started, per kind. */
  count: () => Promise<WorkerCaps>;
  recordRefusal: (input: { kind: WorkerKind; managerId: string; open: number; limit: number }) => void;
}

export class WorkerAdmission {
  private readonly queues: Record<WorkerKind, Promise<unknown>> = {
    terminals: Promise.resolve(),
    browsers: Promise.resolve(),
  };

  constructor(private readonly deps: WorkerAdmissionDeps) {}

  admit<T>(kind: WorkerKind, managerId: string, spawn: () => Promise<T>): Promise<T> {
    const run = this.queues[kind].then(async () => {
      const open = (await this.deps.count())[kind];
      const limit = this.deps.caps[kind];
      if (open >= limit) {
        this.deps.recordRefusal({ kind, managerId, open, limit });
        throw Object.assign(new Error(workerCapMessage(kind, open, limit)), {
          status: 409,
          code: "worker_cap_reached",
        });
      }
      return spawn();
    });
    // The next request waits for this one, success or not.
    this.queues[kind] = run.catch(() => undefined);
    return run;
  }
}
