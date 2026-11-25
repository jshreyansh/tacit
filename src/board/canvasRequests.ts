/** What agents ask to change on the canvas, for the window (electron/canvas-requests.ts keeps them). */
import { useMemo } from "react";
import { create } from "zustand";
import { requestVerb, type CanvasChange, type CanvasDecision, type CanvasRequest } from "../../shared/canvas-ops";
import { findTerminal } from "../actions/terminalLookup";
import { getTranslations } from "../i18n/useT";
import { useBoardStore } from "../stores/boardStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useNotificationStore } from "../stores/notificationStore";
import { openBoard } from "../tasks/taskActions";
import { activeWorkdesk, useTaskStore } from "../tasks/taskStore";
import type { BoardElement } from "../types/board";
import { buildChanges, type AgentAuthor } from "./agentDraw";
import { showDrawing } from "./agentOps";
import { canvasTiles, pictureOfElements } from "./boardForAgents";

interface CanvasRequestStore {
  requests: CanvasRequest[];
  answering: ReadonlySet<string>;
  /** The one whose card is open beside its drawing. */
  pin: string | null;
  /** The one to bring into view in Needs you. */
  shown: string | null;
}
export const useCanvasRequestStore = create<CanvasRequestStore>(() => ({ requests: [], answering: new Set(), pin: null, shown: null }));
export const setPin = (id: string | null): void => useCanvasRequestStore.setState({ pin: id });

/** Its home: Needs you, on the board. The same on the canvas and in the grid. */
export function openCanvasRequest(id: string): void {
  useTaskStore.getState().open(null);
  // Nothing you'd narrowed the board to hides it.
  useTaskStore.setState({ composing: null, query: "", folder: null });
  useCanvasRequestStore.setState({ shown: id });
  openBoard();
}
/** The drawing it's about, with its card open beside it. */
export function showCanvasRequest(r: CanvasRequest): void {
  setPin(r.id);
  showDrawing(r.targets[0]);
}
/** The agents waiting on one, for the marks beside their names. */
export function useWaitingAgents(): ReadonlySet<string> {
  const requests = useCanvasRequests();
  return useMemo(() => new Set(requests.map((x) => x.terminalId)), [requests]);
}

let started = false;

function take(list: CanvasRequest[]): void {
  useCanvasRequestStore.setState((x) => ({ requests: list, pin: list.some((r) => r.id === x.pin) ? x.pin : null, shown: list.some((r) => r.id === x.shown) ? x.shown : null }));
  // Its agent was closed: nobody's waiting for the answer.
  for (const r of list) if (r.workdesk === activeWorkdesk() && !findTerminal(r.terminalId)) void window.tacit.canvasRequests.drop(r.id);
}

export function startCanvasRequests(): () => void {
  if (started || !window.tacit?.canvasRequests) return () => {};
  started = true;
  void window.tacit.canvasRequests.list().then(take);
  void window.tacit.canvasRequests.unread().then((unread) => {
    if (unread) useNotificationStore.getState().notify("warn", getTranslations().canvas_ask_unread);
  });
  const off = window.tacit.canvasRequests.onChanged(take);
  return () => {
    started = false;
    off();
  };
}

/** Waiting on this workdesk, whose drawings are all here. */
export function useCanvasRequests(terminalId?: string): CanvasRequest[] {
  const requests = useCanvasRequestStore((s) => s.requests);
  const workdesk = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useMemo(() => requests.filter((r) => r.workdesk === workdesk && (!terminalId || r.terminalId === terminalId)), [requests, workdesk, terminalId]);
}

export async function answerCanvasRequest(id: string, decision: CanvasDecision, note?: string): Promise<void> {
  if (useCanvasRequestStore.getState().answering.has(id)) return;
  useCanvasRequestStore.setState((s) => ({ answering: new Set([...s.answering, id]) }));
  try {
    const done = await window.tacit.canvasRequests.answer(id, decision, note);
    if (!done.ok) useNotificationStore.getState().notify("warn", done.error);
  } catch (err) {
    useNotificationStore.getState().notify("error", err instanceof Error ? err.message : String(err));
  } finally {
    useCanvasRequestStore.setState((s) => ({ answering: new Set([...s.answering].filter((x) => x !== id)) }));
  }
}

const authorOf = (r: CanvasRequest): AgentAuthor => ({ kind: "agent", agent: r.agent, name: r.name, terminalId: r.terminalId });

/** The drawings as they are and as they'd be; null when there's nothing left to change. */
export function beforeAndAfter(r: CanvasRequest): { before: string; after: string | null } | null {
  const elements = useBoardStore.getState().elements;
  const shown = elements.filter((e) => r.targets.includes(e.id));
  if (!shown.length) return null;
  const near = around(shown, elements);
  const before = pictureOfElements(near);
  if (!before) return null;
  if (r.kind === "delete") return { before, after: null };
  const made = buildChanges(r.changes ?? [], { elements, tiles: canvasTiles(), author: authorOf(r) }, new Set(r.targets));
  if (!("patches" in made)) return { before, after: null };
  const after = near.map((e) => (made.patches[e.id] ? ({ ...e, ...made.patches[e.id] } as BoardElement) : e));
  return { before, after: pictureOfElements(after, elements.map((e) => (made.patches[e.id] ? ({ ...e, ...made.patches[e.id] } as BoardElement) : e))) };
}
/** With what a container holds. */
function around(shown: BoardElement[], elements: readonly BoardElement[]): BoardElement[] {
  const ids = new Set(shown.map((e) => e.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of elements)
      if (e.parent && ids.has(e.parent) && !ids.has(e.id)) {
        ids.add(e.id);
        grew = true;
      }
  }
  return elements.filter((e) => ids.has(e.id));
}

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};
const wordsOn = (e: BoardElement): string => (e.type === "section" || e.type === "frame" ? e.title : e.type === "arrow" ? (e.label ?? "") : e.type === "pen" ? "" : e.text);

/** Only words, on something whose words are too small to see in a picture of it. */
export function onlyWords(r: CanvasRequest): boolean {
  if (r.kind !== "change") return false;
  const elements = useBoardStore.getState().elements;
  return (r.changes ?? []).every((c) => {
    const e = elements.find((x) => x.id === c.id);
    return Object.keys(c).every((k) => k === "id" || k === "text") && (e?.type === "section" || e?.type === "frame" || e?.type === "arrow");
  });
}

/** What it wants, as a verb: to rename, to delete, to change. */
export const wantsTo = (r: CanvasRequest): "rename" | "delete" | "change" => requestVerb(r);

/** What would change, in a few words each. */
export function changeWords(r: CanvasRequest): string[] {
  const t = getTranslations();
  if (r.kind === "delete") return [t.canvas_ask_delete];
  const elements = useBoardStore.getState().elements;
  return (r.changes ?? [])
    .filter((c) => r.targets.includes(c.id))
    .flatMap((c: CanvasChange) => {
      const e = elements.find((x) => x.id === c.id);
      const out: string[] = [];
      if (c.text !== undefined) out.push(t.canvas_ask_rename(short(e ? wordsOn(e) : ""), short(c.text)));
      if (c.x !== undefined || c.y !== undefined) out.push(t.canvas_ask_move);
      if (c.w !== undefined || c.h !== undefined) out.push(t.canvas_ask_resize);
      if (c.color) out.push(t.canvas_ask_color(c.color));
      if (c.size) out.push(t.canvas_ask_size(c.size));
      if (c.fill || c.dashed !== undefined || c.align || c.route || c.heads) out.push(t.canvas_ask_look);
      if (c.from || c.to) out.push(t.canvas_ask_join);
      return e ? out : [];
    })
    .filter((w, i, all) => all.indexOf(w) === i)
    .slice(0, 5);
}
