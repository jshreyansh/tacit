/**
 * The window's way to what agents ask to change on the canvas. Only the app's
 * own window, every argument checked; a request is named by its id and what it
 * asks for stays here, so the window can't put another change in its place.
 */
import type { IpcMainInvokeEvent } from "electron";
import type { CanvasRequest } from "../shared/canvas-ops";
import type { CanvasRequests } from "./canvas-requests";

interface Deps {
  handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
  allowed: (event: IpcMainInvokeEvent) => boolean;
  requests: CanvasRequests;
  apply: (request: CanvasRequest, always: boolean) => Promise<{ text: string } | { error: string }>;
  /** Into the agent's terminal or chat, when its turn is over. */
  tell: (terminalId: string, text: string) => Promise<void>;
}

const id = (v: unknown): string | null => (typeof v === "string" && /^cr-\d{1,12}$/.test(v) ? v : null);

export const answerWords = (r: Pick<CanvasRequest, "id" | "kind" | "titles">, outcome: { text: string } | { error: string } | { denied: string | null }): string => {
  const names = r.titles.slice(0, 3).map((t) => JSON.stringify(t)).join(", ");
  const about = `[Canvas] Your request ${r.id} to ${r.kind} ${names}`;
  if ("denied" in outcome) return `${about}: the user said no.${outcome.denied ? ` They said: ${JSON.stringify(outcome.denied)}` : ""} Nothing was changed. Don't ask for the same thing again.`;
  if ("error" in outcome) return `${about}: the user allowed it, but it couldn't be done. ${outcome.error}`;
  return `${about}: the user allowed it, and it's done. ${outcome.text}`;
};

export function registerCanvasIpc({ handle, allowed, requests, apply, tell }: Deps): void {
  /** Being answered: a second press does nothing. */
  const answering = new Set<string>();
  handle("canvas-requests:list", (event) => (allowed(event) ? requests.all() : []));
  handle("canvas-requests:answer", async (event, rawId, decision, rawNote) => {
    const which = id(rawId);
    if (!allowed(event) || !which || (decision !== "once" && decision !== "always" && decision !== "deny")) return { ok: false, error: "Not allowed" };
    const note = typeof rawNote === "string" ? rawNote.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
    const request = requests.get(which);
    if (!request || answering.has(which)) return { ok: false, error: "That's already been answered." };
    answering.add(which);
    try {
      const outcome = decision === "deny" ? { denied: note || null } : await apply(request, decision === "always");
      requests.remove(which);
      await tell(request.terminalId, answerWords(request, outcome)).catch((err) => console.warn("[canvas-requests] couldn't tell the agent:", err));
      return "error" in outcome ? { ok: false, error: outcome.error } : { ok: true };
    } finally {
      answering.delete(which);
    }
  });
  // Its agent is gone: there's nobody to answer.
  handle("canvas-requests:drop", (event, rawId) => {
    const which = id(rawId);
    if (allowed(event) && which && !answering.has(which)) requests.remove(which);
  });
}
