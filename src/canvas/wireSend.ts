import { MAX_ENVELOPE_LENGTH, envelopePreview } from "../../shared/wire-envelope";
import { payloadsOver, type PayloadKind } from "../../shared/node-contracts";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { usePinStore } from "../stores/pinStore";
import { useBridgeActivityStore } from "../stores/bridgeActivityStore";
import type { ConnectionData, ConnectionEndpoint } from "../stores/connectionStore";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { updateBrowserCardInScene } from "../actions/sceneCardActions";
import { driveBrowserCard } from "../browser/driveBrowserCard";
import { appendToNote } from "../browser/chatReplyDelivery";
import { endpointRole, nodeTitle } from "./wireEnds";

/**
 * Send, on a wire's panel: the user passing what a node holds along a wire,
 * the copy and paste the wire exists to replace. A page's text, what is
 * selected in it or its address; a note's or a task's text.
 *
 * Follows the wire's direction like everything else: only the tail sends
 * (or either end of a two-way wire), and only what the other end accepts.
 */

/** The payloads this build can produce and the head can take, from `from`. */
export function sendChoices(connection: ConnectionData, from: ConnectionEndpoint): PayloadKind[] {
  const to =
    connection.from.kind === from.kind && connection.from.id === from.id ? connection.to : connection.from;
  const fromRole = endpointRole(from);
  const toRole = endpointRole(to);
  const choices = payloadsOver(connection, from, fromRole, toRole).filter((payload) => {
    if (fromRole === "browser") return payload === "page" || payload === "selection" || payload === "url";
    if (fromRole === "note" || fromRole === "task") return payload === "text";
    // An agent's reply goes along a wire by itself (ask, or a reply rule);
    // a shell's output has no clean end to send.
    return false;
  });
  // A page takes an address and nothing else from here: text typed into a
  // page goes through the reply rule's chat-box delivery instead.
  return toRole === "browser" ? choices.filter((payload) => payload === "url") : choices;
}

async function bodyFor(from: ConnectionEndpoint, payload: PayloadKind): Promise<string> {
  if (from.kind === "browser") {
    const card = useBrowserCardStore.getState().cards[from.id];
    if (!card) throw new Error("That browser is gone.");
    if (payload === "url") return card.url;
    if (payload === "selection") {
      const data = (await driveBrowserCard(from.id, "eval", { script: "String(window.getSelection() ?? '')" }, "user")) as { result?: unknown };
      const text = typeof data?.result === "string" ? data.result.trim() : "";
      if (!text) throw new Error("Nothing is selected on the page.");
      return text;
    }
    const data = (await driveBrowserCard(from.id, "read", {}, "user")) as { url?: string; title?: string; text?: string };
    return [data.title, data.url, "", data.text ?? ""].filter((line) => line !== undefined).join("\n").trim();
  }
  if (from.kind === "note") {
    const pin = Object.values(usePinStore.getState().pinsByProject).flat().find((p) => p.id === from.id);
    if (!pin) throw new Error("That note is gone.");
    return [pin.title, pin.body].filter(Boolean).join("\n\n").trim();
  }
  throw new Error("A terminal sends with its own tools.");
}

export type SendOutcome =
  | { ok: true; queued?: boolean; waiting?: number }
  | { ok: false; detail: string };

export async function sendOverWire(
  connection: ConnectionData,
  from: ConnectionEndpoint,
  payload: PayloadKind,
  /** Said before the content, e.g. that a note is standing context. */
  lead?: string,
): Promise<SendOutcome> {
  if (!sendChoices(connection, from).includes(payload)) {
    return { ok: false, detail: "This wire doesn't carry that from here." };
  }
  const to =
    connection.from.kind === from.kind && connection.from.id === from.id ? connection.to : connection.from;
  let body: string;
  try {
    body = await bodyFor(from, payload);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!body) return { ok: false, detail: "There is nothing to send." };
  if (lead) body = `${lead}\n\n${body}`;
  if (body.length > MAX_ENVELOPE_LENGTH) body = body.slice(0, MAX_ENVELOPE_LENGTH);

  const requestId = crypto.randomUUID();
  const activity = useBridgeActivityStore.getState();
  activity.startConnectionEvent(requestId, "message", from, to, envelopePreview(body));
  const outcome = await deliver(from, to, payload, body);
  activity.endConnectionEvent(requestId, from, to, outcome.ok);
  return outcome;
}

async function deliver(
  from: ConnectionEndpoint,
  to: ConnectionEndpoint,
  payload: PayloadKind,
  body: string,
): Promise<SendOutcome> {
  const title = nodeTitle(from.kind, from.id) ?? from.id;
  if (to.kind === "browser") {
    updateBrowserCardInScene(to.id, { url: body.trim() });
    return { ok: true };
  }
  if (to.kind === "note") {
    const appended = await appendToNote(to.id, title, body);
    return appended.ok ? { ok: true } : { ok: false, detail: appended.detail };
  }
  const found = findTerminal(to.id);
  const ptyId = getLivePtyId(to.id);
  if (!found || ptyId == null) return { ok: false, detail: "That terminal isn't running." };
  const result = await window.tacit.wires.sendToTerminal({
    target: {
      terminalId: to.id,
      ptyId,
      terminalType: found.terminal.type,
      worktreePath: found.worktree.path,
    },
    envelope: { from: { kind: from.kind, id: from.id, title, role: endpointRole(from) }, payload, body },
  });
  return result.ok
    ? { ok: true, queued: result.queued, waiting: result.waiting }
    : { ok: false, detail: result.detail ?? "The terminal didn't take it." };
}
