/**
 * Who may change a drawing (docs/architecture/workdesk-board.md,
 * "Permissions"). Agents can always read. Free of React, the DOM and the
 * stores.
 *
 * What's set on a drawing, or on the section or frame round it, holds for
 * everyone. With nothing set, an agent asks before it changes yours, and
 * agents may change each other's: what they draw is shared.
 */
import type { BoardAgentAccess, BoardElement } from "../types/board";
import { contentsOf } from "./boardModel";

export const isAgents = (e: BoardElement): boolean => e.author?.kind === "agent";
export const isOwn = (e: BoardElement, terminalId: string): boolean => e.author?.kind === "agent" && e.author.terminalId === terminalId;

/** What's set on it or round it, nearest first; null when nothing is. */
export function accessSet(e: BoardElement, elements: readonly BoardElement[]): BoardAgentAccess | null {
  const seen = new Set<string>();
  for (let at: BoardElement | undefined = e; at && !seen.has(at.id); ) {
    if (at.agents) return at.agents;
    seen.add(at.id);
    const parent: string | undefined = at.parent;
    at = parent ? elements.find((x) => x.id === parent) : undefined;
  }
  return null;
}

/** Who may change it, as shown on it. */
export const accessOf = (e: BoardElement, elements: readonly BoardElement[]): BoardAgentAccess => accessSet(e, elements) ?? (isAgents(e) ? "edit" : "ask");

/** For one agent: yes at once, ask first, or not at all. */
export function mayChange(e: BoardElement, terminalId: string, elements: readonly BoardElement[]): BoardAgentAccess {
  const set = accessSet(e, elements);
  if (set) return set;
  return isOwn(e, terminalId) ? "edit" : accessOf(e, elements);
}

/** Deleting asks for anything that isn't the agent's own, even under Can edit. */
export function mayDelete(e: BoardElement, terminalId: string, elements: readonly BoardElement[]): BoardAgentAccess {
  const may = mayChange(e, terminalId, elements);
  return may === "edit" && !isOwn(e, terminalId) ? "ask" : may;
}

/** What "Only me" is round or in: moving a container moves what it holds. */
export function heldOnlyYours(container: BoardElement, elements: readonly BoardElement[]): boolean {
  return contentsOf(container, elements).elements.some((e) => e.agents === "mine");
}
