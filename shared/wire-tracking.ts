/**
 * When a hand-off along a wire is tracked by Hydra's result contract.
 *
 * Light by default: most traffic between agents is a quick question or a
 * note. A tracked hand-off is heavier: the receiver gets a task sheet and
 * writes a report and a typed result (Hydra's `result.json`: completed,
 * stuck with a reason, or error), which comes back to the sender and, when
 * stuck, to the user. The wire's switch decides, and Auto tracks only on
 * concrete signals, never on an agent's sense of importance (decision of
 * 2026-10-28, docs/architecture/wiring-model.md):
 *
 *  - the work will change code;
 *  - the wire gives the receiver a role (dev, reviewer, qa, ...);
 *  - the sender asks for a typed result.
 *
 * (A Hydra Lead's own dispatch is always tracked, by Hydra itself.)
 */

export type WireTracking = "off" | "auto" | "always";

/** Hydra's built-in roles (hydra/src/roles/builtin), offered on a wire. */
export const WIRE_ROLES = ["dev", "reviewer", "qa", "designer", "janitor"] as const;
export type WireRole = (typeof WIRE_ROLES)[number];

export function isWireRole(value: unknown): value is WireRole {
  return typeof value === "string" && (WIRE_ROLES as readonly string[]).includes(value);
}

export interface TrackingSignals {
  changesCode?: boolean;
  typedResult?: boolean;
  role?: string | null;
}

export function shouldTrack(tracking: WireTracking | undefined, signals: TrackingSignals): boolean {
  switch (tracking ?? "auto") {
    case "off":
      return false;
    case "always":
      return true;
    case "auto":
      return !!signals.changesCode || !!signals.typedResult || isWireRole(signals.role);
  }
}

/** Why Auto tracked it, for the sender's reply. */
export function trackingReason(tracking: WireTracking | undefined, signals: TrackingSignals): string {
  if ((tracking ?? "auto") === "always") return "the wire is set to always track";
  if (signals.changesCode) return "the work changes code";
  if (isWireRole(signals.role)) return `the wire gives the receiver the ${signals.role} role`;
  return "you asked for a typed result";
}
