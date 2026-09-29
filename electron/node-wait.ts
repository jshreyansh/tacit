import type { NodeEvent, NodeEventKind, NodeEventLog } from "./node-events";
import type { PromptTargetNode } from "./node-prompt";

/**
 * Backs the wait_for_nodes MCP tool (T3.3): the manager is told when a
 * worker changes state instead of spending a model turn checking. Reads the
 * node event log (node-events.ts), so a change between two waits is still
 * reported: the manager passes back the cursor it was given.
 */

/** Longest a single wait holds; the manager calls again with its cursor. */
export const MAX_WAIT_SECONDS = 30;

/** What a manager usually waits for: a worker done, stuck, or gone. */
export const DEFAULT_WAIT_KINDS: readonly NodeEventKind[] = [
  "turn_completed",
  "waiting_for_human",
  "errored",
  "closed",
];

const ALL_KINDS: readonly NodeEventKind[] = [
  "spawned",
  "turn_started",
  "turn_completed",
  "waiting_for_human",
  "errored",
  "closed",
  "subagent_started",
  "subagent_finished",
];

/** Kinds that only exist for an agent whose turns Tacit tracks. */
const TURN_KINDS: ReadonlySet<NodeEventKind> = new Set([
  "turn_started",
  "turn_completed",
  "waiting_for_human",
  "errored",
]);

/**
 * Agents whose turns reach Tacit (hooks or session files). Antigravity and
 * Gemini don't yet (SHR-108), and a shell has no turns.
 */
const TURN_TRACKED: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "kimi", "wuu"]);

export interface NodeWaitDeps {
  findNode: (id: string) => Promise<PromptTargetNode | null>;
  log: NodeEventLog;
}

export interface NodeWaitResult {
  events: Array<Pick<NodeEvent, "node" | "kind" | "at" | "detail">>;
  cursor: string;
  timed_out: boolean;
  /** Some events were missed: the cursor was too old or from before a restart. */
  expired: boolean;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

export async function waitForNodes(deps: NodeWaitDeps, body: unknown): Promise<NodeWaitResult> {
  const input = (body ?? {}) as Record<string, unknown>;
  const { nodes, events, timeout_s } = input;
  // "From now" means when the call arrived, taken before the node checks
  // below await anything: a worker finishing during them must still count.
  const after = input.after ?? deps.log.cursor();

  if (nodes !== undefined && (!Array.isArray(nodes) || nodes.some((n) => typeof n !== "string" || !n))) {
    fail(400, "invalid_nodes", "nodes must be a list of node ids (from list_nodes).");
  }
  if (Array.isArray(nodes) && nodes.length === 0) {
    fail(400, "invalid_nodes", "nodes is empty; leave it out to wait on every node.");
  }
  if (events !== undefined && (!Array.isArray(events) || events.some((e) => !ALL_KINDS.includes(e as NodeEventKind)))) {
    fail(400, "invalid_events", `events must be a list of: ${ALL_KINDS.join(", ")}.`);
  }
  if (after !== undefined && typeof after !== "string") {
    fail(400, "invalid_after", "after must be the cursor a previous wait_for_nodes returned.");
  }
  if (timeout_s !== undefined && (typeof timeout_s !== "number" || !Number.isFinite(timeout_s) || timeout_s < 0)) {
    fail(400, "invalid_timeout", `timeout_s must be a number of seconds, at most ${MAX_WAIT_SECONDS}.`);
  }

  const kinds = new Set((events as NodeEventKind[] | undefined) ?? DEFAULT_WAIT_KINDS);
  const ids = (nodes as string[] | undefined) ?? null;

  // Every named node must exist, and must be able to produce what is being
  // waited for; otherwise the wait could only ever time out.
  if (ids) {
    const wantsTurns = [...kinds].some((kind) => TURN_KINDS.has(kind));
    for (const id of ids) {
      const node = await deps.findNode(id);
      if (!node) fail(404, "not_found", `No node with id "${id}" on this canvas. Call list_nodes for current ids.`);
      if (node.kind === "pin") fail(400, "not_a_worker", `"${id}" is a note; notes don't change state.`);
      const onlyTurnKinds = [...kinds].every((kind) => TURN_KINDS.has(kind));
      const trackable = node.kind === "terminal" && TURN_TRACKED.has(node.terminalType ?? "");
      if (wantsTurns && onlyTurnKinds && !trackable) {
        const what = node.kind === "browser" ? "a browser" : `a ${node.terminalType ?? "terminal"} terminal`;
        fail(
          400,
          "unsupported_harness",
          `"${id}" is ${what}, and Tacit can't see its turns, so waiting for them would only time out. Wait for "closed" instead, check it with get_node_state, or have it tell you with emit_event when it's done.`,
        );
      }
    }
  }

  const refs = ids ? new Set(ids.flatMap((id) => [`terminal:${id}`, `browser:${id}`])) : null;
  const page = await deps.log.wait({
    after: after as string | undefined,
    match: (event) => kinds.has(event.kind) && (!refs || refs.has(event.node)),
    timeoutMs: Math.min(typeof timeout_s === "number" ? timeout_s : MAX_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000,
  });
  return {
    events: page.events.map(({ node, kind, at, detail }) => ({ node, kind, at, ...(detail ? { detail } : {}) })),
    cursor: page.cursor,
    timed_out: page.timed_out,
    expired: page.expired,
  };
}
