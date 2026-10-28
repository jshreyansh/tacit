/**
 * Rules on a wire: when something happens at one end, send something to the
 * other. The Send button, pressed for you.
 *
 * Deliberately one shape and nothing more: one event at one end, one
 * delivery to the other end of the same wire. No conditions, no branching,
 * no variables. Chains happen by wiring more nodes, and they stop after a
 * fixed number of hops (MAX_AUTOMATIC_HOPS in wire-envelope.ts).
 *
 * The events offered are the ones this build can observe. Nodes declare more
 * (node-contracts.ts `emits`); a trigger is added here in the same change
 * that makes it fire.
 *
 * See docs/architecture/wiring-model.md.
 */

import type { NodeRole, PayloadKind } from "./node-contracts";

export type RuleTrigger =
  /** An agent finished a turn; what is sent is its final reply. */
  | "turn_finished"
  /** A page logged an error to its console; what is sent is the error. */
  | "console_error";

export interface WireRule {
  id: string;
  when: RuleTrigger;
  /** Which end the event happens at; the delivery goes to the other end. */
  at: "from" | "to";
  /**
   * "ask": the user is asked each time until they choose Always (the
   * decision of 2026-10-28: rules ask the first time they fire).
   */
  consent: "ask" | "always";
  /** At most this many deliveries in any hour. */
  perHour: number;
}

export const DEFAULT_RULE_PER_HOUR = 20;

interface TriggerSpec {
  /** The kind of node that raises it. */
  emitter: NodeRole;
  payload: PayloadKind;
  /** Kinds of node it can be delivered to. */
  deliversTo: readonly NodeRole[];
}

export const RULE_TRIGGERS: Readonly<Record<RuleTrigger, TriggerSpec>> = {
  // Into a browser or a note an agent's reply already has its own rule (the
  // reply toggles on the wire), so those aren't offered twice.
  turn_finished: { emitter: "agent", payload: "reply", deliversTo: ["agent", "task"] },
  console_error: { emitter: "browser", payload: "text", deliversTo: ["agent"] },
};

export function isRuleTrigger(value: unknown): value is RuleTrigger {
  return typeof value === "string" && value in RULE_TRIGGERS;
}

/** The rules a wire between these two nodes can have, by event and end. */
export function rulesOffered(
  fromRole: NodeRole,
  toRole: NodeRole,
  plain: boolean,
): Array<Pick<WireRule, "when" | "at">> {
  if (plain) return [];
  const out: Array<Pick<WireRule, "when" | "at">> = [];
  for (const [when, spec] of Object.entries(RULE_TRIGGERS) as Array<[RuleTrigger, TriggerSpec]>) {
    if (spec.emitter === fromRole && spec.deliversTo.includes(toRole)) out.push({ when, at: "from" });
    if (spec.emitter === toRole && spec.deliversTo.includes(fromRole)) out.push({ when, at: "to" });
  }
  return out;
}

/** Whether another delivery fits in the last hour, given past ones. */
export function withinHourlyLimit(firedAt: readonly number[], now: number, perHour: number): boolean {
  return firedAt.filter((t) => now - t < 3_600_000).length < perHour;
}

/** Stored rules from a save, keeping only well-formed ones. */
export function normalizeRules(raw: unknown): WireRule[] {
  if (!Array.isArray(raw)) return [];
  const out: WireRule[] = [];
  for (const item of raw) {
    const r = item as Partial<WireRule>;
    if (typeof r.id !== "string" || !isRuleTrigger(r.when) || (r.at !== "from" && r.at !== "to")) continue;
    out.push({
      id: r.id,
      when: r.when,
      at: r.at,
      consent: r.consent === "always" ? "always" : "ask",
      perHour:
        typeof r.perHour === "number" && r.perHour > 0 && r.perHour <= 120 ? Math.floor(r.perHour) : DEFAULT_RULE_PER_HOUR,
    });
  }
  return out;
}

/** Console errors gathered over a moment, as one message. */
export function consoleErrorsText(errors: readonly string[], max = 10): string {
  const shown = errors.slice(0, max);
  const more = errors.length - shown.length;
  return [
    errors.length === 1 ? "The page logged an error:" : `The page logged ${errors.length} errors:`,
    ...shown.map((e) => `- ${e.replace(/\s+/g, " ").trim().slice(0, 500)}`),
    ...(more > 0 ? [`(and ${more} more)`] : []),
  ].join("\n");
}

/** A rule in plain words, for the record and for agents. */
export function ruleWords(rule: Pick<WireRule, "when">, eventNode: string, otherNode: string): string {
  return rule.when === "turn_finished"
    ? `when ${eventNode} finishes a turn, send its reply to ${otherNode}`
    : `when ${eventNode} logs a console error, tell ${otherNode}`;
}
