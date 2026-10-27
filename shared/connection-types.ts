/**
 * What a wire on the canvas means.
 *
 * Connections used to be adjacency: you drew a line and the app guessed a
 * behaviour from the node kinds at each end. Agent-to-browser was read as "may
 * drive that page"; everything else did nothing, indistinguishably. One line
 * could plausibly mean control, delivery, or reading-for-context, and there was
 * no way to say which you meant — or to tell by looking.
 *
 * A type fixes that twice over. The canvas knows what to do, and the wire
 * records *what kind of relationship it was* — "this research informed that
 * decision" is a different fact from "this agent handed off to that one", and
 * neither survives in a transcript. Drawing the line writes that down as a side
 * effect of getting something done.
 *
 * The set is closed on purpose. This is one step from `if X then Y`, which is a
 * workflow-automation product; the guard is that every type is a fixed phrase
 * you can read aloud off the canvas. `custom` opens exactly one slot — what
 * happens to the payload in transit — and never what triggers it or where it
 * goes.
 */

export type ConnectionEndpointKind = "terminal" | "browser" | "note";

export type ConnectionType =
  /** The agent may drive that page. The historical behaviour of a wire. */
  | "controls"
  /** On finishing, the source's reply is delivered and submitted. */
  | "sends-replies-to"
  /** What is read there becomes context the target can use. */
  | "feeds-context-to"
  /** On completion, the target picks the work up. */
  | "hands-off-to"
  /** Page content goes into another page. */
  | "sends-page-to"
  /** A note's contents become standing instruction for an agent. */
  | "instructs"
  /** Output lands in a note instead of scrolling away. */
  | "writes-to"
  /** Nothing runs. The relationship is recorded and drawn. */
  | "relates-to"
  /** The payload is reshaped by a sentence the user wrote. */
  | "custom";

/**
 * How a wire is drawn when it is too small to read.
 *
 * Nine line styles would be nine things nobody can tell apart, so the types
 * collapse into three families legible at any zoom. The exact type stays in the
 * label for when you are close enough to read it.
 */
export type ConnectionFamily =
  /** Something happens. Solid. */
  | "action"
  /** Something is known. Dashed. */
  | "knowledge"
  /** Nothing runs. Faint hairline. */
  | "structural";

export interface ConnectionTypeSpec {
  type: ConnectionType;
  /** Read aloud with the endpoints: "Claude Code *sends replies to* ChatGPT". */
  label: string;
  family: ConnectionFamily;
  /** Whether choosing it requires the user to type something. Only `custom`. */
  needsInput: boolean;
}

const SPECS: Record<ConnectionType, ConnectionTypeSpec> = {
  "controls": { type: "controls", label: "controls", family: "action", needsInput: false },
  "sends-replies-to": { type: "sends-replies-to", label: "sends replies to", family: "action", needsInput: false },
  "feeds-context-to": { type: "feeds-context-to", label: "feeds context to", family: "knowledge", needsInput: false },
  "hands-off-to": { type: "hands-off-to", label: "hands off to", family: "action", needsInput: false },
  "sends-page-to": { type: "sends-page-to", label: "sends page to", family: "action", needsInput: false },
  "instructs": { type: "instructs", label: "instructs", family: "knowledge", needsInput: false },
  "writes-to": { type: "writes-to", label: "writes to", family: "action", needsInput: false },
  "relates-to": { type: "relates-to", label: "relates to", family: "structural", needsInput: false },
  "custom": { type: "custom", label: "custom", family: "action", needsInput: true },
};

export function connectionTypeSpec(type: ConnectionType): ConnectionTypeSpec {
  return SPECS[type];
}

export function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === "string" && value in SPECS;
}

/**
 * The wires that actually do something, as `type from>to`.
 *
 * Keyed by the pair and not by the type alone, because the same type runs at
 * one pair and not another and the difference is not cosmetic. `sends replies
 * to` delivers into a browser node and does nothing at all between two
 * terminals — the delivery code says so out loud when it hits that case.
 * `writes to` appends an agent's answer to a note, but a browser node has no
 * completion signal to fire on, so the same label between a page and a note is
 * a relationship the canvas records rather than a behaviour it runs.
 *
 * This is a statement about the build, not about the design, which is why it is
 * a table here rather than a field on the spec: a family says what a
 * relationship *means* and is permanent; this says what this build *does* and is
 * expected to shrink. Add a line in the same commit that lands the behaviour.
 */
const RUNNING: ReadonlySet<string> = new Set([
  "controls terminal>browser",
  "sends-replies-to terminal>browser",
  "writes-to terminal>note",
  // The agent at the source passes work on with send_to_connected.
  "hands-off-to terminal>terminal",
]);

/** Whether drawing this wire, between these two kinds, makes something happen. */
export function connectionRuns(
  type: ConnectionType,
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): boolean {
  return RUNNING.has(`${type} ${pairKey(from, to)}`);
}

/**
 * Whether this wire reads as though it does something but does not do it yet.
 *
 * Not simply the inverse of `connectionRuns`. `relates-to` does not run either,
 * but it says so — its label is a relationship and its family is the faint
 * hairline that already means "nothing happens here". Marking it would report a
 * gap that is not one.
 *
 * What needs marking is the wire whose label makes a promise the build does not
 * keep: "hands off to" drawn as a solid action line, doing nothing. That is the
 * set the UI decorates, and it empties as behaviours land.
 */
export function isPendingBehaviour(
  type: ConnectionType,
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): boolean {
  return (
    !connectionRuns(type, from, to) &&
    connectionTypeSpec(type).family !== "structural"
  );
}

/** `from-kind → to-kind`, the key both tables below are indexed by. */
function pairKey(
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): string {
  return `${from}>${to}`;
}

/**
 * The type a wire takes when the user has not chosen one.
 *
 * Guessing rather than asking is what keeps connecting cheap, and connecting
 * freely is the gesture the whole idea depends on. It is also what makes this
 * change free: `terminal>browser` resolves to `controls`, which is exactly what
 * such a wire already did, so nothing drawn before this existed behaves
 * differently and no migration is needed.
 *
 * Pairs with no sensible action fall to `relates-to` rather than inventing one.
 */
const DEFAULTS: Record<string, ConnectionType> = {
  "terminal>browser": "controls",
  "browser>terminal": "feeds-context-to",
  "terminal>terminal": "hands-off-to",
  "browser>browser": "sends-page-to",
  "note>terminal": "instructs",
  "terminal>note": "writes-to",
  "browser>note": "writes-to",
  "note>browser": "relates-to",
  "note>note": "relates-to",
};

export function defaultConnectionType(
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): ConnectionType {
  return DEFAULTS[pairKey(from, to)] ?? "relates-to";
}

/**
 * Which types this pair may be, i.e. what the menu offers.
 *
 * Only valid entries are listed — no greyed-out rows for combinations that can
 * never apply, which is a menu teaching you about restrictions instead of
 * offering you choices.
 */
const EXTRA_CHOICES: Record<string, ConnectionType[]> = {
  "terminal>browser": ["sends-replies-to"],
  "terminal>terminal": ["sends-replies-to"],
};

export function validConnectionTypes(
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): ConnectionType[] {
  const key = pairKey(from, to);
  const primary = DEFAULTS[key] ?? "relates-to";
  const seen = new Set<ConnectionType>();
  const out: ConnectionType[] = [];
  // Only what this build runs is offered: a menu of "not yet" rows promised
  // behaviour that drawing the wire then didn't deliver. Custom comes back
  // when it runs.
  for (const type of [primary, ...(EXTRA_CHOICES[key] ?? [])]) {
    if (!seen.has(type) && connectionRuns(type, from, to)) { seen.add(type); out.push(type); }
  }
  // Always available, and always last: recording a bare relationship is
  // meaningful for any pair.
  if (!seen.has("relates-to")) out.push("relates-to");
  return out;
}

/**
 * The rows a wire's menu shows: what the pair can be, led by the wire's
 * current meaning when that is one this build no longer offers, so the menu
 * never opens with nothing marked and an old wire can be moved off it.
 */
export function menuConnectionTypes(
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
  current: ConnectionType,
): ConnectionType[] {
  const offered = validConnectionTypes(from, to);
  return offered.includes(current) ? offered : [current, ...offered];
}

/**
 * The type a wire the user just drew is given: what the pair means by
 * default when this build runs it, else a bare relationship. Stamped at
 * creation, so wires drawn before keep the meaning they were drawn with.
 */
export function newWireConnectionType(
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
): ConnectionType {
  const primary = defaultConnectionType(from, to);
  return connectionRuns(primary, from, to) ? primary : "relates-to";
}

/** Minimal shape of a stored wire for working out who may send along it. */
export interface DirectedConnectionLike extends TypedConnectionLike {
  from: { kind: ConnectionEndpointKind; id: string };
  to: { kind: ConnectionEndpointKind; id: string };
  origin?: "spawn" | "manual";
  twoWay?: boolean;
}

/**
 * Whether either end may send along this wire. A wire runs from where it was
 * dragged to where it was dropped unless it was made two-way. A spawn wire is
 * two-way: the agent that started a worker instructs it and the worker
 * reports back.
 */
export function isTwoWay(connection: DirectedConnectionLike): boolean {
  return connection.twoWay ?? connection.origin === "spawn";
}

/** Which way this wire runs, seen from one of its ends; null if it isn't one. */
export function wireDirectionFrom(
  connection: DirectedConnectionLike,
  end: { kind: ConnectionEndpointKind; id: string },
): "to_it" | "from_it" | "both_ways" | null {
  const isFrom = connection.from.kind === end.kind && connection.from.id === end.id;
  const isTo = connection.to.kind === end.kind && connection.to.id === end.id;
  if (!isFrom && !isTo) return null;
  if (isTwoWay(connection)) return "both_ways";
  return isFrom ? "to_it" : "from_it";
}

/**
 * The wire types an agent's messages travel along. A bare relationship
 * records and runs nothing, and a wire whose behaviour isn't built yet must
 * not quietly start doing something else.
 */
const MESSAGE_TYPES: ReadonlySet<ConnectionType> = new Set([
  "hands-off-to",
  "sends-replies-to",
  "writes-to",
]);

export function wireCarriesMessages(connection: TypedConnectionLike): boolean {
  return MESSAGE_TYPES.has(resolveConnectionType(connection));
}

/** Minimal shape of a stored connection; the store's own type is wider. */
export interface TypedConnectionLike {
  from: { kind: ConnectionEndpointKind };
  to: { kind: ConnectionEndpointKind };
  type?: ConnectionType;
}

/**
 * The single accessor everything reads.
 *
 * A stored type that this build does not recognise — written by a newer
 * version — falls back to the inferred default rather than being treated as an
 * unknown behaviour, so an older build downgrades a wire's meaning instead of
 * ignoring the wire.
 */
export function resolveConnectionType(
  connection: TypedConnectionLike,
): ConnectionType {
  if (isConnectionType(connection.type)) return connection.type;
  return defaultConnectionType(connection.from.kind, connection.to.kind);
}

export function connectionFamily(connection: TypedConnectionLike): ConnectionFamily {
  return connectionTypeSpec(resolveConnectionType(connection)).family;
}

/** Longest custom instruction accepted. A sentence, not a program. */
export const MAX_CUSTOM_PROMPT_LENGTH = 400;

export function normalizeCustomPrompt(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, MAX_CUSTOM_PROMPT_LENGTH);
}
