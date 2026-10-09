import type { CaptureEvent } from "../shared/capture";
import type { NodeEventKind } from "./node-events";

/**
 * What the decision record needs to know about each terminal at the moment
 * it writes an entry: which agent it runs, and whether an agent started it.
 *
 * Main writes every entry (electron/capture-service.ts) but the renderer owns
 * the terminals, so this is filled from what main already sees: the type and
 * origin a terminal is created with, and the agent detected in it later.
 */

const WORKER_STATES = new Set<NodeEventKind>(["turn_completed", "waiting_for_human", "errored"]);

export class RecordNodes {
  private readonly harness = new Map<string, string>();
  private readonly agentStarted = new Set<string>();

  /** At creation; `origin` is "agent" for a terminal an agent spawned. */
  created(terminalId: string, terminalType: string | undefined, origin: string | undefined): void {
    if (terminalType) this.harness.set(terminalId, terminalType);
    if (origin === "agent") this.agentStarted.add(terminalId);
    else this.agentStarted.delete(terminalId);
  }

  /**
   * An agent was detected in the terminal after it opened (a shell where
   * `claude` was typed). Later entries name it; earlier ones keep what was
   * true when they were written.
   */
  detected(terminalId: string, provider: string | undefined): void {
    if (provider && provider !== "unknown") this.harness.set(terminalId, provider);
  }

  /** The agent a node ref runs, or null for a browser, a note, or unknown. */
  harnessOf(ref: string): string | null {
    return ref.startsWith("terminal:") ? this.harness.get(ref.slice("terminal:".length)) ?? null : null;
  }

  /**
   * Record entries for a worker's state changes: only for workers an agent
   * started, since those are the ones a manager acts on.
   */
  workerStateEntries(
    terminalId: string,
    events: ReadonlyArray<{ kind: NodeEventKind; detail?: string }>,
  ): CaptureEvent[] {
    if (!this.agentStarted.has(terminalId)) return [];
    return events
      .filter((event) => WORKER_STATES.has(event.kind))
      .map((event) => ({
        kind: "worker_state" as const,
        node: `terminal:${terminalId}`,
        state: event.kind as "turn_completed" | "waiting_for_human" | "errored",
        ...(event.detail ? { detail: event.detail } : {}),
      }));
  }
}
