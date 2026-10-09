/**
 * How many workers a workspace manager may have open at once (T3.4).
 *
 * Only what a manager starts counts (spawn_terminal / spawn_browser), and only
 * while it is open: terminals and browsers you open yourself are never counted
 * or blocked, and closing a worker frees its slot at once. Counting only open
 * nodes avoids the most-reported Codex bug, where finished agents kept holding
 * slots until a restart (openai/codex#39694, #22779).
 *
 * Sized from the machine's memory, because a Tacit worker is a whole agent
 * process with its own terminal and tool server, not an in-process model call
 * as in Codex (6), OpenClaw (8), Hermes (3) or Claude Code (10). Roughly
 * 0.3-0.6 GB per agent terminal, 0.15-0.3 GB per browser tile. Tuned after
 * the week of use (SHR-110 adds a Settings override).
 *
 * At the cap a spawn is refused with a reason the manager can act on (close a
 * worker first), as Codex and Hermes do, rather than queued: every worker is
 * a tile on the canvas, and ones appearing later on their own are confusing.
 */

export interface WorkerCaps {
  terminals: number;
  browsers: number;
}

const GB = 1024 ** 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function workerCapsFor(totalMemoryBytes: number): WorkerCaps {
  const gb = totalMemoryBytes / GB;
  return {
    terminals: clamp(Math.floor(gb / 2), 4, 12),
    browsers: clamp(Math.floor(gb * 0.75), 6, 16),
  };
}

export type WorkerKind = keyof WorkerCaps;

/** The manager's message at the cap: what happened, and how to go on. */
export function workerCapMessage(kind: WorkerKind, open: number, limit: number): string {
  const noun = kind === "terminals" ? "terminal" : "browser";
  // "Started by agents", not "you started": the count includes workers an
  // earlier manager or another agent left open, and a manager told "yours"
  // concluded the limit was per manager (9 Oct).
  return `Not opened: ${open} ${noun} worker${open === 1 ? "" : "s"} started by agents ${open === 1 ? "is" : "are"} already open (yours, and any an earlier manager or another agent left), and the limit on this machine is ${limit}. list_nodes shows each node's startedBy. Close one that's finished (close_node) and try again, or carry on with the ones you have. Terminals and browsers the user opened don't count.`;
}

/**
 * Who started a terminal, as list_nodes and get_node_state report it: "user",
 * or the agent that did as a node ref ("agent" when that isn't known). The
 * cap counts exactly the ones not started by the user, so a manager can tell
 * which nodes take a worker slot. Browsers carry this as spawnedBy already.
 */
export function terminalStartedBy(terminal: { origin?: "user" | "agent"; parentTerminalId?: string }): string {
  if (terminal.origin !== "agent") return "user";
  return terminal.parentTerminalId ? `terminal:${terminal.parentTerminalId}` : "agent";
}
