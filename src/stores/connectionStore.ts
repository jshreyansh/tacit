import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";

// "note" endpoints use the pin's own id, which buildPinFlowNodes
// (src/canvas/nodeProjection.ts) already uses as the canvas node id, so it
// is unique canvas-wide without needing to carry the pin's repo alongside it.
export type ConnectionEndpointKind = "terminal" | "browser" | "note";

export interface ConnectionEndpoint {
  kind: ConnectionEndpointKind;
  id: string;
}

/**
 * How this connection came to exist:
 *  - "spawn"  — created automatically because one node spawned the other,
 *               i.e. what used to be drawn separately as parentTerminalId
 *               lineage by the old ClusterLinkLayer.
 *  - "manual" — drawn by the user, or by an agent's connect_nodes call.
 *
 * Both grant the same capabilities; origin only drives presentation (the
 * family-hover highlight) and intent. Saves made before this field existed
 * have no origin — everything reading it must treat missing as "manual".
 */
export type ConnectionOrigin = "spawn" | "manual";

export interface ConnectionData {
  id: string;
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  createdAt: number;
  origin?: ConnectionOrigin;
}

interface PendingConnection {
  from: ConnectionEndpoint;
  /** Live cursor position in flow coordinates, followed by the in-progress line. */
  cursor: { x: number; y: number };
}

interface ConnectionStore {
  connections: Record<string, ConnectionData>;
  pending: PendingConnection | null;
  addConnection: (
    from: ConnectionEndpoint,
    to: ConnectionEndpoint,
    origin?: ConnectionOrigin,
  ) => string | null;
  removeConnection: (id: string) => void;
  startPending: (from: ConnectionEndpoint, cursor: { x: number; y: number }) => void;
  updatePendingCursor: (cursor: { x: number; y: number }) => void;
  /**
   * Clears the pending drag and, if a valid drop target was given, returns
   * the resolved {from, to} pair for the caller to actually create (via
   * `createConnectionInScene`, so the actions layer stays the single place
   * that triggers side effects like the terminal↔browser wire-up notice).
   */
  endPending: (
    to?: ConnectionEndpoint,
  ) => { from: ConnectionEndpoint; to: ConnectionEndpoint } | null;
}

let counter = 0;

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

function sameEndpoint(a: ConnectionEndpoint, b: ConnectionEndpoint): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Connections are undirected for lookup purposes — dragging browser→terminal
 * means the same thing as terminal→browser. */
function connectsSamePair(
  connection: ConnectionData,
  a: ConnectionEndpoint,
  b: ConnectionEndpoint,
): boolean {
  return (
    (sameEndpoint(connection.from, a) && sameEndpoint(connection.to, b)) ||
    (sameEndpoint(connection.from, b) && sameEndpoint(connection.to, a))
  );
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: {},
  pending: null,

  addConnection: (from, to, origin = "manual") => {
    if (sameEndpoint(from, to)) return null;
    // Returning the existing id for a repeated pair is what makes
    // backfillLineageConnections (sceneConnectionActions.ts) idempotent —
    // it can run on every restore without ever duplicating a wire.
    const existing = Object.values(get().connections).find((c) =>
      connectsSamePair(c, from, to),
    );
    if (existing) return existing.id;

    const id = `conn-${Date.now()}-${++counter}`;
    const connection: ConnectionData = {
      id,
      from,
      to,
      createdAt: Date.now(),
      origin,
    };
    set((state) => ({
      connections: { ...state.connections, [id]: connection },
    }));
    markDirty();
    return id;
  },

  removeConnection: (id) => {
    let removed = false;
    set((state) => {
      if (!(id in state.connections)) return state;
      removed = true;
      const { [id]: _, ...rest } = state.connections;
      return { connections: rest };
    });
    if (removed) markDirty();
  },

  startPending: (from, cursor) => {
    set({ pending: { from, cursor } });
  },

  updatePendingCursor: (cursor) => {
    set((state) =>
      state.pending ? { pending: { ...state.pending, cursor } } : state,
    );
  },

  endPending: (to) => {
    const pending = get().pending;
    set({ pending: null });
    if (pending && to) {
      return { from: pending.from, to };
    }
    return null;
  },
}));

/** All connections touching a given endpoint, in either direction. */
export function connectionsInvolving(
  connections: Record<string, ConnectionData>,
  kind: ConnectionEndpointKind,
  id: string,
): ConnectionData[] {
  return Object.values(connections).filter(
    (c) =>
      (c.from.kind === kind && c.from.id === id) ||
      (c.to.kind === kind && c.to.id === id),
  );
}

export function endpointKey(endpoint: ConnectionEndpoint): string {
  return `${endpoint.kind}:${endpoint.id}`;
}

/**
 * What the canvas highlights when you hover a node, split by how each thing
 * got attached. Endpoint keys (`kind:id`), not bare ids, since ids are only
 * unique within a kind.
 */
export interface HoverFamily {
  /**
   * The hovered node plus everything reachable from it through spawn-origin
   * connections in either direction — the whole lineage: ancestors,
   * descendants and siblings. Always contains at least the hovered node.
   */
  spawnKeys: Set<string>;
  /**
   * Nodes hanging off that lineage by a hand-drawn wire. Exactly one hop, on
   * purpose — see the reasoning below.
   */
  attachedKeys: Set<string>;
}

/**
 * Hovering a node answers "what is this working with?", and the two kinds of
 * connection answer it differently, so they're traversed differently:
 *
 *  - Spawn wires are walked **transitively**. Lineage is a tree that was built
 *    as one unit of work, so hovering any member should reveal all of it.
 *  - Manual wires are walked **one hop and no further**. They're ad-hoc
 *    attachments, not structure, so chaining through them would let a single
 *    hand-drawn wire cascade the highlight across unrelated halves of the
 *    canvas (browser → other agent → its browser → …). One hop answers the
 *    question; two hops answers a different one nobody asked.
 *
 * Hovering a node with no spawn edges at all (a browser, a note) still works:
 * `spawnKeys` is just itself, and whatever it's wired to lands in
 * `attachedKeys`. That's what makes the highlight reciprocal — you get the
 * same wire lit from either end.
 */
export function getHoverFamily(
  connections: Record<string, ConnectionData>,
  startKey: string | null,
): HoverFamily {
  if (!startKey) {
    return { spawnKeys: new Set(), attachedKeys: new Set() };
  }

  const spawnAdjacency = new Map<string, string[]>();
  const manualAdjacency = new Map<string, string[]>();
  for (const connection of Object.values(connections)) {
    const a = endpointKey(connection.from);
    const b = endpointKey(connection.to);
    // Saves predating `origin` have none — treated as manual, per the note
    // on ConnectionOrigin.
    const adjacency =
      connection.origin === "spawn" ? spawnAdjacency : manualAdjacency;
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }

  const spawnKeys = new Set<string>([startKey]);
  const queue = [startKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbour of spawnAdjacency.get(current) ?? []) {
      if (spawnKeys.has(neighbour)) continue;
      spawnKeys.add(neighbour);
      queue.push(neighbour);
    }
  }

  const attachedKeys = new Set<string>();
  for (const key of spawnKeys) {
    for (const neighbour of manualAdjacency.get(key) ?? []) {
      // A manual wire between two members of the same lineage is already
      // covered by the lineage highlight; don't also mark it attached.
      if (spawnKeys.has(neighbour)) continue;
      attachedKeys.add(neighbour);
    }
  }

  return { spawnKeys, attachedKeys };
}
