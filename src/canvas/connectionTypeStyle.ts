/**
 * How a typed wire looks: the words at its midpoint, and the stroke that has to
 * carry the same meaning once the words are gone.
 *
 * The words come from what the wire does (shared/node-contracts.ts) or the
 * purpose the user gave it. The family (shared/connection-types.ts) is
 * encoded in the stroke, which survives all the way out to map zoom:
 *
 *   action     — solid.           Something happens.
 *   knowledge  — dashed.          Something is known.
 *   structural — faint hairline.  Nothing runs.
 */
import type { Ability } from "../../shared/node-contracts";
import {
  resolveConnectionType,
  type ConnectionFamily,
  type TypedConnectionLike,
} from "../../shared/connection-types";
import { truncateLabel } from "./connectionLabels";

/** Longest purpose shown on a wire before it is cut short. */
export const MAX_WIRE_LABEL_LENGTH = 28;

/**
 * The words on a wire, which say what it does rather than what it is
 * called: the user's purpose when they wrote one, else what the tail can do
 * to the head (`drives`, `messages`), else that nothing travels.
 * Returns an i18n key, or the purpose itself.
 */
export type WireLabel =
  | { kind: "purpose"; text: string }
  | { kind: "words"; key: WireLabelKey };

export type WireLabelKey =
  | "wire_label_link"
  | "wire_label_replies_chat"
  | "wire_label_replies_note"
  | "wire_label_drives"
  | "wire_label_reads"
  | "wire_label_messages"
  | "wire_label_runs"
  | "wire_label_adds"
  | "wire_label_logs"
  | "wire_label_sends";

export function wireLabel(input: {
  connection: TypedConnectionLike & { purpose?: string };
  /** What the tail may do to the head. */
  tailAbilities: readonly Ability[];
}): WireLabel {
  const type = resolveConnectionType(input.connection);
  if (type === "relates-to") return { kind: "words", key: "wire_label_link" };
  if (input.connection.purpose) {
    return { kind: "purpose", text: truncateLabel(input.connection.purpose, MAX_WIRE_LABEL_LENGTH) };
  }
  if (type === "sends-replies-to") return { kind: "words", key: "wire_label_replies_chat" };
  if (type === "writes-to" && input.connection.from.kind === "terminal") {
    return { kind: "words", key: "wire_label_replies_note" };
  }
  const has = (a: Ability) => input.tailAbilities.includes(a);
  if (has("drive")) return { kind: "words", key: "wire_label_drives" };
  if (has("read") && input.connection.to.kind === "browser") return { kind: "words", key: "wire_label_reads" };
  if (has("tell")) return { kind: "words", key: "wire_label_messages" };
  if (has("run")) return { kind: "words", key: "wire_label_runs" };
  if (has("append")) return { kind: "words", key: "wire_label_adds" };
  if (has("log")) return { kind: "words", key: "wire_label_logs" };
  return { kind: "words", key: "wire_label_sends" };
}

/**
 * What a wire's label says about the agent at its far end, when it says
 * anything: a Hydra worker's role and how its assignment is going, or the
 * role the wire gives (WirePanel) and how a tracked hand-off along it is
 * going. The user's purpose, when written, says it instead (wireLabel).
 * `status` is an i18n key; null when there is nothing to say.
 */
export function wireRoleLabel(input: {
  connection: { purpose?: string; role?: string; from: { id: string }; to: { kind: string; id: string } };
  /** The Hydra worker at the far end, if it is one. */
  hydra?: { role: string; status: string };
  /** The latest tracked hand-off each way along the wire, if any. */
  handoffForward?: string;
  handoffBack?: string;
}): { role: string | null; status: string | null } | null {
  const { connection, hydra } = input;
  if (connection.purpose) return null;
  if (hydra && connection.to.kind === "terminal") return { role: hydra.role, status: `hydra_status_${hydra.status}` };
  if (input.handoffForward) return { role: connection.role ?? null, status: `handoff_status_${input.handoffForward}` };
  // Back along a two-way wire: the role is the far end's, not the sender's.
  if (input.handoffBack) return { role: null, status: `handoff_status_${input.handoffBack}` };
  if (connection.role) return { role: connection.role, status: null };
  return null;
}

export type WireView = "working" | "overview";

export interface ConnectionStrokeStyle {
  /** SVG `stroke-dasharray`, or null for solid. */
  dash: string | null;
  /** Stroke width in screen pixels — these lines are non-scaling. */
  width: number;
  opacity: number;
}

const WORKING: Record<ConnectionFamily, ConnectionStrokeStyle> = {
  // Unchanged from what every wire looked like before types existed, which
  // matters: `controls` is an action, so an agent-to-browser wire drawn last
  // month is drawn identically today.
  action: { dash: null, width: 1.5, opacity: 0.8 },
  knowledge: { dash: "5 4", width: 1.5, opacity: 0.75 },
  structural: { dash: null, width: 1, opacity: 0.4 },
};

const OVERVIEW: Record<ConnectionFamily, ConnectionStrokeStyle> = {
  action: { dash: null, width: 1, opacity: 0.5 },
  knowledge: { dash: "3 3", width: 1, opacity: 0.5 },
  structural: { dash: "1 4", width: 1, opacity: 0.3 },
};

export function connectionStrokeStyle(
  family: ConnectionFamily,
  view: WireView = "working",
): ConnectionStrokeStyle {
  return view === "overview" ? OVERVIEW[family] : WORKING[family];
}
