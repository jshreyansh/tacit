import { findAgentAdapter } from "../shared/agent-adapters";
import { MAX_ENVELOPE_LENGTH, envelopePreview, textForAgent } from "../shared/wire-envelope";
import { questionText } from "./wire-asks";
import { shouldTrack, trackingReason } from "../shared/wire-tracking";

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
  /** What the sender may do there (shared/node-contracts.ts): ask and
   * hand_off are checked against this. */
  can?: string[];
  /** Hydra tracking switch of the wire (shared/wire-tracking.ts). */
  track?: "off" | "auto" | "always";
  /** The Hydra role this end plays for the sender, if the wire gives one. */
  hydraRole?: string;
  /** Terminal only: null while its PTY has not started or has exited. */
  ptyId?: number | null;
  terminalType?: string | null;
  worktreePath?: string | null;
}

export interface WireSender {
  id: string;
  title: string;
  /** "agent" or "shell"; absent from older callers, treated as an agent. */
  role?: string;
}

export interface WireMessageDeps {
  /** The sender and everything wired to it, or null if it isn't on the canvas. */
  wiresOf: (terminalId: string) => Promise<{ sender: WireSender; ends: WireEnd[] } | null>;
  /** Types it into the terminal, or queues it for an agent that is
   * mid-turn; records it as a prompt when it is actually typed. */
  deliverToTerminal: (delivery: {
    terminalId: string;
    ptyId: number;
    terminalType: string;
    worktreePath: string;
    text: string;
  }) => Promise<{ ok: boolean; detail?: string; queued?: boolean; waiting?: number }>;
  appendToNote: (noteId: string, source: string, text: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Lights the wire while the message travels. */
  pulse?: (event: { phase: "start" | "end"; requestId: string; targetKind: string; targetId: string; ok?: boolean; preview?: string }) => void;
  newId: () => string;
}

export interface WireDelivery {
  kind: WireEnd["kind"];
  id: string;
  ok: boolean;
  reason?: string;
  /** The agent was mid-turn: the message arrives when the turn ends. */
  queued?: boolean;
  /** How many messages are waiting for it, this one included. */
  waiting?: number;
}

/** Longest message accepted; well past any instruction, short of a file dump. */
export const MAX_WIRE_MESSAGE_LENGTH = MAX_ENVELOPE_LENGTH;

/**
 * Labelled for an agent so it knows who is talking and can answer back along
 * the wire; without it the message reads as its user changing their mind. A
 * shell gets the text as-is, because it runs it: a prefix would become part
 * of the command.
 */
export function wireMessageText(message: string, sender: WireSender, terminalType: string): string {
  return findAgentAdapter(terminalType)
    ? textForAgent({ from: { kind: "terminal", id: sender.id, title: sender.title, role: "agent" }, payload: "text", body: message, hop: 0 })
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
  const preview = envelopePreview(message);
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
  return result.queued
    ? { ...base, ok: true, queued: true, waiting: result.waiting }
    : { ...base, ok: true };
}

/**
 * One node named with `to` that the sender may reach with `ability`, or a
 * refusal that says what to ask the user for. Shared by ask and hand_off,
 * which always go to one node, never to everything wired.
 */
function oneTarget(ends: WireEnd[], to: unknown, ability: "ask" | "hand_off"): WireEnd {
  if (typeof to !== "string" || to.trim() === "") {
    fail(400, "invalid_to", "to is required: the id of the agent you're wired to, from list_nodes.");
  }
  const end = ends.find((e) => e.id === to);
  if (!end) {
    fail(403, "not_wired", `Nothing wired to you has the id "${to}". Ask the user to draw a wire from you to it on the canvas. list_nodes shows what you're wired to.`);
  }
  if (end.direction === "from_it") {
    fail(403, "wrong_direction", `The wire between you and ${describe(end)} runs the other way: it reaches you, you can't start anything there. Ask the user to turn the wire round or make it two-way.`);
  }
  if (end.plain) {
    fail(403, "wire_carries_nothing", `The wire to ${describe(end)} is a plain link: it records that you're related and carries nothing. Ask the user to make it live.`);
  }
  if (!(end.can ?? []).includes(ability)) {
    fail(403, "not_an_agent", `${describe(end)} isn't an agent, so it can't be ${ability === "ask" ? "asked" : "handed work"}. Use send_to_connected to send it a message.`);
  }
  if (end.ptyId == null || !end.terminalType || !end.worktreePath) {
    fail(409, "not_running", `${describe(end)} isn't running.`);
  }
  return end;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(400, "empty_message", `${field} is empty; nothing was sent.`);
  if (value.length > MAX_WIRE_MESSAGE_LENGTH) {
    fail(400, "message_too_long", `${field} is ${value.length} characters; the limit is ${MAX_WIRE_MESSAGE_LENGTH}. Put long content in a file and send its path.`);
  }
  return value;
}

export interface AskDeliveryDeps extends Pick<WireMessageDeps, "wiresOf" | "pulse" | "newId"> {
  /** Like deliverToTerminal, with the ask attached so its answer can be
   * routed once it has been typed in. */
  deliverQuestion: (delivery: {
    terminalId: string;
    ptyId: number;
    terminalType: string;
    worktreePath: string;
    text: string;
    ask: { id: string; askerId: string; askerTitle: string; targetTitle: string; question: string } | null;
  }) => Promise<{ ok: boolean; detail?: string; queued?: boolean; waiting?: number }>;
  /** Whether this kind of agent's reply can be read back from its transcript. */
  answersComeBack: (terminalType: string) => boolean;
}

/** Backs the ask MCP tool: a question whose answer comes back to the asker. */
export async function askAlongWire(deps: AskDeliveryDeps, senderId: string, body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  const question = requireText(input.question, "question");
  const wires = await deps.wiresOf(senderId);
  if (!wires) fail(404, "not_on_canvas", "This terminal isn't on the open canvas.");
  // The answer is typed into the asker. Typed into a shell it would run as a
  // command, whatever the other agent wrote.
  if (wires.sender.role === "shell") {
    fail(403, "asker_is_a_shell", "A shell can't receive an answer: it would run it as a command. Use send_to_connected to send the message.");
  }
  const end = oneTarget(wires.ends, input.to, "ask");
  const comesBack = deps.answersComeBack(end.terminalType!);
  const id = deps.newId();
  const text = comesBack
    ? questionText(wires.sender, question)
    : wireMessageText(question, wires.sender, end.terminalType!);
  deps.pulse?.({ phase: "start", requestId: id, targetKind: "terminal", targetId: end.id, preview: envelopePreview(question) });
  const result = await deps.deliverQuestion({
    terminalId: end.id,
    ptyId: end.ptyId!,
    terminalType: end.terminalType!,
    worktreePath: end.worktreePath!,
    text,
    ask: comesBack
      ? { id, askerId: wires.sender.id, askerTitle: wires.sender.title, targetTitle: end.title ?? end.id, question }
      : null,
  });
  deps.pulse?.({ phase: "end", requestId: id, targetKind: "terminal", targetId: end.id, ok: result.ok });
  if (!result.ok) return { ok: false, reason: result.detail ?? "the terminal refused the input" };
  return {
    ok: true,
    ...(result.queued ? { queued: true, waiting: result.waiting } : {}),
    answer: comesBack
      ? `${describe(end)} has your question${result.queued ? " (it's busy, so it gets it when its current turn ends)" : ""}. Its answer will arrive in this terminal as a new message when it finishes; carry on meanwhile.`
      : `${describe(end)} has your question, but this kind of agent doesn't let Tacit read its answer, so it won't come back by itself.`,
  };
}

/** What the receiving agent is told when work is handed to it. */
export function handOffText(sender: WireSender, work: string): string {
  return `[Handed off by ${sender.title} (terminal ${sender.id}), over a wire on the canvas: ${sender.title} has stopped working on this, and it is yours to finish.] ${work}`;
}

export interface HandOffDeps extends Pick<WireMessageDeps, "wiresOf" | "deliverToTerminal" | "pulse" | "newId"> {
  /** Sets up a tracked hand-off (electron/tracked-handoff.ts) and returns
   * what the receiver is told about it, and why the wire's role couldn't be
   * given to it when it couldn't. */
  track: (input: { id: string; sender: WireSender; end: WireEnd; work: string; why: string }) => {
    notice: string;
    dir: string;
    roleProblem?: string;
  };
}

/** Backs the hand_off MCP tool: the sender is done; the receiver carries on. */
export async function handOffAlongWire(deps: HandOffDeps, senderId: string, body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  const work = requireText(input.work, "work");
  const wires = await deps.wiresOf(senderId);
  if (!wires) fail(404, "not_on_canvas", "This terminal isn't on the open canvas.");
  const end = oneTarget(wires.ends, input.to, "hand_off");
  const id = deps.newId();
  const signals = { changesCode: input.changes_code === true, typedResult: input.typed_result === true, role: end.hydraRole };
  const tracked = shouldTrack(end.track, signals)
    ? deps.track({ id, sender: wires.sender, end, work, why: trackingReason(end.track, signals) })
    : null;
  deps.pulse?.({ phase: "start", requestId: id, targetKind: "terminal", targetId: end.id, preview: envelopePreview(work) });
  const result = await deps.deliverToTerminal({
    terminalId: end.id,
    ptyId: end.ptyId!,
    terminalType: end.terminalType!,
    worktreePath: end.worktreePath!,
    text: tracked ? `${handOffText(wires.sender, work)}\n\n${tracked.notice}` : handOffText(wires.sender, work),
  });
  deps.pulse?.({ phase: "end", requestId: id, targetKind: "terminal", targetId: end.id, ok: result.ok });
  if (!result.ok) return { ok: false, reason: result.detail ?? "the terminal refused the input" };
  return {
    ok: true,
    ...(result.queued ? { queued: true, waiting: result.waiting } : {}),
    ...(tracked
      ? {
          tracked: true,
          why: trackingReason(end.track, signals),
          result_dir: tracked.dir,
          note: `${describe(end)} will write a report and a result; the outcome comes back to you as a new message. Carry on meanwhile.`,
          ...(tracked.roleProblem ? { role_problem: tracked.roleProblem } : {}),
        }
      : { tracked: false }),
  };
}
