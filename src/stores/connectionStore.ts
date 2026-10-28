import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";
import {
  defaultConnectionType,
  normalizeCustomPrompt,
  type ConnectionType,
} from "../../shared/connection-types";
import {
  normalizeWirePurpose,
  type WireLimits,
} from "../../shared/node-contracts";
import type { WireRule } from "../../shared/wire-rules";
import { isWireRole, type WireRole, type WireTracking } from "../../shared/wire-tracking";

/**
 * Which wiring model a stored wire was written under. Wires without it were
 * saved before docs/architecture/wiring-model.md and are converted once on
 * load (src/canvas/wireMigration.ts).
 */
export const WIRE_MODEL_VERSION = 2;

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
  /**
   * What this wire means — see shared/connection-types.ts.
   *
   * Absent means "infer from the endpoints", which is how every wire drawn
   * before types existed keeps behaving exactly as it did: a terminal-to-browser
   * connection infers `controls`, the behaviour such a wire always had. Read it
   * through `resolveConnectionType`, never directly, so the inference is applied.
   */
  type?: ConnectionType;
  /** The sentence the user wrote. Only meaningful when `type` is "custom". */
  customPrompt?: string;
  /**
   * Whether either end may send along it. Absent means one way, from `from`
   * to `to`, except a spawn wire, which is two-way. Read it through
   * `isTwoWay` (shared/connection-types.ts) so that default is applied.
   */
  twoWay?: boolean;
  /** What the wire is for, in the user's words: shown on the wire and told
   * to the agents at its ends. */
  purpose?: string;
  /** Narrowing of what the head offers, e.g. a read-only browser. */
  limits?: WireLimits;
  /** WIRE_MODEL_VERSION when written; absent on older saves. */
  v?: number;
  /**
   * A note or task wired into an agent: "reread" makes it standing context,
   * sent when set and again whenever the note changes. Absent means Send:
   * the user passes it along with the Send button.
   */
  noteMode?: "reread";
  /** When something happens at one end, send something to the other
   * (shared/wire-rules.ts). */
  rules?: WireRule[];
  /** Hydra tracking for hand-offs along it (shared/wire-tracking.ts).
   * Absent means Auto. */
  track?: "off" | "always";
  /** A Hydra role the head plays for the tail (dev, reviewer, ...). */
  role?: WireRole;
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
  /**
   * Change what a wire means. Recorded as a new fact rather than a rewrite —
   * the record is append-only, so a wire that used to feed context and now
   * merely relates still happened both ways, in that order.
   */
  setConnectionType: (
    id: string,
    type: ConnectionType,
    customPrompt?: string,
  ) => void;
  /** Turn a one-way wire round. A type that doesn't fit the new direction is
   * dropped, so the wire falls back to what that direction means. */
  flipConnection: (id: string) => void;
  setConnectionTwoWay: (id: string, twoWay: boolean) => void;
  /** Set or clear what the wire is for. Returns whether anything changed. */
  setConnectionPurpose: (id: string, purpose: string | undefined) => boolean;
  /** Send (once, by hand) or Reread (standing context). Returns whether it changed. */
  setConnectionNoteMode: (id: string, mode: "send" | "reread") => boolean;
  setConnectionTracking: (id: string, tracking: WireTracking) => boolean;
  setConnectionRole: (id: string, role: WireRole | null) => boolean;
  /** Add a rule, or replace the one with the same id. */
  putConnectionRule: (id: string, rule: WireRule) => void;
  removeConnectionRule: (id: string, ruleId: string) => boolean;
  /** Replace the wire's limits. Returns whether anything changed. */
  setConnectionLimits: (id: string, limits: WireLimits | undefined) => boolean;
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
      v: WIRE_MODEL_VERSION,
    };
    set((state) => ({
      connections: { ...state.connections, [id]: connection },
    }));
    markDirty();
    return id;
  },

  setConnectionType: (id, type, customPrompt) => {
    const existing = get().connections[id];
    if (!existing) return;
    const prompt = type === "custom" ? normalizeCustomPrompt(customPrompt) : undefined;
    if (existing.type === type && existing.customPrompt === prompt) return;
    const next: ConnectionData = { ...existing, type };
    // Dropped rather than kept when the type moves off custom, so a stale
    // instruction cannot come back to life if the user switches back later.
    if (prompt) next.customPrompt = prompt;
    else delete next.customPrompt;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
  },

  flipConnection: (id) => {
    const existing = get().connections[id];
    if (!existing) return;
    const next: ConnectionData = { ...existing, from: existing.to, to: existing.from };
    // A plain link stays a plain link. Anything else takes what the new
    // direction means by default: a reply rule written for one direction
    // means nothing the other way round.
    if (existing.type !== "relates-to") {
      next.type = defaultConnectionType(next.from.kind, next.to.kind);
      delete next.customPrompt;
    }
    // A limit belongs to the end it narrows; turned round, that end is now
    // the tail and the limit no longer applies to anything. Reread is about
    // a note at the tail, so it goes too.
    delete next.limits;
    delete next.noteMode;
    // The role is what the head plays for the tail; turned round, it no
    // longer describes anyone.
    delete next.role;
    // A rule names its end as "from" or "to"; turned round, those swap.
    if (next.rules) {
      next.rules = next.rules.map((rule) => ({ ...rule, at: rule.at === "from" ? "to" : "from" }));
    }
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
  },

  setConnectionTwoWay: (id, twoWay) => {
    const existing = get().connections[id];
    if (!existing || existing.twoWay === twoWay) return;
    set((state) => ({ connections: { ...state.connections, [id]: { ...existing, twoWay } } }));
    markDirty();
  },

  setConnectionPurpose: (id, purpose) => {
    const existing = get().connections[id];
    if (!existing) return false;
    const normalized = normalizeWirePurpose(purpose);
    if (existing.purpose === normalized) return false;
    const next: ConnectionData = { ...existing };
    if (normalized) next.purpose = normalized;
    else delete next.purpose;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
  },

  setConnectionNoteMode: (id, mode) => {
    const existing = get().connections[id];
    if (!existing) return false;
    if ((existing.noteMode ?? "send") === mode) return false;
    const next: ConnectionData = { ...existing };
    if (mode === "reread") next.noteMode = "reread";
    else delete next.noteMode;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
  },

  setConnectionTracking: (id, tracking) => {
    const existing = get().connections[id];
    if (!existing || (existing.track ?? "auto") === tracking) return false;
    const next: ConnectionData = { ...existing };
    if (tracking === "auto") delete next.track;
    else next.track = tracking;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
  },

  setConnectionRole: (id, role) => {
    const existing = get().connections[id];
    const cleaned = isWireRole(role) ? role : undefined;
    if (!existing || existing.role === cleaned) return false;
    const next: ConnectionData = { ...existing };
    if (cleaned) next.role = cleaned;
    else delete next.role;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
  },

  putConnectionRule: (id, rule) => {
    const existing = get().connections[id];
    if (!existing) return;
    const rules = [...(existing.rules ?? []).filter((r) => r.id !== rule.id), rule];
    set((state) => ({ connections: { ...state.connections, [id]: { ...existing, rules } } }));
    markDirty();
  },

  removeConnectionRule: (id, ruleId) => {
    const existing = get().connections[id];
    if (!existing?.rules?.some((r) => r.id === ruleId)) return false;
    const next: ConnectionData = { ...existing, rules: existing.rules.filter((r) => r.id !== ruleId) };
    if (!next.rules?.length) delete next.rules;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
  },

  setConnectionLimits: (id, limits) => {
    const existing = get().connections[id];
    if (!existing) return false;
    const cleaned: WireLimits = {};
    if (limits?.browser === "read") cleaned.browser = "read";
    const before = JSON.stringify(existing.limits ?? {});
    if (before === JSON.stringify(cleaned)) return false;
    const next: ConnectionData = { ...existing };
    if (Object.keys(cleaned).length) next.limits = cleaned;
    else delete next.limits;
    set((state) => ({ connections: { ...state.connections, [id]: next } }));
    markDirty();
    return true;
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

/**
 * Drop every wire touching a node that is being closed. Wires used to
 * outlive their node: emit_event then tried to deliver along them, and the
 * record's topology kept listing them. Not recorded as unwires; the node's
 * `close` entry already says why they went.
 */
export function removeConnectionsInvolving(
  kind: ConnectionEndpointKind,
  id: string,
): void {
  const store = useConnectionStore.getState();
  for (const connection of connectionsInvolving(store.connections, kind, id)) {
    store.removeConnection(connection.id);
  }
}

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
