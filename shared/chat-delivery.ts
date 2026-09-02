/**
 * Delivering an agent's reply into a chat page.
 *
 * The workflow this exists for was done by hand first: an agent finishes, the
 * user copies its answer, opens a browser node holding a ChatGPT or Gemini
 * conversation, pastes it, and talks the answer through in voice mode. A wire
 * typed `sends-replies-to` does that copy-paste, then stops — it does not read
 * the response, relay anything back, or wait. The conversation that follows is
 * the user's.
 *
 * Two things learned the hard way shape everything here.
 *
 * **Submission must be atomic.** Typing and submitting have to happen inside
 * one uninterrupted script. Split across separate calls, the page loses focus
 * between them and the send silently no-ops — the text sits in the composer
 * looking delivered. So the whole sequence is built as a single string and
 * evaluated once, which is also why the input-scoring function below must be
 * closure-free: it is stringified into that script rather than imported.
 *
 * **The input box is not findable by one selector.** ChatGPT uses a
 * contenteditable div, Gemini a rich-text region, others a plain textarea. A
 * heuristic gets it right most of the time and will eventually pick wrong, and
 * delivering into the wrong box is worse than failing. Hence a per-host
 * override the user sets by pointing at the box once.
 */

import { resolveConnectionType } from "./connection-types";

/** What a delivery attempt did, in the words the user should hear about it. */
export type ChatDeliveryOutcome =
  | { ok: true; targetLabel: string }
  | {
      ok: false;
      /** A closed set, so the message shown is never a raw page error. */
      reason:
        | "no-input-found"
        | "ambiguous-input"
        | "page-not-ready"
        | "empty-reply"
        | "submit-failed"
        | "node-gone";
    };

/**
 * Why a delivery failed, said plainly and without blaming the user.
 *
 * Deliberately never retried and never queued: a reply arriving minutes late,
 * out of order with whatever the user moved on to, is more confusing than one
 * that visibly did not arrive.
 */
export function chatDeliveryFailureMessage(
  reason: Exclude<ChatDeliveryOutcome, { ok: true }>["reason"],
  targetLabel: string,
): string {
  switch (reason) {
    case "no-input-found":
      return `Couldn't find the message box in ${targetLabel}. Click the box once and Tacit will remember it for that site.`;
    case "ambiguous-input":
      return `More than one box in ${targetLabel} could be the one. Click the one you mean and Tacit will remember it for that site.`;
    case "page-not-ready":
      return `${targetLabel} wasn't ready, so the reply wasn't sent.`;
    case "empty-reply":
      return `Nothing to send to ${targetLabel} — the reply was empty.`;
    case "submit-failed":
      return `Typed the reply into ${targetLabel} but couldn't send it. It's still in the box.`;
    case "node-gone":
      return `The ${targetLabel} node closed before the reply could be sent.`;
  }
}

export interface ReplyWireLike {
  id: string;
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  type?: string;
}

/**
 * Which nodes this agent's reply should be delivered to.
 *
 * Only outgoing `sends-replies-to` wires, and only ones this agent is the
 * source of — a wire pointing *at* the agent means something else entirely.
 * Several targets is legitimate: one reply into a voice chat and another into a
 * second opinion is a reasonable thing to want.
 */
export function resolveReplyTargets(
  terminalId: string,
  wires: readonly ReplyWireLike[],
): Array<{ wireId: string; kind: string; id: string }> {
  const out: Array<{ wireId: string; kind: string; id: string }> = [];
  for (const wire of wires) {
    if (wire.from.kind !== "terminal" || wire.from.id !== terminalId) continue;
    if (resolveConnectionType(wire as never) !== "sends-replies-to") continue;
    out.push({ wireId: wire.id, kind: wire.to.kind, id: wire.to.id });
  }
  return out;
}

/** What the in-page script measures about one candidate input. */
export interface ChatInputCandidate {
  /** Lowercase tag name. */
  tag: string;
  /** True for `contenteditable`, which is what the big chat sites use. */
  editable: boolean;
  disabled: boolean;
  /** Rendered box. A zero-area candidate is hidden however it got that way. */
  width: number;
  height: number;
  /** Distance from the box's top to the bottom of the viewport. */
  bottomGap: number;
  viewportHeight: number;
  /** A send-looking control sits near it — the strongest signal available. */
  hasNearbySend: boolean;
}

/**
 * How likely this element is the thing you type a message into.
 *
 * MUST stay closure-free and dependency-free: it is stringified into the
 * injected script so the page and the tests score candidates with the same
 * code. Returns null for anything disqualified rather than a low score, so an
 * unusable candidate can never win by being the only one.
 */
export function scoreChatInput(c: ChatInputCandidate): number | null {
  if (c.disabled) return null;
  if (c.width < 80 || c.height < 16) return null;
  if (!c.editable && c.tag !== "textarea" && c.tag !== "input") return null;

  let score = 0;
  // A composer is almost always the widest editable thing on screen.
  score += Math.min(c.width / 40, 20);
  // Chat composers sit at the bottom. Scored on proximity rather than as a
  // cutoff, so an unusually tall composer is not disqualified for starting high.
  const fromBottom = Math.max(0, c.bottomGap);
  score += Math.max(0, 25 - (fromBottom / Math.max(c.viewportHeight, 1)) * 50);
  // Worth more than any geometry: a send button beside it is what makes a box
  // a composer rather than a search field.
  if (c.hasNearbySend) score += 30;
  // The big chat sites are contenteditable; a bare `input` is the last resort
  // and is usually a search box.
  if (c.editable) score += 12;
  else if (c.tag === "textarea") score += 8;
  return score;
}

/**
 * Pick the best candidate, or nothing.
 *
 * Ties go to the earlier candidate, which is document order — stable across
 * runs, so a wire that delivered somewhere yesterday delivers there today.
 */
export function pickChatInput(
  candidates: readonly ChatInputCandidate[],
): number | null {
  let bestIndex: number | null = null;
  let bestScore = -Infinity;
  candidates.forEach((candidate, index) => {
    const score = scoreChatInput(candidate);
    if (score === null || score <= bestScore) return;
    bestScore = score;
    bestIndex = index;
  });
  return bestIndex;
}

/**
 * How close the runner-up may be before the choice is called too close.
 *
 * Guessing between two comparable boxes is the one failure the user cannot
 * detect: the reply goes somewhere plausible and silently wrong. Asking costs
 * one click and is asked once per site, so the trade is heavily in favour of
 * asking — the threshold is deliberately cautious rather than tuned to keep
 * the prompt rare.
 */
export const AMBIGUITY_RATIO = 0.85;

/**
 * The best candidate, plus whether it actually stood out.
 *
 * Kept alongside `pickChatInput` rather than replacing it: the script needs
 * the margin, everything else only needs the winner.
 */
export function pickChatInputWithConfidence(
  candidates: readonly ChatInputCandidate[],
): { index: number | null; ambiguous: boolean } {
  const scored = candidates
    .map((candidate, index) => ({ index, score: scoreChatInput(candidate) }))
    .filter((entry): entry is { index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const best = scored[0];
  if (!best) return { index: null, ambiguous: false };
  const runnerUp = scored[1];
  const ambiguous =
    runnerUp !== undefined && best.score > 0 && runnerUp.score / best.score >= AMBIGUITY_RATIO;
  return { index: best.index, ambiguous };
}

/** Per-host box the user pointed at, when the heuristic needed correcting. */
export interface ChatInputOverride {
  host: string;
  selector: string;
}

export function overrideForUrl(
  url: string,
  overrides: readonly ChatInputOverride[],
): string | undefined {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
  return overrides.find((o) => o.host.toLowerCase() === host)?.selector;
}
