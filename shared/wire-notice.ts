/**
 * What an agent is told when a wire gives it something new.
 *
 * Agents weren't told about wires at all, which is why one reached for a
 * manager-only tool instead of the wire it had been given. The notice says
 * what is at the other end, what the wire is for, and which tool reaches it,
 * and that it is for when the task needs it, so the agent doesn't take it as
 * work to start now. Pure, so the wording is tested.
 */

import type { Ability, NodeRole } from "./node-contracts";

export interface WireNoticeInput {
  other: { role: NodeRole; id: string; title: string | null };
  /** What the agent may now do to the other end. */
  abilities: readonly Ability[];
  purpose?: string;
  /** Whether the other end may also start things back. */
  twoWay: boolean;
}

function name(other: WireNoticeInput["other"]): string {
  const kind = other.role === "agent" || other.role === "shell" ? "terminal" : other.role;
  return other.title ? `"${other.title}" (${kind} ${other.id})` : `${kind} ${other.id}`;
}

/** The notice, or null when the wire gives this agent nothing to use. */
export function wireNoticeText(input: WireNoticeInput): string | null {
  const { other, abilities } = input;
  if (abilities.length === 0) return null;
  const has = (a: Ability) => abilities.includes(a);
  const parts: string[] = [];

  switch (other.role) {
    case "browser":
      parts.push(`A browser on the canvas is wired to you: ${name(other)}.`);
      parts.push(
        has("drive")
          ? "Read or drive it with browser_read, browser_navigate, browser_click and browser_eval."
          : "Read it with browser_read. The wire is read-only, so navigating, clicking and scripts are refused.",
      );
      break;
    case "agent": {
      parts.push(`Another agent is wired to you on the canvas: ${name(other)}.`);
      const verbs: string[] = [];
      if (has("tell")) verbs.push("send it a message with send_to_connected");
      if (verbs.length) parts.push(`You can ${joinWords(verbs)}.`);
      if (input.twoWay) parts.push("The wire runs both ways, so it can reach you too.");
      break;
    }
    case "shell":
      parts.push(`A shell is wired to you on the canvas: ${name(other)}. send_to_connected runs your message there as a command.`);
      break;
    case "note":
      parts.push(`A note is wired to you on the canvas: ${name(other)}. send_to_connected adds your message to it.`);
      break;
    case "task":
      parts.push(`A task is wired to you on the canvas: ${name(other)}. send_to_connected adds your message to it.`);
      break;
  }
  if (input.purpose) parts.push(`The wire's purpose: ${input.purpose.replace(/[.\s]+$/, "")}.`);
  parts.push("Use it when the task needs it; there is nothing to do about this now. list_nodes shows everything you're wired to.");
  return parts.join(" ");
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
