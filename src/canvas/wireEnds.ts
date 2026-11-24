import {
  wireDirectionFrom,
  type ConnectionEndpointKind,
} from "../../shared/connection-types";
import {
  abilitiesOver,
  carriesMessages,
  isPlainLink,
  nodeRoleOf,
  payloadsOver,
  type Ability,
  type NodeRole,
  type PayloadKind,
  type WireLimits,
} from "../../shared/node-contracts";
import {
  connectionsInvolving,
  useConnectionStore,
  type ConnectionData,
  type ConnectionEndpoint,
} from "../stores/connectionStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { agentNames, agentsIn } from "../tasks/agentNames";
import { useProjectStore } from "../stores/projectStore";
import { getTerminalDisplayTitle } from "../stores/terminalState";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { noteEnd, noteEndTitle } from "./noteEnds";

/**
 * What a node is wired to, seen from that node: the other end of each wire,
 * which way the wire runs, and what this node may do there. Backs
 * send_to_connected, emit_event, list_nodes and browser control, so all of
 * them agree on what a wire allows.
 */
export interface WireEndView {
  kind: ConnectionEndpointKind;
  id: string;
  /** The wire this end is reached over. */
  wireId: string;
  title: string | null;
  role: NodeRole;
  direction: "to_it" | "from_it" | "both_ways";
  /** True for a plain link, which carries nothing either way. */
  plain: boolean;
  /** What the node asking may do to this end (shared/node-contracts.ts). */
  can: Ability[];
  /** What the node asking may send to this end. */
  sends: PayloadKind[];
  /** Whether send_to_connected reaches it. */
  carries: boolean;
  purpose?: string;
  limits?: WireLimits;
  /** Hydra tracking for hand-offs along the wire (shared/wire-tracking.ts). */
  track: "off" | "auto" | "always";
  /** The Hydra role this end plays for the node asking, when the wire gives one. */
  hydraRole?: string;
  createdAt: number;
  ptyId?: number | null;
  terminalType?: string | null;
  worktreePath?: string | null;
}

export function nodeTitle(kind: ConnectionEndpointKind, id: string): string | null {
  if (kind === "terminal") {
    const found = findTerminal(id);
    // Agents as their tiles name them: two of a kind are told apart.
    return found ? (agentNames(agentsIn(useProjectStore.getState().projects)).get(id) ?? getTerminalDisplayTitle(found.terminal)) : null;
  }
  if (kind === "browser") {
    const card = useBrowserCardStore.getState().cards[id];
    return card ? card.title || card.url || null : null;
  }
  return noteEndTitle(id);
}

/** Whether a node is on the open canvas: a wire can't be drawn to one that isn't. */
export function isOnCanvas(endpoint: ConnectionEndpoint): boolean {
  if (endpoint.kind === "terminal") return findTerminal(endpoint.id) !== null;
  if (endpoint.kind === "browser") return endpoint.id in useBrowserCardStore.getState().cards;
  return noteEnd(endpoint.id) !== null;
}

/** What a node on the canvas is, as far as wires care. */
export function endpointRole(endpoint: ConnectionEndpoint): NodeRole {
  if (endpoint.kind === "terminal") {
    return nodeRoleOf("terminal", { terminalType: findTerminal(endpoint.id)?.terminal.type ?? null });
  }
  return nodeRoleOf(endpoint.kind, { noteRole: endpoint.kind === "note" ? noteEnd(endpoint.id)?.role : null });
}

/** What `self` may do to the other end of one wire. */
export function abilitiesFor(connection: ConnectionData, self: ConnectionEndpoint): Ability[] {
  const other =
    connection.from.kind === self.kind && connection.from.id === self.id ? connection.to : connection.from;
  return abilitiesOver(connection, self, endpointRole(self), endpointRole(other));
}

export function wireEndsOf(kind: ConnectionEndpointKind, id: string): WireEndView[] {
  const self = { kind, id };
  const selfRole = endpointRole(self);
  const ends: WireEndView[] = [];
  for (const connection of connectionsInvolving(useConnectionStore.getState().connections, kind, id)) {
    const direction = wireDirectionFrom(connection, self);
    if (!direction) continue;
    const other =
      connection.from.kind === kind && connection.from.id === id ? connection.to : connection.from;
    const role = endpointRole(other);
    const can = abilitiesOver(connection, self, selfRole, role);
    const end: WireEndView = {
      kind: other.kind,
      id: other.id,
      wireId: connection.id,
      title: nodeTitle(other.kind, other.id),
      role,
      direction,
      plain: isPlainLink(connection),
      can,
      sends: payloadsOver(connection, self, selfRole, role),
      carries: carriesMessages(can),
      track: connection.track ?? "auto",
      createdAt: connection.createdAt,
    };
    if (connection.role && other === connection.to) end.hydraRole = connection.role;
    if (connection.purpose) end.purpose = connection.purpose;
    if (connection.limits) end.limits = connection.limits;
    if (other.kind === "terminal") {
      const found = findTerminal(other.id);
      end.ptyId = getLivePtyId(other.id);
      end.terminalType = found?.terminal.type ?? null;
      end.worktreePath = found?.worktree.path ?? null;
    }
    ends.push(end);
  }
  return ends;
}
