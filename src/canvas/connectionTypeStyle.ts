/**
 * How a typed wire looks: the words at its midpoint, and the stroke that has to
 * carry the same meaning once the words are gone.
 *
 * The split is deliberate. There are nine types and three families
 * (shared/connection-types.ts), because nine line styles would be nine things
 * nobody can tell apart. So the exact type is spelled out in the label while you
 * are close enough to read it, and the family is encoded in the stroke, which
 * survives all the way out to map zoom:
 *
 *   action     — solid.           Something happens.
 *   knowledge  — dashed.          Something is known.
 *   structural — faint hairline.  Nothing runs.
 *
 * `custom` keeps its family's stroke and adds a small hollow diamond at the
 * midpoint. It is not given a family of its own because it *has* a family — what
 * makes it worth spotting from across the board is that a person wrote the rule
 * by hand, which is a different axis from what the wire does. Hence a marker on
 * top of the stroke rather than a fourth stroke competing with three.
 *
 * Pure and free of React/DOM so both halves can be unit-tested.
 */
import {
  connectionTypeSpec,
  resolveConnectionType,
  type ConnectionFamily,
  type TypedConnectionLike,
} from "../../shared/connection-types";
import { truncateLabel } from "./connectionLabels";

/**
 * How much of a custom instruction is shown on the wire.
 *
 * Enough to recognise which bespoke rule this is, not enough to read it —
 * "custom" alone would make every hand-written wire on the canvas
 * indistinguishable, which defeats the point of hand-writing one. The full
 * sentence lives in the menu.
 */
export const MAX_WIRE_PROMPT_LENGTH = 24;

/** Minimal shape needed to render a wire's label. */
export interface LabelledConnectionLike extends TypedConnectionLike {
  customPrompt?: string;
}

/** The instruction, collapsed and elided to fit on a wire. */
export function shortCustomPrompt(
  prompt: string | undefined,
  max = MAX_WIRE_PROMPT_LENGTH,
): string | null {
  if (typeof prompt !== "string") return null;
  const short = truncateLabel(prompt, max);
  return short.length > 0 ? short : null;
}

/**
 * The words drawn at the wire's midpoint.
 *
 * Reads as a phrase between the two endpoints — "Claude Code *sends replies to*
 * ChatGPT" — which is the guard against this becoming an if-then builder: every
 * type is a fixed sentence you can say aloud off the canvas.
 */
export function formatConnectionTypeLabel(
  connection: LabelledConnectionLike,
): string {
  const spec = connectionTypeSpec(resolveConnectionType(connection));
  if (spec.type !== "custom") return spec.label;
  const prompt = shortCustomPrompt(connection.customPrompt);
  // A custom wire with no instruction yet is still honestly "custom"; it just
  // has nothing bespoke to show.
  return prompt ? `${spec.label} · ${prompt}` : spec.label;
}

/** Whether this wire gets the hand-written marker. */
export function hasCustomMarker(connection: TypedConnectionLike): boolean {
  return resolveConnectionType(connection) === "custom";
}

/**
 * Working view is the zoomed-in editing read; overview is the soft map read the
 * layer crossfades to below 0.6. Both encode family, at different weights.
 */
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
