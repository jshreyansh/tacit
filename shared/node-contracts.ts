/**
 * What each kind of node on the canvas can do over a wire.
 *
 * Wires used to get their behaviour from a table of pairs: `terminal>browser`
 * meant one thing, `terminal>note` another, and every new kind of node needed
 * a row for every old one. Here each kind describes itself once, the way a
 * synth module lists its jacks, and what a wire allows is worked out from the
 * two ends: whether the tail starts things, what the head offers, which way
 * the wire runs, and any limit the user put on it. A new kind of node is one
 * entry below and one way of receiving messages.
 *
 * See docs/architecture/wiring-model.md.
 */

import { findAgentAdapter } from "./agent-adapters";
import {
  isTwoWay,
  resolveConnectionType,
  type ConnectionEndpointKind,
  type DirectedConnectionLike,
} from "./connection-types";

/** What a node is, as far as wires care. Finer than the endpoint kind:
 * a terminal is an agent or a shell, a pin is a note or a task. */
export type NodeRole = "agent" | "shell" | "browser" | "note" | "task";

/** Something a node lets whoever is wired to it do. */
export type Ability =
  /** Navigate, click, type and run scripts in a page. */
  | "drive"
  /** Read a page, a note or a task. */
  | "read"
  /** Send a message that needs no answer. */
  | "tell"
  /** Send a question; the answer comes back to the asker. */
  | "ask"
  /** Pass the work on: the sender is done, the receiver carries on. */
  | "hand_off"
  /** Run a command in a shell. */
  | "run"
  /** Add text to a note. */
  | "append"
  /** Add steps and log lines to a task. */
  | "log";

/** What can travel along a wire. */
export type PayloadKind =
  | "text"
  | "command"
  | "url"
  | "page"
  | "selection"
  | "reply"
  | "step";

/** What a node can tell its wires happened. */
export type NodeEvent =
  | "turn_finished"
  | "needs_you"
  | "failed"
  | "command_finished"
  | "page_loaded"
  | "console_error"
  | "edited"
  | "status_changed";

export interface NodeContract {
  role: NodeRole;
  /** Whether it acts on its own: an agent, or a shell someone types into.
   * Only a node that starts things can use what a wire offers. */
  startsThings: boolean;
  /** What a node wired to it, at the tail, may do to it. */
  offers: readonly Ability[];
  /** What can be delivered into it. */
  accepts: readonly PayloadKind[];
  /** What it raises, for rules to react to. */
  emits: readonly NodeEvent[];
  /** What it can send out along its wires. */
  gives: readonly PayloadKind[];
}

export const NODE_CONTRACTS: Readonly<Record<NodeRole, NodeContract>> = {
  agent: {
    role: "agent",
    startsThings: true,
    offers: ["tell", "ask", "hand_off"],
    accepts: ["text", "page", "selection", "reply", "url"],
    emits: ["turn_finished", "needs_you", "failed"],
    gives: ["reply", "text"],
  },
  // A shell starts things because a person, or a script calling the tacit
  // CLI, is typing in it.
  shell: {
    role: "shell",
    startsThings: true,
    offers: ["run"],
    accepts: ["command"],
    emits: ["command_finished"],
    gives: ["text"],
  },
  browser: {
    role: "browser",
    startsThings: false,
    offers: ["read", "drive"],
    accepts: ["url", "text"],
    emits: ["page_loaded", "console_error"],
    gives: ["page", "selection", "url"],
  },
  note: {
    role: "note",
    startsThings: false,
    offers: ["read", "append"],
    accepts: ["text", "reply", "page", "selection"],
    emits: ["edited"],
    gives: ["text"],
  },
  task: {
    role: "task",
    startsThings: false,
    offers: ["read", "log"],
    accepts: ["step", "text", "reply"],
    emits: ["status_changed", "needs_you"],
    gives: ["text"],
  },
};

export function nodeContract(role: NodeRole): NodeContract {
  return NODE_CONTRACTS[role];
}

/**
 * The role of a node from what the canvas knows about it. A terminal is an
 * agent when its type is an agent CLI Tacit knows; anything else running in
 * a terminal is a shell. A pin without a kind is a note when it sits on the
 * canvas, as `pinKind` decides.
 */
export function nodeRoleOf(
  kind: ConnectionEndpointKind,
  detail: { terminalType?: string | null; pinKind?: "task" | "note" | null } = {},
): NodeRole {
  if (kind === "browser") return "browser";
  if (kind === "note") return detail.pinKind === "task" ? "task" : "note";
  return findAgentAdapter(detail.terminalType ?? undefined) ? "agent" : "shell";
}

/** Limits the user put on a wire, narrowing what its head offers. */
export interface WireLimits {
  /** "read" lets the agent read the page but not navigate, click or run
   * scripts in it. Absent means it may drive. */
  browser?: "read" | "drive";
}

export interface WireLike extends DirectedConnectionLike {
  limits?: WireLimits;
}

/** A wire that is drawn and recorded and carries nothing. */
export function isPlainLink(wire: DirectedConnectionLike): boolean {
  return resolveConnectionType(wire) === "relates-to";
}

/**
 * What `self` may do to the node at the other end of `wire`.
 *
 * Empty when the wire is a plain link, when it runs the other way (one-way
 * wires let only their tail start things), or when `self` is a node that
 * doesn't start things. Otherwise what the other end offers, less anything
 * the wire's limits take away.
 */
export function abilitiesOver(
  wire: WireLike,
  self: { kind: ConnectionEndpointKind; id: string },
  selfRole: NodeRole,
  otherRole: NodeRole,
): Ability[] {
  if (isPlainLink(wire)) return [];
  const isFrom = wire.from.kind === self.kind && wire.from.id === self.id;
  const isTo = wire.to.kind === self.kind && wire.to.id === self.id;
  if (!isFrom && !isTo) return [];
  if (!isFrom && !isTwoWay(wire)) return [];
  if (!nodeContract(selfRole).startsThings) return [];
  let offers = [...nodeContract(otherRole).offers];
  if (otherRole === "browser" && wire.limits?.browser === "read") {
    offers = offers.filter((ability) => ability !== "drive");
  }
  return offers;
}

/** What `self` can send out along this wire for the other end to receive:
 * the Send action's choices. Follows direction like everything else. */
export function payloadsOver(
  wire: WireLike,
  self: { kind: ConnectionEndpointKind; id: string },
  selfRole: NodeRole,
  otherRole: NodeRole,
): PayloadKind[] {
  if (isPlainLink(wire)) return [];
  const isFrom = wire.from.kind === self.kind && wire.from.id === self.id;
  const isTo = wire.to.kind === self.kind && wire.to.id === self.id;
  if (!isFrom && !isTo) return [];
  if (!isFrom && !isTwoWay(wire)) return [];
  const accepts = new Set(nodeContract(otherRole).accepts);
  return nodeContract(selfRole).gives.filter((payload) => accepts.has(payload));
}

/** Whether a message sent with send_to_connected reaches the other end. */
export function carriesMessages(abilities: readonly Ability[]): boolean {
  return abilities.some((a) => a === "tell" || a === "run" || a === "append" || a === "log");
}

/** Plain words for an ability, for menus, notices and list_nodes. */
export const ABILITY_WORDS: Readonly<Record<Ability, string>> = {
  drive: "drive",
  read: "read",
  tell: "tell",
  ask: "ask",
  hand_off: "hand off to",
  run: "run commands in",
  append: "add to",
  log: "log steps in",
};

/** Normalised purpose: one line, at most this long. */
export const MAX_WIRE_PURPOSE_LENGTH = 160;

export function normalizeWirePurpose(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, MAX_WIRE_PURPOSE_LENGTH);
}
