import { findAgentAdapter } from "../shared/agent-adapters";

/**
 * Backs the send_to_connected MCP tool: an agent passing a message along a
 * wire the user drew on the canvas. The wire is the permission, so unlike
 * send_prompt_to_node this needs no manager role, and it reaches only what
 * this agent is wired to, in the direction the wire runs.
 *
 * Kept out of api-server.ts so the rules (direction, what each kind of node
 * does with a message, how it is labelled) can be tested without a window or
 * a renderer; the server supplies the lookup, delivery and recording.
 */

export type WireDirection = "to_it" | "from_it" | "both_ways";

export interface WireEnd {
  kind: "terminal" | "browser" | "note";
  id: string;
  title: string | null;
  /** Which way the wire runs, seen from the sender. */
  direction: WireDirection;
  /** Whether a message sent along it arrives: worked out from the node
   * contracts at both ends (shared/node-contracts.ts). */
  carries: boolean;
  /** True for a plain link, which carries nothing either way. */
  plain?: boolean;
  /** Terminal only: null while its PTY has not started or has exited. */
  ptyId?: number | null;
  terminalType?: string | null;
  worktreePath?: string | null;
}

export interface WireSender {
  id: string;
  title: string;
}

export interface WireMessageDeps {
  /** The sender and everything wired to it, or null if it isn't on the canvas. */
  wiresOf: (terminalId: string) => Promise<{ sender: WireSender; ends: WireEnd[] } | null>;
  deliverToTerminal: (delivery: {
    terminalId: string;
    ptyId: number;
    terminalType: string;
    worktreePath: string;
    text: string;
  }) => Promise<{ ok: boolean; detail?: string }>;
  appendToNote: (noteId: string, source: string, text: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Writes the decision-record entry: who told which terminal what. */
  recordPrompt: (entry: { target: string; by: string; text: string }) => void;
  /** Lights the wire while the message travels. */
  pulse?: (event: { phase: "start" | "end"; requestId: string; targetKind: string; targetId: string; ok?: boolean; preview?: string }) => void;
  newId: () => string;
}

export interface WireDelivery {
  kind: WireEnd["kind"];
  id: string;
  ok: boolean;
  reason?: string;
}

/** Longest message accepted; well past any instruction, short of a file dump. */
export const MAX_WIRE_MESSAGE_LENGTH = 20_000;

/**
 * Labelled for an agent so it knows who is talking and can answer back along
 * the wire; without it the message reads as its user changing their mind. A
 * shell gets the text as-is, because it runs it: a prefix would become part
 * of the command.
 */
export function wireMessageText(message: string, sender: WireSender, terminalType: string): string {
  return findAgentAdapter(terminalType)
    ? `[From ${sender.title} (terminal ${sender.id}), over a wire on the canvas] ${message}`
    : message;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

function describe(end: WireEnd): string {
  return end.title ? `${end.title} (${end.kind} ${end.id})` : `${end.kind} ${end.id}`;
}

export async function sendAlongWires(
  deps: WireMessageDeps,
  senderId: string,
  body: unknown,
): Promise<{ ok: boolean; delivered: WireDelivery[] }> {
  const input = (body ?? {}) as Record<string, unknown>;
  const message = input.message;
  const to = input.to;

  if (typeof message !== "string" || message.trim() === "") {
    fail(400, "empty_message", "message is empty; nothing was sent.");
  }
  if (message.length > MAX_WIRE_MESSAGE_LENGTH) {
    fail(400, "message_too_long", `message is ${message.length} characters; the limit is ${MAX_WIRE_MESSAGE_LENGTH}. Put long content in a file and send its path.`);
  }
  if (to !== undefined && (typeof to !== "string" || to.trim() === "")) {
    fail(400, "invalid_to", "to must be a node id from list_nodes when given.");
  }

  const wires = await deps.wiresOf(senderId);
  if (!wires) fail(404, "not_on_canvas", "This terminal isn't on the open canvas.");
  const { sender, ends } = wires;

  let targets: WireEnd[];
  if (typeof to === "string") {
    const end = ends.find((e) => e.id === to);
    if (!end) {
      fail(403, "not_wired", `Nothing wired to you has the id "${to}". Ask the user to draw a wire from you to it on the canvas. list_nodes shows what you're wired to.`);
    }
    if (end.direction === "from_it") {
      fail(403, "wrong_direction", `The wire between you and ${describe(end)} runs the other way: it sends to you. Ask the user to turn the wire round or make it two-way.`);
    }
    if (end.plain) {
      fail(403, "wire_carries_nothing", `The wire to ${describe(end)} is a plain link: it records that you're related and carries nothing. Ask the user to make it live.`);
    }
    if (end.kind === "browser") {
      fail(403, "wire_carries_nothing", `${describe(end)} is a browser; it doesn't take messages. Read or drive it with the browser_* tools.`);
    }
    targets = [end];
  } else {
    targets = ends.filter((e) => e.direction !== "from_it" && e.carries);
    if (targets.length === 0) {
      const incoming = ends.filter((e) => e.direction === "from_it").length;
      fail(
        403,
        "not_wired",
        ends.length === 0
          ? "Nothing is wired to you. Ask the user to draw a wire from you to the node on the canvas."
          : incoming > 0
            ? "Every wire touching you runs the other way, into you. Ask the user to turn one round or make it two-way."
            : "None of the wires touching you carries messages: they are plain links, or lead to browsers, which you read and drive with the browser_* tools.",
      );
    }
  }

  const delivered: WireDelivery[] = [];
  const preview = message.replace(/\s+/g, " ").trim().slice(0, 80);
  for (const end of targets) {
    const requestId = deps.newId();
    deps.pulse?.({ phase: "start", requestId, targetKind: end.kind, targetId: end.id, preview });
    const result = await deliverOne(deps, sender, end, message);
    deps.pulse?.({ phase: "end", requestId, targetKind: end.kind, targetId: end.id, ok: result.ok });
    delivered.push(result);
  }
  return { ok: delivered.some((d) => d.ok), delivered };
}

async function deliverOne(
  deps: WireMessageDeps,
  sender: WireSender,
  end: WireEnd,
  message: string,
): Promise<WireDelivery> {
  const base = { kind: end.kind, id: end.id };
  if (end.kind === "browser") {
    return {
      ...base,
      ok: false,
      reason: "a browser doesn't take messages; read or drive it with the browser_* tools",
    };
  }
  if (end.kind === "note") {
    const appended = await deps.appendToNote(end.id, sender.title, message);
    return appended.ok ? { ...base, ok: true } : { ...base, ok: false, reason: appended.detail ?? "the note refused it" };
  }
  if (end.ptyId == null || !end.terminalType || !end.worktreePath) {
    return { ...base, ok: false, reason: "that terminal isn't running" };
  }
  const text = wireMessageText(message, sender, end.terminalType);
  const result = await deps.deliverToTerminal({
    terminalId: end.id,
    ptyId: end.ptyId,
    terminalType: end.terminalType,
    worktreePath: end.worktreePath,
    text,
  });
  if (!result.ok) return { ...base, ok: false, reason: result.detail ?? "the terminal refused the input" };
  deps.recordPrompt({ target: end.id, by: sender.id, text });
  return { ...base, ok: true };
}
