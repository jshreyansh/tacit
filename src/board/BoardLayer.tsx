import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ViewportPortal, useStore, useStoreApi } from "@xyflow/react";
import { useBoardStore, selectedBoardElements } from "../stores/boardStore";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { useSelectionStore } from "../stores/selectionStore";
import { startGroupMove } from "../canvas/groupMove";
import { alignRect, ALIGN_SNAP } from "../canvas/tileMove";
import { hasPrimaryModifier } from "../hooks/shortcutTarget";
import { screenPointToCanvasPoint } from "../canvas/viewportBounds";
import { useCanvasStore } from "../stores/canvasStore";
import type { BoardElement, BoardEnd, BoardRect, BoxedElement } from "../types/board";
import {
  LABEL_SIZES,
  TEXT_SIZES,
  WEIGHTS,
  arrowGeometry,
  arrowHead,
  attachTargetAt,
  bounds,
  canQuickConnect,
  cssColor,
  inside,
  isBlock,
  isBoxed,
  penPath,
  type Direction,
  type Point,
  type TargetLookup,
} from "./boardModel";
import { boardTargetLookup, publishTileRects, tileRects, type TileRect } from "./boardTargets";
import { useBoardDraft } from "./boardDraft";
import {
  commitText,
  createArrow,
  duplicate,
  finishEditing,
  linkedShapeAt,
  measureText,
  quickAdd,
  registerEditFinisher,
  selectBoard,
  startEditing,
} from "./boardActions";
import "./board.css";

/**
 * The board, drawn inside the canvas so it pans and zooms with the tiles
 * (docs/architecture/workdesk-board.md). Sections, frames, shapes and text
 * sit behind tiles; stickies, arrows and pen strokes in front.
 * In Select, drawings are picked, moved, resized and typed into here; the
 * drawing tools themselves work through BoardDrawOverlay.
 */

const DIRS: Direction[] = ["right", "left", "down", "up"];
const QC_PATH: Record<Direction, string> = {
  right: "M3 8h9M8.5 4.5 12 8l-3.5 3.5",
  left: "M13 8H4M7.5 4.5 4 8l3.5 3.5",
  down: "M8 3v9M4.5 8.5 8 12l3.5-3.5",
  up: "M8 13V4M4.5 7.5 8 4l3.5 3.5",
};
const SNAP_TYPES = new Set(["shape", "sticky", "section", "frame"]);

/** The canvas's tiles, from React Flow, for arrows and snapping. */
function useTilePublisher() {
  const nodes = useStore((s) => s.nodes);
  useEffect(() => {
    const rects: TileRect[] = [];
    for (const n of nodes) {
      if (n.hidden) continue;
      // After a drop the canvas rebuilds its nodes without React Flow's measurements;
      // the size the tile was given is the same, so use it rather than lose the tile.
      const style = (n.style ?? {}) as { width?: unknown; height?: unknown };
      const w = n.measured?.width ?? n.width ?? (typeof style.width === "number" ? style.width : 0);
      const h = n.measured?.height ?? n.height ?? (typeof style.height === "number" ? style.height : 0);
      if (w > 0 && h > 0) rects.push({ id: n.id, kind: n.type ?? "", x: n.position.x, y: n.position.y, w, h });
    }
    publishTileRects(rects);
  }, [nodes]);
  return nodes;
}

function toWorld(e: { clientX: number; clientY: number }): Point {
  return screenPointToCanvasPoint(e.clientX, e.clientY, useCanvasStore.getState().viewport);
}

/** Text typed in place: ends on Escape, ⌘Enter, a click elsewhere, or ⌘ + arrow (which adds the next shape). */
function EditableText({ id, initial, className, style }: { id: string; initial: string; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = initial;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      commitText(id, node.innerText ?? node.textContent ?? "");
      useBoardStore.getState().setEditing(null);
    };
    registerEditFinisher(finish);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) {
        ev.preventDefault();
        ev.stopPropagation();
        finishEditing();
        return;
      }
      const dir = { ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up" }[ev.key] as Direction | undefined;
      if (dir && (ev.metaKey || ev.ctrlKey)) {
        const e = useBoardStore.getState().elements.find((x) => x.id === id);
        if (canQuickConnect(e)) {
          ev.preventDefault();
          ev.stopPropagation();
          finishEditing();
          quickAdd(id, dir);
        }
      }
    };
    const onBlur = () => finishEditing();
    node.addEventListener("keydown", onKey);
    node.addEventListener("blur", onBlur);
    return () => {
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("blur", onBlur);
    };
    // Mounted once per edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span
      ref={ref}
      className={`tc-bd-editing ${className ?? ""}`}
      style={style}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** A text box reports its laid-out size, so selection and arrows fit it. */
function MeasuredText({ e, editing, selected, hovered, born }: { e: Extract<BoardElement, { type: "text" }>; editing: boolean; selected: boolean; hovered: boolean; born: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => measureText(e.id, node.offsetWidth, node.offsetHeight);
    measure();
    if (!editing) return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [e.id, e.text, e.size, editing]);
  return (
    <div
      ref={ref}
      className={`tc-bd-el tc-bd-text tc-bd-size-${e.size}${selected ? " is-sel" : ""}${hovered ? " is-hov" : ""}${born ? " is-born" : ""}`}
      data-board-el={e.id}
      data-scene-box-select-block=""
      style={{ left: e.x, top: e.y, color: cssColor(e.color), fontSize: TEXT_SIZES[e.size] }}
    >
      {editing ? <EditableText id={e.id} initial={e.text} /> : e.text}
    </div>
  );
}

const Boxed = memo(function Boxed({
  e,
  selected,
  single,
  hovered,
  editing,
  born,
  part = "body",
}: {
  e: BoxedElement;
  selected: boolean;
  single: boolean;
  hovered: boolean;
  editing: boolean;
  born: boolean;
  /** A section or frame is drawn twice: its area behind the tiles, its name in front, so a tile never hides the handle you move it by. */
  part?: "body" | "title";
}) {
  const cls = `${selected ? " is-sel" : ""}${hovered ? " is-hov" : ""}${born ? " is-born" : ""}`;
  const pos = { left: e.x, top: e.y, width: e.w, height: e.h, "--c": cssColor(e.color) } as React.CSSProperties;
  const handle = selected && single && !editing && e.type !== "text" ? <div className="tc-bd-handle" data-board-handle={e.id} /> : null;
  if (e.type === "text") return null;
  if (e.type === "section" || e.type === "frame") {
    const agent = e.author?.kind === "agent" ? e.author : null;
    if (part === "title") {
      return (
        <div className="tc-bd-title-anchor" style={{ left: e.x, top: e.y, "--c": cssColor(e.color) } as React.CSSProperties}>
          <div className={`tc-bd-title${selected ? " is-sel" : ""}`} data-board-el={e.id} data-scene-box-select-block="">
            {editing ? (
              <EditableText id={e.id} initial={e.title} className="tc-bd-title-text" />
            ) : (
              <span className="tc-bd-title-text">{e.title || (e.type === "section" ? "Section" : "Drawing")}</span>
            )}
            {agent && <span className="tc-bd-byline">drawn by {agent.name}</span>}
          </div>
        </div>
      );
    }
    return (
      <div className={`tc-bd-${e.type}${cls}`} data-board-container={e.id} style={pos}>
        {handle}
      </div>
    );
  }
  if (e.type === "sticky") {
    return (
      <div className={`tc-bd-el tc-bd-sticky${cls}`} data-board-el={e.id} data-scene-box-select-block="" style={{ ...pos, fontSize: LABEL_SIZES[e.label ?? "M"] + 1, textAlign: e.align ?? "left" }}>
        {editing ? <EditableText id={e.id} initial={e.text} /> : <span className={e.text ? undefined : "tc-bd-placeholder"}>{e.text || "Type something…"}</span>}
        {handle}
      </div>
    );
  }
  const shapeCls = `tc-bd-shape k-${e.shape} fill-${e.fill}${e.dash ? " dash" : ""}${e.shape === "rect" && e.corners === "sharp" ? " sharp" : ""}${e.cell ? ` cell${e.cell === "head" ? " head" : ""}` : ""} w-${e.weight ?? "medium"}`;
  const words = {
    fontSize: LABEL_SIZES[e.label ?? "M"],
    textAlign: e.align ?? "center",
    justifyContent: { left: "flex-start", center: "center", right: "flex-end" }[e.align ?? "center"],
    ...(e.textColor && e.textColor !== "ink" ? { color: cssColor(e.textColor) } : {}),
  } as React.CSSProperties;
  return (
    <div className={`tc-bd-el ${shapeCls}${cls}`} data-board-el={e.id} data-scene-box-select-block="" style={{ ...pos, ...words }}>
      {e.shape === "diamond" && (
        <svg className="tc-bd-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {editing ? <EditableText id={e.id} initial={e.text} /> : <span>{e.text}</span>}
      {handle}
    </div>
  );
});

const ArrowSvg = memo(function ArrowSvg({ e, lookup, selected, born, handles }: { e: Extract<BoardElement, { type: "arrow" }>; lookup: TargetLookup; selected: boolean; born: boolean; handles: boolean }) {
  const g = arrowGeometry(e, lookup);
  const color = cssColor(e.color);
  const width = e.weight ? WEIGHTS[e.weight] * 0.75 : 2.4;
  return (
    <g className={`tc-bd-arrow${born ? " is-born" : ""}${e.dash ? " dashed" : ""}`}>
      {selected && <path className="tc-bd-halo" d={g.d} style={{ strokeWidth: `calc(${width}px + 7px * var(--inv))` }} />}
      <path d={g.d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={e.dash ? "8 6" : undefined} pathLength={born && !e.dash ? 1 : undefined} className="tc-bd-line" />
      {e.ends !== "none" && <polygon className="tc-bd-head" points={arrowHead(g.b, g.intoB)} fill={color} />}
      {e.ends === "both" && <polygon className="tc-bd-head" points={arrowHead(g.a, g.intoA)} fill={color} />}
      {e.label && (
        <g className="tc-bd-label">
          <rect x={g.mid.x - (e.label.length * 7.2 + 16) / 2} y={g.mid.y - 11} width={e.label.length * 7.2 + 16} height={22} rx={7} stroke={color} />
          <text x={g.mid.x} y={g.mid.y + 4.5} textAnchor="middle">{e.label}</text>
        </g>
      )}
      <path d={g.d} className="tc-bd-hit" data-board-el={e.id} data-scene-box-select-block="" />
      {handles &&
        (["a", "b"] as const).map((end) => (
          <circle key={end} className="tc-bd-end" data-board-end={end} data-board-of={e.id} data-scene-box-select-block="" cx={g[end].x} cy={g[end].y} />
        ))}
    </g>
  );
});

const PenSvg = memo(function PenSvg({ e, selected }: { e: Extract<BoardElement, { type: "pen" }>; selected: boolean }) {
  const d = penPath(e.points);
  const w = WEIGHTS[e.weight];
  return (
    <g>
      {selected && <path className="tc-bd-halo" d={d} strokeWidth={w + 7} />}
      <path d={d} fill="none" stroke={cssColor(e.color)} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} className="tc-bd-hit" data-board-el={e.id} data-scene-box-select-block="" />
    </g>
  );
});

function DraftSvg({ lookup }: { lookup: TargetLookup }) {
  const zoom = useStore((s) => s.transform[2]);
  const draft = useBoardDraft((s) => s.draft);
  const target = useBoardDraft((s) => s.target);
  const guides = useBoardDraft((s) => s.guides);
  const style = useBoardStore((s) => s.style);
  const k = 1 / zoom;
  const dash = { fill: "none", strokeWidth: 1.5 * k, strokeDasharray: `${6 * k} ${4 * k}` };
  let shape: React.ReactNode = null;
  if (draft?.kind === "box") {
    const r = draft.rect;
    shape =
      draft.shape === "ellipse" ? (
        <ellipse className="tc-bd-draft" cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} {...dash} />
      ) : draft.shape === "diamond" ? (
        <polygon className="tc-bd-draft" points={`${r.x + r.w / 2},${r.y} ${r.x + r.w},${r.y + r.h / 2} ${r.x + r.w / 2},${r.y + r.h} ${r.x},${r.y + r.h / 2}`} {...dash} />
      ) : (
        <rect className="tc-bd-draft" x={r.x} y={r.y} width={r.w} height={r.h} rx={draft.shape === "section" ? 18 : 12} {...dash} />
      );
  } else if (draft?.kind === "arrow") {
    const g = arrowGeometry({ a: draft.a, b: target ? { ref: target } : draft.b, route: style.route }, lookup);
    const color = cssColor(style.color);
    shape = (
      <g>
        <path d={g.d} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={style.dash ? "8 6" : undefined} />
        {style.ends !== "none" && <polygon points={arrowHead(g.b, g.intoB)} fill={color} />}
      </g>
    );
  } else if (draft?.kind === "pen") {
    shape = <path d={penPath(draft.points)} fill="none" stroke={cssColor(style.color)} strokeWidth={WEIGHTS[style.weight]} strokeLinecap="round" strokeLinejoin="round" />;
  }
  const t = target ? lookup(target) : null;
  return (
    <g pointerEvents="none">
      {shape}
      {t && <rect className="tc-bd-draft" x={t.rect.x - 5} y={t.rect.y - 5} width={t.rect.w + 10} height={t.rect.h + 10} rx={16} fill="none" strokeWidth={2 * k} />}
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <line key={i} x1={g.at} y1={g.from} x2={g.at} y2={g.to} stroke="var(--tc-guide, #ff3d7f)" strokeWidth={k} />
        ) : (
          <line key={i} x1={g.from} y1={g.at} x2={g.to} y2={g.at} stroke="var(--tc-guide, #ff3d7f)" strokeWidth={k} />
        ),
      )}
    </g>
  );
}

/**
 * Memoised with no props: the canvas re-renders on every pan, and the board
 * mustn't. Zoom reaches it only as the --inv CSS variable, written straight
 * to the DOM, so 2,000 drawings don't re-render as you zoom.
 */
export const BoardLayer = memo(function BoardLayer() {
  const nodes = useTilePublisher();
  const rootRef = useRef<HTMLDivElement>(null);
  const storeApi = useStoreApi();
  useEffect(() => {
    let last = -1;
    const apply = (zoom: number) => {
      // In 20% steps: a change restyles every drawing, so it happens only now and then as you zoom.
      const inv = zoom < 1 ? Math.pow(1.2, Math.round(Math.log(1 / zoom) / Math.log(1.2))) : 1;
      if (inv === last) return;
      last = inv;
      rootRef.current?.style.setProperty("--inv", inv.toFixed(3));
    };
    apply(storeApi.getState().transform[2]);
    return storeApi.subscribe((s) => apply(s.transform[2]));
  }, [storeApi]);
  const elements = useBoardStore((s) => s.elements);
  const editingId = useBoardStore((s) => s.editingId);
  const hoverId = useBoardStore((s) => s.hoverId);
  const bornAt = useBoardStore((s) => s.bornAt);
  const boardTool = useBoardStore((s) => s.tool);
  const canvasTool = useCanvasToolStore((s) => s.tool);
  const spaceHeld = useCanvasToolStore((s) => s.spaceHeld);
  const dragging = useBoardDraft((s) => s.dragging);
  const selectedItems = useSelectionStore((s) => s.selectedItems);
  const selected = useMemo(
    () => new Set(selectedItems.flatMap((i) => (i.type === "annotation" ? [i.annotationId] : []))),
    [selectedItems],
  );
  const interactive = !boardTool && canvasTool === "select" && !spaceHeld;
  // Arrows resolve their ends against elements and tiles as they are now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lookup = useMemo(() => boardTargetLookup(elements), [elements, nodes]);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    // Entrances run once: after they've played, re-render without them.
    const pending = Object.values(bornAt).some((t) => performance.now() - t < 500);
    if (!pending) return;
    const id = window.setTimeout(() => setNow(performance.now()), 520);
    return () => window.clearTimeout(id);
  }, [bornAt, now]);
  const born = (id: string) => bornAt[id] !== undefined && performance.now() - bornAt[id] < 500;

  const single = selectedItems.length === 1;
  const back: React.ReactNode[] = [];
  const mid: React.ReactNode[] = [];
  const top: React.ReactNode[] = [];
  const titles: React.ReactNode[] = [];
  const ink: React.ReactNode[] = [];
  for (const e of elements) {
    const isSel = selected.has(e.id);
    if (e.type === "arrow") {
      ink.push(<ArrowSvg key={e.id} e={e} lookup={lookup} selected={isSel} born={born(e.id)} handles={isSel && single && interactive && !editingId} />);
    } else if (e.type === "pen") {
      ink.push(<PenSvg key={e.id} e={e} selected={isSel} />);
    } else if (e.type === "text") {
      mid.push(<MeasuredText key={e.id} e={e} editing={editingId === e.id} selected={isSel} hovered={hoverId === e.id} born={born(e.id)} />);
    } else {
      const node = <Boxed key={e.id} e={e} selected={isSel} single={single} hovered={hoverId === e.id && !isSel} editing={editingId === e.id} born={born(e.id)} />;
      if (e.type === "section" || e.type === "frame") {
        back.push(node);
        titles.push(<Boxed key={`${e.id}-title`} e={e} part="title" selected={isSel} single={single} hovered={false} editing={editingId === e.id} born={born(e.id)} />);
      }
      else if (e.type === "shape") mid.push(node);
      else top.push(node);
    }
  }

  // Quick connect: four arrows around the shape or sticky you're on.
  const qcSource = (() => {
    if (!interactive || editingId || dragging) return null;
    const hovered = hoverId ? elements.find((e) => e.id === hoverId) : null;
    if (canQuickConnect(hovered)) return hovered;
    if (single) {
      const only = elements.find((e) => selected.has(e.id));
      if (canQuickConnect(only)) return only;
    }
    return null;
  })();

  /* ---------- pointer: pick, move, resize, re-attach, connect ---------- */

  const hoverTimer = useRef<number | null>(null);
  const onPointerOver = useCallback((ev: React.PointerEvent) => {
    const t = ev.target as Element;
    if (t.closest("[data-board-qc]")) {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      return;
    }
    const id = t.closest("[data-board-el]")?.getAttribute("data-board-el") ?? null;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (id) useBoardStore.getState().setHover(id);
    else hoverTimer.current = window.setTimeout(() => useBoardStore.getState().setHover(null), 160);
  }, []);
  const onPointerOut = useCallback((ev: React.PointerEvent) => {
    const to = ev.relatedTarget as Element | null;
    if (to && (to.closest?.("[data-board-el]") || to.closest?.("[data-board-qc]"))) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => useBoardStore.getState().setHover(null), 160);
  }, []);

  const onPointerDown = useCallback(
    (ev: React.PointerEvent) => {
      if (ev.button !== 0 || !interactive) return;
      const t = ev.target as Element;
      const start = toWorld(ev);
      const store = useBoardStore.getState();
      const draft = useBoardDraft.getState();
      const sx = ev.clientX;
      const sy = ev.clientY;
      const onUp = (fn: (e: PointerEvent) => void, move?: (e: PointerEvent) => void) => {
        const up = (e: PointerEvent) => {
          window.removeEventListener("pointermove", mv);
          window.removeEventListener("pointerup", up);
          fn(e);
          draft.clear();
        };
        const mv = (e: PointerEvent) => move?.(e);
        window.addEventListener("pointermove", mv);
        window.addEventListener("pointerup", up);
      };

      // Quick connect: a click adds a linked copy; a drag draws an arrow out of it.
      const qc = t.closest("[data-board-qc]");
      if (qc) {
        ev.stopPropagation();
        ev.preventDefault();
        const from = qc.getAttribute("data-board-of")!;
        const dir = qc.getAttribute("data-board-qc") as Direction;
        let moved = false;
        onUp(
          (e) => {
            if (!moved) {
              quickAdd(from, dir);
              return;
            }
            const p = toWorld(e);
            const target = useBoardDraft.getState().target;
            if (target) {
              createArrow({ ref: from }, { ref: target });
              selectBoard([from]);
            } else linkedShapeAt(from, p);
          },
          (e) => {
            if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
            moved = true;
            const p = toWorld(e);
            draft.set({ draft: { kind: "arrow", a: { ref: from }, b: p }, target: attachTargetAt(p, useBoardStore.getState().elements, tileRects(), from), dragging: true });
          },
        );
        return;
      }

      // An arrow's end, dragged to re-attach it.
      const endNode = t.closest("[data-board-end]");
      if (endNode) {
        ev.stopPropagation();
        ev.preventDefault();
        const id = endNode.getAttribute("data-board-of")!;
        const which = endNode.getAttribute("data-board-end") as "a" | "b";
        store.checkpoint();
        draft.set({ dragging: true });
        onUp(
          () => {},
          (e) => {
            const arrow = useBoardStore.getState().elements.find((x) => x.id === id);
            if (!arrow || arrow.type !== "arrow") return;
            const other = which === "a" ? arrow.b : arrow.a;
            const p = toWorld(e);
            const target = attachTargetAt(p, useBoardStore.getState().elements, tileRects(), "ref" in other ? other.ref : null);
            useBoardDraft.getState().set({ target });
            const next: BoardEnd = target ? { ref: target } : { x: p.x, y: p.y };
            useBoardStore.getState().patch({ [id]: { [which]: next } });
          },
        );
        return;
      }

      // A corner handle: resize.
      const handle = t.closest("[data-board-handle]");
      if (handle) {
        ev.stopPropagation();
        ev.preventDefault();
        const id = handle.getAttribute("data-board-handle")!;
        const el = store.elements.find((x) => x.id === id);
        if (!el || !isBoxed(el)) return;
        const ow = el.w;
        const oh = el.h;
        let checkpointed = false;
        draft.set({ dragging: true });
        onUp(
          () => {},
          (e) => {
            const p = toWorld(e);
            if (!checkpointed) {
              useBoardStore.getState().checkpoint();
              checkpointed = true;
            }
            const minW = el.type === "section" || el.type === "frame" ? 120 : 40;
            const w = Math.max(minW, ow + p.x - start.x);
            const h = Math.max(30, oh + p.y - start.y);
            useBoardStore.getState().patch({ [id]: { w, h } });
          },
        );
        return;
      }

      const elNode = t.closest("[data-board-el]");
      if (!elNode) return;
      ev.stopPropagation();
      const id = elNode.getAttribute("data-board-el")!;
      if (store.editingId === id) return;
      finishEditing();
      // ⌘ or Shift adds it, or draws a box from here (useBoxSelect).
      if (!ev.altKey && (ev.shiftKey || hasPrimaryModifier(ev.nativeEvent))) return;
      let ids = selected.has(id) ? [...selected] : [id];
      if (!selected.has(id)) selectBoard([id]);
      // Option-drag leaves the originals and moves copies, as in Figma and Excalidraw.
      if (ev.altKey) {
        const copies = duplicate(ids, 0);
        if (copies.length) ids = copies.filter((c) => useBoardStore.getState().elements.find((x) => x.id === c)?.type !== "arrow");
      }

      // What moves: everything selected, with what its sections and frames hold. Copies move alone.
      const all = useBoardStore.getState().elements;
      const items = ev.altKey ? ids.map((annotationId) => ({ type: "annotation" as const, annotationId })) : useSelectionStore.getState().selectedItems;
      const group = startGroupMove(items, { checkpoint: !ev.altKey });
      const primary = all.find((x) => x.id === (ids.includes(id) ? id : ids[0]));
      const primaryRect = primary && isBoxed(primary) ? { x: primary.x, y: primary.y, w: primary.w, h: primary.h } : null;
      const movingIds = new Set([...group.moving.elements, ...group.moving.tiles]);
      const others: BoardRect[] = [
        ...tileRects().filter((r) => !movingIds.has(r.id)),
        ...all.filter((x) => !movingIds.has(x.id) && SNAP_TYPES.has(x.type)).map((x) => x as BoxedElement),
      ].map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
      let moved = false;
      let last = { dx: 0, dy: 0 };
      onUp(
        () => {
          if (moved) group.drop(last.dx, last.dy);
        },
        (e) => {
          const p = toWorld(e);
          let dx = p.x - start.x;
          let dy = p.y - start.y;
          if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
          if (!moved) {
            moved = true;
            useBoardStore.getState().setHover(null);
            draft.set({ dragging: true });
          }
          if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          let guides: ReturnType<typeof alignRect>["guides"] = [];
          if (primaryRect && !(e.metaKey || e.ctrlKey) && SNAP_TYPES.has(primary!.type)) {
            const a = alignRect({ ...primaryRect, x: primaryRect.x + dx, y: primaryRect.y + dy }, others, ALIGN_SNAP / useCanvasStore.getState().viewport.scale, { x: !(e.shiftKey && dx === 0), y: !(e.shiftKey && dy === 0) });
            dx = a.x - primaryRect.x;
            dy = a.y - primaryRect.y;
            guides = a.guides;
          }
          last = { dx, dy };
          group.shift(dx, dy);
          useBoardDraft.getState().set({ guides });
        },
      );
    },
    [interactive, selected, lookup],
  );

  const onDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!interactive) return;
      const id = (ev.target as Element).closest("[data-board-el]")?.getAttribute("data-board-el");
      if (!id) return;
      ev.stopPropagation();
      startEditing(id);
    },
    [interactive],
  );

  return (
    <ViewportPortal>
      <div
        ref={rootRef}
        className={`tc-board${interactive ? " is-interactive" : ""}`}
        onPointerDown={onPointerDown}
        onPointerOver={interactive ? onPointerOver : undefined}
        onPointerOut={interactive ? onPointerOut : undefined}
        onDoubleClick={onDoubleClick}
      >
        <div className="tc-board-back">
          {back}
          {mid}
        </div>
        <div className="tc-board-top">
          <svg className="tc-board-ink" width="1" height="1">
            {ink}
            <DraftSvg lookup={lookup} />
          </svg>
          {titles}
          {top}
          {qcSource &&
            DIRS.map((d) => {
              const s = qcSource as BoxedElement;
              const cx = s.x + s.w / 2;
              const cy = s.y + s.h / 2;
              const gap = "18px * var(--inv)";
              const at = {
                right: [`calc(${s.x + s.w}px + ${gap})`, `${cy}px`],
                left: [`calc(${s.x}px - ${gap})`, `${cy}px`],
                down: [`${cx}px`, `calc(${s.y + s.h}px + ${gap})`],
                up: [`${cx}px`, `calc(${s.y}px - ${gap})`],
              }[d];
              return (
                <div
                  key={`${s.id}-${d}`}
                  className="tc-bd-qc"
                  data-board-qc={d}
                  data-board-of={s.id}
                  data-scene-box-select-block=""
                  title={`Add a linked ${s.type === "sticky" ? "sticky" : "shape"} (⌘ + arrow key), or drag to connect`}
                  style={{ left: at[0], top: at[1] }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={QC_PATH[d]} />
                  </svg>
                </div>
              );
            })}
        </div>
      </div>
    </ViewportPortal>
  );
});

/** Whether a point is on a board element (for the canvas's own double-click). */
export function boardElementAt(p: Point): BoardElement | null {
  const els = useBoardStore.getState().elements;
  const lookup = boardTargetLookup(els);
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (isBlock(e) || e.type === "text") if (inside(bounds(e, lookup), p)) return e;
  }
  return null;
}

/** Re-export for callers that only need the current selection. */
export { selectedBoardElements };
