import type { PromptTargetNode } from "./node-prompt";

/**
 * Backs the close_node MCP tool: the workspace manager closing a terminal or
 * browser it no longer needs, so a spawn → work → close loop doesn't only
 * grow.
 *
 * Kept out of api-server.ts, like node-prompt.ts, so the rules can be tested
 * without a window or a renderer.
 */

export type BusyState = "busy" | "idle" | "unknown";

/** The telemetry fields the busy check reads. */
export interface BusySnapshot {
  task_status?: "running" | "idle" | "unknown";
  pty_alive: boolean;
  foreground_tool?: string;
}

/**
 * Whether a terminal is in the middle of something. An agent's comes from its
 * turn tracking. A shell has no turns, so it is busy while a command runs in
 * it. An agent Tacit can't track (Antigravity today, SHR-108) is unknown.
 */
export function busyStateOf(
  terminalType: string | null | undefined,
  snapshot: BusySnapshot | null,
): BusyState {
  if (!snapshot) return "unknown";
  // Its process has exited: nothing left to lose.
  if (!snapshot.pty_alive) return "idle";
  if (terminalType === "shell") return snapshot.foreground_tool ? "busy" : "idle";
  if (snapshot.task_status === "running") return "busy";
  if (snapshot.task_status === "idle") return "idle";
  return "unknown";
}

export interface NodeCloseDeps {
  findNode: (id: string) => Promise<PromptTargetNode | null>;
  busyState: (node: PromptTargetNode) => BusyState;
  close: (input: {
    kind: "terminal" | "browser";
    id: string;
    reason?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

export async function closeNode(
  deps: NodeCloseDeps,
  managerId: string,
  body: unknown,
): Promise<{ ok: true; kind: "terminal" | "browser"; id: string }> {
  const input = (body ?? {}) as Record<string, unknown>;
  const { kind, id, force, reason } = input;

  if (kind !== "terminal" && kind !== "browser") {
    fail(400, "invalid_kind", "kind must be \"terminal\" or \"browser\".");
  }
  if (typeof id !== "string" || id.trim() === "") {
    fail(400, "invalid_id", "id is required: the node to close (from list_nodes).");
  }
  if (force !== undefined && typeof force !== "boolean") {
    fail(400, "invalid_force", "force must be true or false.");
  }
  if (reason !== undefined && typeof reason !== "string") {
    fail(400, "invalid_reason", "reason must be text.");
  }
  if (kind === "terminal" && id === managerId) {
    fail(400, "self_target", "That id is you. The manager can't close its own terminal.");
  }

  const node = await deps.findNode(id);
  if (!node) {
    fail(404, "not_found", `No node with id "${id}" on this canvas; it may already be closed. Call list_nodes for current ids.`);
  }
  if (node.kind !== kind) {
    const actual = node.kind === "pin" ? "note" : node.kind;
    fail(400, "wrong_kind", `"${id}" is a ${actual}, not a ${kind}.`);
  }

  if (kind === "terminal" && force !== true) {
    const state = deps.busyState(node);
    if (state === "busy") {
      fail(
        409,
        "busy",
        `Terminal "${id}" is in the middle of a task, so it was not closed; closing now would lose that work. Wait for it to finish, or pass force: true.`,
      );
    }
    if (state === "unknown") {
      fail(
        409,
        "status_unknown",
        `Tacit can't tell whether terminal "${id}" is working (its agent doesn't report turns to Tacit, or it has not been given a task yet), so it was not closed. If you're sure it's done, pass force: true.`,
      );
    }
  }

  const trimmedReason = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
  const result = await deps.close({ kind, id, ...(trimmedReason ? { reason: trimmedReason } : {}) });
  if (!result.ok) {
    // Closed by someone else between the lookup and now.
    fail(404, "not_found", `"${id}" was already gone when Tacit went to close it.`);
  }
  return { ok: true, kind, id };
}
