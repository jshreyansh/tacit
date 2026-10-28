import { MAX_ENVELOPE_LENGTH, type WireEnvelope } from "../shared/wire-envelope";
import type { NodeRole, PayloadKind } from "../shared/node-contracts";

/**
 * Checks a Send request from the app's window (wire:send-to-terminal) before
 * anything is typed. The window is trusted, but the handler still takes only
 * this shape: one terminal, one envelope from a node that can send it, text
 * of a bounded size.
 */

export interface WireSendTarget {
  terminalId: string;
  ptyId: number;
  terminalType: string;
  worktreePath: string;
}

const SOURCE_KINDS = new Set(["terminal", "browser", "note"]);
const SOURCE_ROLES = new Set<NodeRole>(["agent", "shell", "browser", "note", "task"]);
const PAYLOADS = new Set<PayloadKind>(["text", "command", "url", "page", "selection", "reply", "step"]);

const isText = (value: unknown, max = 2_000): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function parseWireSendRequest(
  raw: unknown,
): { ok: true; target: WireSendTarget; envelope: WireEnvelope } | { ok: false; detail: string } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const target = (input.target ?? {}) as Record<string, unknown>;
  const envelope = (input.envelope ?? {}) as Record<string, unknown>;
  const from = (envelope.from ?? {}) as Record<string, unknown>;

  if (!isText(target.terminalId, 200) || !isText(target.terminalType, 100) || !isText(target.worktreePath, 4_096)) {
    return { ok: false, detail: "The target terminal is incomplete." };
  }
  if (typeof target.ptyId !== "number" || !Number.isInteger(target.ptyId) || target.ptyId < 0) {
    return { ok: false, detail: "The target terminal isn't running." };
  }
  if (!SOURCE_KINDS.has(from.kind as string) || !isText(from.id, 200) || typeof from.title !== "string") {
    return { ok: false, detail: "The sending node is incomplete." };
  }
  if (!SOURCE_ROLES.has(from.role as NodeRole) || !PAYLOADS.has(envelope.payload as PayloadKind)) {
    return { ok: false, detail: "That can't be sent along a wire." };
  }
  if (typeof envelope.body !== "string" || envelope.body.trim() === "") {
    return { ok: false, detail: "There is nothing to send." };
  }
  if (envelope.body.length > MAX_ENVELOPE_LENGTH) {
    return { ok: false, detail: `That is ${envelope.body.length} characters; the limit is ${MAX_ENVELOPE_LENGTH}.` };
  }
  return {
    ok: true,
    target: {
      terminalId: target.terminalId,
      ptyId: target.ptyId,
      terminalType: target.terminalType,
      worktreePath: target.worktreePath,
    },
    envelope: {
      from: {
        kind: from.kind as WireEnvelope["from"]["kind"],
        id: from.id,
        title: from.title.slice(0, 200) || from.id,
        role: from.role as NodeRole,
      },
      payload: envelope.payload as PayloadKind,
      body: envelope.body,
      // Sent by a person pressing Send: never an automatic hop.
      hop: 0,
    },
  };
}
