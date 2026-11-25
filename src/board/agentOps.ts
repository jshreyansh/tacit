/**
 * Agents' drawings put on the board (docs/architecture/workdesk-board.md,
 * "Agents draw"). Your undo history isn't theirs: what an agent does goes into
 * every step of it, so ⌘Z undoes only what you did, and each thing an agent
 * did has its own Undo. Main has checked the request and whose it is.
 */
import { create } from "zustand";
import type { CanvasAsk, CanvasChange, CanvasDraw, CanvasRequest } from "../../shared/canvas-ops";
import { getTranslations } from "../i18n/useT";
import { findTerminal } from "../actions/terminalLookup";
import { agentNames, agentsIn } from "../tasks/agentNames";
import { activeWorkdesk } from "../tasks/taskStore";
import { boardId, useBoardStore } from "../stores/boardStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useFileTileStore } from "../stores/fileTileStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore } from "../stores/selectionStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import type { BoardAgentAccess, BoardElement, BoardRect } from "../types/board";
import { flyToBounds } from "../utils/panToTerminal";
import { buildChanges, buildDelete, buildDrawing, drawnWords, shifted, type AgentAuthor } from "./agentDraw";
import { accessOf } from "./boardAccess";
import { canvasTiles } from "./boardForAgents";
import { drawingName } from "./boardRead";
import { useBoardDraft } from "./boardDraft";
import { rerouteBroken } from "./boardReroute";
import { bounds, cssColor } from "./boardModel";
import { boardTargetLookup } from "./boardTargets";

export interface AgentOp {
  id: string;
  kind: "draw" | "change" | "delete";
  workdesk: string | null;
  terminalId: string;
  name: string;
  title: string;
  /** What Show goes to. */
  focus: string | null;
  added: string[];
  files: string[];
  /** Changed and deleted things, as they were. */
  before: BoardElement[];
  undone: boolean;
}

interface AgentCursor {
  key: string;
  name: string;
  color: string;
  stops: Array<{ x: number; y: number; at: number }>;
  total: number;
}

interface AgentOps {
  ops: AgentOp[];
  cursors: AgentCursor[];
  /** When it appears after being drawn, in ms: pieces come one at a time. */
  delays: Record<string, number>;
}

export const useAgentOps = create<AgentOps>(() => ({ ops: [], cursors: [], delays: {} }));

const OPS_KEPT = 60;
/** How many drawings one agent may have on a workdesk. */
const OWN_MAX = 2_000;
const CURSOR_COLORS: Record<string, string> = { claude: "clay", codex: "violet", opencode: "teal", gemini: "blue", antigravity: "blue" };

function authorOf(terminalId: string): AgentAuthor {
  const found = findTerminal(terminalId);
  if (!found) throw new Error("That terminal isn't on this workdesk.");
  const t = found.terminal;
  return { kind: "agent", agent: t.type, name: t.customTitle?.trim() || agentNames(agentsIn(useProjectStore.getState().projects)).get(t.id) || t.title, terminalId };
}

/** Into the board and every step of your history alike. */
function amend(change: (elements: BoardElement[]) => BoardElement[]): void {
  useBoardStore.setState((s) => ({
    elements: change(s.elements),
    undoStack: s.undoStack.map((x) => ({ ...x, elements: change(x.elements) })),
    redoStack: s.redoStack.map((x) => ({ ...x, elements: change(x.elements) })),
  }));
  // Saved with the board.
  useBoardStore.getState().patch({});
}

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Pieces come one at a time, with the agent's cursor at each. */
function animate(drawn: BoardElement[], author: AgentAuthor): void {
  const now = performance.now();
  const step = calm() ? 0 : Math.max(35, Math.min(160, 2_800 / Math.max(1, drawn.length)));
  const lookup = boardTargetLookup();
  const delays = Object.fromEntries(drawn.map((e, i) => [e.id, Math.round(i * step)]));
  useAgentOps.setState((s) => ({ delays: { ...s.delays, ...delays } }));
  useBoardStore.setState((s) => ({ bornAt: { ...s.bornAt, ...Object.fromEntries(drawn.map((e) => [e.id, now + delays[e.id]])) } }));
  if (step === 0) return;
  const stops = drawn.map((e) => {
    const b = bounds(e, lookup);
    return { x: b.x + b.w * 0.75, y: b.y + b.h * 0.75, at: delays[e.id] };
  });
  const cursor: AgentCursor = { key: boardId("cur"), name: author.name, color: cssColor(CURSOR_COLORS[author.agent] ?? "ink"), stops, total: drawn.length * step + 900 };
  useAgentOps.setState((s) => ({ cursors: [...s.cursors, cursor] }));
}
export const cursorDone = (key: string): void => useAgentOps.setState((s) => ({ cursors: s.cursors.filter((c) => c.key !== key) }));

function remember(op: Omit<AgentOp, "id" | "workdesk" | "undone">): AgentOp {
  const made: AgentOp = { ...op, id: boardId("op"), workdesk: activeWorkdesk(), undone: false };
  useAgentOps.setState((s) => ({ ops: [...s.ops, made].slice(-OPS_KEPT) }));
  return made;
}

function inView(r: BoardRect): boolean {
  if (useWorkdeskViewStore.getState().mode === "grid") return false;
  const { viewport: v } = useCanvasStore.getState();
  const x = r.x * v.scale + v.x;
  const y = r.y * v.scale + v.y;
  return x < window.innerWidth && y < window.innerHeight && x + r.w * v.scale > 0 && y + r.h * v.scale > 0;
}

/** One notice an agent: the latest thing it did. */
const notices = new Map<string, string>();
export const drawingInView = (id: string): boolean => {
  const at = rectOf(id);
  return at !== null && inView(at);
};
function tell(op: AgentOp): void {
  const found = findTerminal(op.terminalId);
  const at = op.focus ? rectOf(op.focus) : null;
  // In a chat it's a card there; a notice only when you can't see it happen.
  if (found?.terminal.chatMode && (!at || inView(at))) return;
  const t = getTranslations();
  const { notify, dismiss } = useNotificationStore.getState();
  const last = notices.get(op.terminalId);
  if (last) dismiss(last);
  const id = notify("info", t.agent_canvas_notice(op.name, op.kind, op.title), undefined, t.agent_canvas_label, {
    actions: [
      ...(op.focus ? [{ label: t.agent_canvas_show, run: () => showDrawing(op.focus!) }] : []),
      {
        label: t.agent_canvas_undo,
        run: () => {
          undoAgentOp(op.id);
          dismiss(id);
        },
      },
    ],
  });
  notices.set(op.terminalId, id);
}

/** You're typing in it, or have it in hand. */
function inHand(ids: readonly string[]): boolean {
  const { editingId } = useBoardStore.getState();
  if (editingId && ids.includes(editingId)) return true;
  const draft = useBoardDraft.getState();
  if (draft.resizing && ids.includes(draft.resizing)) return true;
  return draft.dragging && useSelectionStore.getState().selectedItems.some((i) => i.type === "annotation" && ids.includes(i.annotationId));
}
const BUSY = { error: "The user is editing that right now. Try again in a little while." };

export function agentDraws(terminalId: string, req: CanvasDraw): { text: string } | { error: string } {
  const author = authorOf(terminalId);
  const elements = useBoardStore.getState().elements;
  const own = elements.filter((e) => e.author?.kind === "agent" && e.author.terminalId === terminalId).length;
  if (own + req.items.length > OWN_MAX) return { error: `You have ${own} drawings on this canvas, and the most is ${OWN_MAX}. Delete some first with delete_drawing.` };
  if (req.into && inHand([req.into])) return BUSY;
  const made = buildDrawing(req, { elements, tiles: canvasTiles(), author, newId: boardId });
  if ("error" in made) return made;
  const there = new Set(elements.map((e) => e.id));
  const changed = made.elements.filter((e) => there.has(e.id));
  const added = made.elements.filter((e) => !there.has(e.id));
  const before = elements.filter((e) => changed.some((c) => c.id === e.id));
  // Added to a frame you've since moved (or will have, when you undo that): it goes where the frame is.
  const grown = changed[0] as (BoardElement & BoardRect) | undefined;
  amend((els) => {
    const at = grown && (els.find((e) => e.id === grown.id) as (BoardElement & BoardRect) | undefined);
    const was = grown && (before[0] as BoardElement & BoardRect);
    const dx = was && at ? at.x - was.x : 0;
    const dy = was && at ? at.y - was.y : 0;
    const placed = dx || dy ? added.map((e) => (e.parent ? shifted(e, dx, dy) : e)) : added;
    return [...els.map((e) => (grown && e.id === grown.id ? ({ ...e, x: grown.x + dx, y: grown.y + dy, w: grown.w, h: grown.h } as BoardElement) : e)), ...placed];
  });
  const files = made.files.map((f) => {
    const was = Object.values(useFileTileStore.getState().tiles).find((t) => t.path === f.path);
    const id = useFileTileStore.getState().add(f.path, { x: f.x, y: f.y, w: f.w, h: f.h });
    if (was) made.notes.push(`${f.path.split("/").pop()} was already on the canvas (id ${id}).`);
    return { id, fresh: !was };
  });
  animate(added, author);
  const focus = made.frame ?? added.find((e) => e.type !== "arrow")?.id ?? files[0]?.id ?? null;
  const title = req.title ?? "";
  tell(remember({ kind: "draw", terminalId, name: author.name, title, focus, added: added.map((e) => e.id), files: files.filter((f) => f.fresh).map((f) => f.id), before }));
  return { text: drawnWords(made, req.title, files.map((f) => f.id)) };
}

/** Done, refused, or waiting on the user's yes. */
type Outcome = { text: string } | { error: string } | { ask: CanvasAsk };

/** While you're editing a thing, an agent's change to it waits, so nothing you type is lost. */
async function notInHand(ids: () => readonly string[], most: number): Promise<boolean> {
  const until = performance.now() + most;
  while (inHand(ids())) {
    if (performance.now() > until) return false;
    await new Promise((done) => window.setTimeout(done, 300));
  }
  return true;
}
const EDIT_WAIT = 20_000;

function asking(author: AgentAuthor, what: { targets: string[]; titles: string[] }, more: Pick<CanvasAsk, "kind" | "changes" | "ids">): { ask: CanvasAsk } {
  return { ask: { workdesk: activeWorkdesk(), terminalId: author.terminalId, name: author.name, agent: author.agent, ...more, ...what } };
}

export async function agentChanges(terminalId: string, changes: CanvasChange[], allowed: string[] = []): Promise<Outcome> {
  const author = authorOf(terminalId);
  const work = () => buildChanges(changes, { elements: useBoardStore.getState().elements, tiles: canvasTiles(), author }, new Set(allowed));
  const first = work();
  if ("error" in first) return first;
  if ("ask" in first) return asking(author, first.ask, { kind: "change", changes });
  if (!(await notInHand(() => Object.keys(first.patches), EDIT_WAIT))) return BUSY;
  // What you were doing may have changed it.
  const made = work();
  if ("error" in made) return made;
  if ("ask" in made) return asking(author, made.ask, { kind: "change", changes });
  const before = useBoardStore.getState().elements.filter((e) => made.patches[e.id]);
  amend((els) => els.map((e) => (made.patches[e.id] ? ({ ...e, ...made.patches[e.id] } as BoardElement) : e)));
  rerouteBroken();
  const op = remember({ kind: "change", terminalId, name: author.name, title: before.length === 1 ? drawingName(before[0]) : "", focus: changes[0].id, added: [], files: [], before });
  tell(op);
  return { text: [`Changed ${changes.length === 1 ? "it" : `${changes.length} drawings`} (${op.id}).`, ...(made.notes.length ? [`Worth a look: ${made.notes.join(" ")}`] : [])].join("\n") };
}

export async function agentDeletes(terminalId: string, ids: string[], allowed: string[] = []): Promise<Outcome> {
  const author = authorOf(terminalId);
  const work = () => buildDelete(ids, { elements: useBoardStore.getState().elements, tiles: canvasTiles(), author }, new Set(allowed));
  const first = work();
  if ("error" in first) return first;
  if ("ask" in first) return asking(author, first.ask, { kind: "delete", ids });
  if (!(await notInHand(() => first.ids, EDIT_WAIT))) return BUSY;
  const made = work();
  if ("error" in made) return made;
  if ("ask" in made) return asking(author, made.ask, { kind: "delete", ids });
  const elements = useBoardStore.getState().elements;
  const gone = new Set(made.ids);
  const own = (e: BoardElement) => e.author?.kind === "agent" && e.author.terminalId === terminalId;
  // Its arrows on them go too. Others' stay, drawn to where they were.
  for (const e of elements) if (e.type === "arrow" && own(e) && [e.a, e.b].some((end) => "ref" in end && gone.has(end.ref))) gone.add(e.id);
  const lookup = boardTargetLookup();
  const at = new Map(elements.filter((e) => gone.has(e.id)).map((e) => [e.id, bounds(e, lookup)]));
  const loose = (els: BoardElement[]) =>
    els
      .filter((e) => !gone.has(e.id))
      .map((e) => {
        if (e.type === "arrow") {
          const end = (x: typeof e.a) => {
            const r = "ref" in x ? at.get(x.ref) : undefined;
            return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : x;
          };
          const a = end(e.a);
          const b = end(e.b);
          if (a !== e.a || b !== e.b) return { ...e, a, b };
        }
        return e.parent && gone.has(e.parent) ? ({ ...e, parent: undefined } as BoardElement) : e;
      });
  const next = loose(elements);
  const touched = elements.filter((e) => gone.has(e.id) || next.find((x) => x.id === e.id) !== e);
  amend(loose);
  useSelectionStore.setState((s) => ({ selectedItems: s.selectedItems.filter((i) => i.type !== "annotation" || !gone.has(i.annotationId)) }));
  const op = remember({ kind: "delete", terminalId, name: author.name, title: touched.length === 1 ? drawingName(touched[0]) : "", focus: null, added: [], files: [], before: touched });
  tell(op);
  return { text: `Deleted ${gone.size === 1 ? "it" : `${gone.size} drawings`} (${op.id}).` };
}

/** You said yes to what an agent asked; `always` also lets agents change those drawings from here on. */
export async function applyCanvasRequest(req: CanvasRequest, always: boolean): Promise<{ text: string } | { error: string }> {
  if (always && req.kind === "change") setAccess(req.targets, "edit");
  const done = req.kind === "change" ? await agentChanges(req.terminalId, req.changes ?? [], req.targets) : await agentDeletes(req.terminalId, req.ids ?? [], req.targets);
  // It was about more than you were shown: the canvas has changed since.
  return "ask" in done ? { error: "What it asked to change isn't the same any more. Ask again." } : done;
}

/** Who may change these drawings. Yours to undo. */
export function setAccess(ids: readonly string[], agents: BoardAgentAccess): void {
  const board = useBoardStore.getState();
  const changes = Object.fromEntries(board.elements.filter((e) => ids.includes(e.id) && accessOf(e, board.elements) !== agents).map((e) => [e.id, { agents }]));
  if (!Object.keys(changes).length) return;
  board.checkpoint();
  board.patch(changes);
}

/** Takes back one thing an agent did. Yours to undo in turn, with ⌘Z. */
export function undoAgentOp(id: string): void {
  const op = useAgentOps.getState().ops.find((o) => o.id === id);
  const t = getTranslations();
  if (!op || op.undone) return;
  if (op.workdesk !== activeWorkdesk()) {
    useNotificationStore.getState().notify("info", t.agent_canvas_elsewhere);
    return;
  }
  const board = useBoardStore.getState();
  board.checkpoint();
  const was = new Map(op.before.map((e) => [e.id, e]));
  const gone = new Set(op.added);
  useBoardStore.setState((s) => {
    const kept = s.elements.filter((e) => !gone.has(e.id) && !(e.type === "arrow" && [e.a, e.b].some((end) => "ref" in end && gone.has(end.ref))));
    const here = new Set(kept.map((e) => e.id));
    const back = op.kind === "delete" ? op.before.filter((e) => !here.has(e.id)) : [];
    return { elements: [...kept.map((e) => was.get(e.id) ?? (e.parent && gone.has(e.parent) ? ({ ...e, parent: undefined } as BoardElement) : e)), ...back] };
  });
  board.patch({});
  for (const file of op.files) useFileTileStore.getState().remove(file);
  useSelectionStore.setState((s) => ({ selectedItems: s.selectedItems.filter((i) => i.type !== "annotation" || !gone.has(i.annotationId)) }));
  useAgentOps.setState((s) => ({ ops: s.ops.map((o) => (o.id === id ? { ...o, undone: true } : o)), cursors: [] }));
}

function rectOf(id: string): BoardRect | null {
  const e = useBoardStore.getState().elements.find((x) => x.id === id);
  return e ? bounds(e, boardTargetLookup()) : (useFileTileStore.getState().tiles[id] ?? null);
}

/** Takes you to a drawing, which comes in again as you arrive. Not selected: its options would cover it. */
export function showDrawing(id: string): void {
  const rect = rectOf(id);
  if (!rect) {
    useNotificationStore.getState().notify("info", getTranslations().agent_canvas_gone);
    return;
  }
  if (useWorkdeskViewStore.getState().mode === "grid") useWorkdeskViewStore.getState().setMode("canvas");
  useCanvasPageStore.getState().close();
  useSelectionStore.setState({ selectedItems: [] });
  useAgentOps.setState((s) => ({ delays: { ...s.delays, [id]: 450 } }));
  useBoardStore.setState((s) => ({ bornAt: { ...s.bornAt, [id]: performance.now() + 450 } }));
  // A small thing with some of what's round it, not filling the window.
  const w = Math.max(rect.w, 1100);
  const h = Math.max(rect.h + 40, 700);
  flyToBounds(rect.x - (w - rect.w) / 2, rect.y - 40 - (h - rect.h - 40) / 2, w, h);
}
