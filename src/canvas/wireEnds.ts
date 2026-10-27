import {
  wireCarriesMessages,
  wireDirectionFrom,
  type ConnectionEndpointKind,
} from "../../shared/connection-types";
import { connectionsInvolving, useConnectionStore } from "../stores/connectionStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { usePinStore } from "../stores/pinStore";
import { getTerminalDisplayTitle } from "../stores/terminalState";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";

/**
 * What a node is wired to, seen from that node: the other end of each wire,
 * which way the wire runs, and whether it carries messages. Backs
 * send_to_connected, emit_event and list_nodes, so all three agree on what
 * a wire allows.
 */
export interface WireEndView {
  kind: ConnectionEndpointKind;
  id: string;
  title: string | null;
  direction: "to_it" | "from_it" | "both_ways";
  carries: boolean;
  ptyId?: number | null;
  terminalType?: string | null;
  worktreePath?: string | null;
}

export function nodeTitle(kind: ConnectionEndpointKind, id: string): string | null {
  if (kind === "terminal") {
    const found = findTerminal(id);
    return found ? getTerminalDisplayTitle(found.terminal) : null;
  }
  if (kind === "browser") {
    const card = useBrowserCardStore.getState().cards[id];
    return card ? card.title || card.url || null : null;
  }
  const pin = Object.values(usePinStore.getState().pinsByProject).flat().find((p) => p.id === id);
  return pin?.title || null;
}

export function wireEndsOf(kind: ConnectionEndpointKind, id: string): WireEndView[] {
  const self = { kind, id };
  const ends: WireEndView[] = [];
  for (const connection of connectionsInvolving(useConnectionStore.getState().connections, kind, id)) {
    const direction = wireDirectionFrom(connection, self);
    if (!direction) continue;
    const other =
      connection.from.kind === kind && connection.from.id === id ? connection.to : connection.from;
    const end: WireEndView = {
      kind: other.kind,
      id: other.id,
      title: nodeTitle(other.kind, other.id),
      direction,
      carries: wireCarriesMessages(connection),
    };
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
