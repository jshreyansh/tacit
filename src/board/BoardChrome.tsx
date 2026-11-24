import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBoardStore, selectedBoardElements, type BoardStyle, type BoardTool } from "../stores/boardStore";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { useCanvasStore, CHROME_INSET } from "../stores/canvasStore";
import { useSelectionStore } from "../stores/selectionStore";
import { deleteSelectedSceneItems } from "../actions/sceneDeleteActions";
import { fitAllProjects, setZoomToHundred, stepZoomAtCenter } from "../canvas/zoomActions";
import { CHROME_TOP } from "../canvas/floatingChrome";
import { useT } from "../i18n/useT";
import type { BoardElement } from "../types/board";
import { BOARD_COLORS, BOARD_COLOR_NAMES, cssColor } from "./boardModel";
import { BoardIcon, type BoardIconName } from "./BoardIcons";
import { duplicate, pickTool, setStyleProp, stickyToTask } from "./boardActions";

/**
 * The board's chrome (docs/architecture/workdesk-board.md, "How it feels"):
 * the tool rail on the right, the options for the tool in hand or what's
 * selected unfolding beside it, and zoom with Fit in the bottom-right corner.
 */

type RailTool = BoardTool | "select" | "hand" | "file";
const isMac = (window.tacit?.app.platform ?? "darwin") === "darwin";
const MOD = isMac ? "⌘" : "Ctrl";

export const RAIL_TOOLS: Array<{ id: RailTool; key: string; num: number }> = [
  { id: "select", key: "V", num: 1 },
  { id: "hand", key: "H", num: 2 },
  { id: "text", key: "T", num: 3 },
  { id: "sticky", key: "N", num: 4 },
  { id: "section", key: "S", num: 5 },
  { id: "shape", key: "R", num: 6 },
  { id: "arrow", key: "A", num: 7 },
  { id: "pen", key: "P", num: 8 },
  { id: "file", key: "F", num: 9 },
];
const KEY_OF = Object.fromEntries(RAIL_TOOLS.map((r) => [r.id, r.key])) as Record<RailTool, string>;

type Ctx =
  | { kind: "tool"; tool: BoardTool }
  | { kind: "element"; type: BoardElement["type"]; el: BoardElement }
  /** `total` counts what else is selected with them: tiles too. */
  | { kind: "many"; els: BoardElement[]; total: number };

function useOptionsContext(): Ctx | null {
  const tool = useBoardStore((s) => s.tool);
  const elements = useBoardStore((s) => s.elements);
  const items = useSelectionStore((s) => s.selectedItems);
  return useMemo(() => {
    const ids = new Set(items.flatMap((i) => (i.type === "annotation" ? [i.annotationId] : [])));
    const els = elements.filter((e) => ids.has(e.id));
    if (els.length === 1 && items.length === 1) return { kind: "element", type: els[0].type, el: els[0] };
    if (els.length > 0) return { kind: "many", els, total: items.length };
    if (tool) return { kind: "tool", tool };
    return null;
  }, [tool, elements, items]);
}

/** Which rail button an options panel sits beside. */
function anchorFor(ctx: Ctx): RailTool {
  if (ctx.kind === "tool") return ctx.tool;
  if (ctx.kind === "many") return "select";
  return ({ text: "text", shape: "shape", sticky: "sticky", section: "section", frame: "section", arrow: "arrow", pen: "pen" } as const)[ctx.type];
}

function Seg<V extends string>({ value, options, onPick, label }: { value: V; options: Array<{ v: V; icon?: BoardIconName; text?: string; title: string }>; onPick: (v: V) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const on = ref.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (on) setThumb({ x: on.offsetLeft, w: on.offsetWidth });
  }, [value, options.length]);
  useEffect(() => {
    first.current = false;
  }, []);
  return (
    <div ref={ref} className={`tc-bd-seg${first.current ? " noanim" : ""}`} role="group" aria-label={label} style={{ flexGrow: options.length }}>
      {thumb && <span className="tc-bd-seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />}
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={o.v === value} title={o.title} aria-label={o.title} onClick={() => onPick(o.v)}>
          {o.icon ? <BoardIcon name={o.icon} size={15} /> : o.text}
        </button>
      ))}
    </div>
  );
}

function Swatches({ value, onPick, label }: { value: string; onPick: (c: string) => void; label: string }) {
  return (
    <div className="tc-bd-swatches" role="group" aria-label={label}>
      {BOARD_COLORS.map((c) => (
        <button key={c} type="button" aria-pressed={c === value} title={`${label}: ${BOARD_COLOR_NAMES[c]}`} aria-label={BOARD_COLOR_NAMES[c]} onClick={() => onPick(c)} style={{ "--sw": cssColor(c) } as React.CSSProperties}>
          <i />
        </button>
      ))}
    </div>
  );
}

/** One line of controls, side by side when there are two. */
const Line = ({ children }: { children: React.ReactNode }) => <div className="tc-bd-line">{children}</div>;

/**
 * The options beside the rail, compact as in tldraw: a name and its key,
 * then only controls, each with its name on hover. What a tool can change
 * decides what's there; nothing else is shown.
 */
function OptionsBody({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const style = useBoardStore((s) => s.style);
  const el = ctx.kind === "element" ? ctx.el : null;
  const kind: string = ctx.kind === "tool" ? ctx.tool : ctx.kind === "element" ? ctx.type : "many";
  // What's selected shows its own look; a tool shows what the next drawing gets.
  const v = <K extends keyof BoardStyle>(k: K): BoardStyle[K] => {
    if (!el) return style[k];
    const rec = el as unknown as Record<string, unknown>;
    if (k === "color") return (el.color ?? style.color) as BoardStyle[K];
    return (rec[k] ?? style[k]) as BoardStyle[K];
  };
  const set = <K extends keyof BoardStyle>(k: K) => (val: BoardStyle[K]) => setStyleProp(k, val);
  const colour = <Swatches label={t.board_colour} value={kind === "sticky" && !el ? style.sticky : v("color")} onPick={(c) => setStyleProp("color", c)} />;
  const sizes = (value: "S" | "M" | "L" | "XL", onPick: (s: "S" | "M" | "L" | "XL") => void) => (
    <Seg label={t.board_size} value={value} onPick={onPick} options={(["S", "M", "L", "XL"] as const).map((s) => ({ v: s, text: s, title: `${t.board_size} ${s}` }))} />
  );
  const line = (title: string) => (
    <Seg label={title} value={v("dash") ? "dashed" : "solid"} onPick={(d) => setStyleProp("dash", d === "dashed")} options={[{ v: "solid", icon: "solid", title: t.board_line_solid }, { v: "dashed", icon: "dashed", title: t.board_line_dashed }]} />
  );

  // The words inside a shape or sticky: size and where they sit, and in a shape their colour.
  const words = el && (el.type === "shape" || el.type === "sticky") ? el : null;
  const wordRows = (withColour: boolean) => (
    <>
      <div className="tc-bd-caption">{t.board_text_inside}</div>
      <Line>
        {sizes(words?.label ?? style.label, set("label"))}
        <Seg
          label={t.board_align}
          value={words?.align ?? (kind === "sticky" ? "left" : style.align)}
          onPick={set("align")}
          options={[{ v: "left", icon: "alignLeft", title: t.board_align_left }, { v: "center", icon: "alignCenter", title: t.board_align_center }, { v: "right", icon: "alignRight", title: t.board_align_right }]}
        />
      </Line>
      {withColour && <Swatches label={t.board_text_colour} value={(words?.type === "shape" ? words.textColor : undefined) ?? style.textColor} onPick={(c) => setStyleProp("textColor", c)} />}
    </>
  );

  const title = (name: string, key?: string) => (
    <div className="tc-bd-opt-head">
      <span>{name}</span>
      {key && <kbd>{key}</kbd>}
    </div>
  );

  // Tiles selected with drawings stay; only the drawings are deleted.
  const deleteLabel = ctx.kind === "many" && ctx.total > ctx.els.length ? t.board_delete_drawings : t.board_delete;
  // Selected things: what can be done with them, as small buttons at the foot.
  const actions = ctx.kind !== "tool" && (
    <div className="tc-bd-actions">
      {el?.type === "sticky" && (
        <button type="button" className="tc-bd-action" onClick={() => void stickyToTask(el.id)}>
          <BoardIcon name="task" size={14} />
          {t.board_make_task}
        </button>
      )}
      <span className="tc-bd-actions-end">
        {!(el && (el.type === "frame" || el.type === "arrow")) && (
          <button type="button" className="tc-bd-icon-btn" title={`${t.board_duplicate} (⌥ ${t.board_drag})`} aria-label={t.board_duplicate} onClick={() => duplicate(selectedBoardElements().map((e) => e.id))}>
            <BoardIcon name="dup" size={15} />
          </button>
        )}
        <button type="button" className="tc-bd-icon-btn danger" title={`${deleteLabel} (⌫)`} aria-label={deleteLabel} onClick={() => deleteSelectedSceneItems()}>
          <BoardIcon name="trash" size={15} />
        </button>
      </span>
    </div>
  );
  const toolKey = ctx.kind === "tool" ? KEY_OF[ctx.tool] : undefined;

  switch (kind) {
    case "text":
      return (
        <>
          {title(t.board_tool_text, toolKey)}
          {colour}
          <Line>{sizes(v("size"), set("size"))}</Line>
          {actions}
        </>
      );
    case "sticky":
      return (
        <>
          {title(t.board_tool_sticky, toolKey)}
          {colour}
          {wordRows(false)}
          {actions}
        </>
      );
    case "section":
    case "frame":
      return (
        <>
          {title(el && el.type === "frame" ? el.title || t.board_tool_section : t.board_tool_section, toolKey)}
          {colour}
          {actions}
        </>
      );
    case "shape": {
      const cell = el?.type === "shape" && !!el.cell;
      const shapeKey = ctx.kind === "tool" ? { rect: "R", ellipse: "O", diamond: "D" }[v("shape")] : undefined;
      return (
        <>
          {title(t[`board_shape_${v("shape")}`], shapeKey)}
          {!cell && (
            <Line>
              <Seg label={t.board_shape} value={v("shape")} onPick={set("shape")} options={(["rect", "ellipse", "diamond"] as const).map((s) => ({ v: s, icon: s, title: `${t[`board_shape_${s}`]} (${{ rect: "R", ellipse: "O", diamond: "D" }[s]})` }))} />
            </Line>
          )}
          {colour}
          <Line>
            <Seg label={t.board_fill} value={v("fill")} onPick={set("fill")} options={[{ v: "none", icon: "fillNone", title: t.board_fill_none }, { v: "soft", icon: "fillSoft", title: t.board_fill_soft }, { v: "solid", icon: "fillSolid", title: t.board_fill_solid }]} />
          </Line>
          <Line>
            {line(t.board_outline)}
            {v("shape") === "rect" && !cell && (
              <Seg label={t.board_corners} value={v("corners")} onPick={set("corners")} options={[{ v: "round", icon: "round", title: t.board_corners_round }, { v: "sharp", icon: "sharp", title: t.board_corners_sharp }]} />
            )}
          </Line>
          {wordRows(true)}
          {actions}
        </>
      );
    }
    case "arrow":
      return (
        <>
          {title(t.board_tool_arrow, toolKey)}
          {colour}
          <Line>
            <Seg label={t.board_route} value={v("route")} onPick={set("route")} options={[{ v: "straight", icon: "straight", title: t.board_route_straight }, { v: "curve", icon: "curve", title: t.board_route_curve }, { v: "elbow", icon: "elbow", title: t.board_route_elbow }]} />
          </Line>
          <Line>
            <Seg label={t.board_ends} value={v("ends")} onPick={set("ends")} options={[{ v: "none", icon: "endNone", title: t.board_ends_none }, { v: "end", icon: "endOne", title: t.board_ends_end }, { v: "both", icon: "endBoth", title: t.board_ends_both }]} />
            {line(t.board_line)}
          </Line>
          {actions}
        </>
      );
    case "pen":
      return (
        <>
          {title(t.board_tool_pen, toolKey)}
          {colour}
          <Line>
            <Seg label={t.board_weight} value={v("weight")} onPick={set("weight")} options={[{ v: "thin", icon: "thin", title: t.board_weight_thin }, { v: "medium", icon: "medium", title: t.board_weight_medium }, { v: "bold", icon: "bold", title: t.board_weight_bold }]} />
          </Line>
          {actions}
        </>
      );
    default:
      return (
        <>
          {title(t.board_many_selected(ctx.kind === "many" ? ctx.total : 0))}
          {colour}
          {actions}
        </>
      );
  }
}

export const BoardChrome = memo(function BoardChrome() {
  const t = useT();
  const boardTool = useBoardStore((s) => s.tool);
  const locked = useBoardStore((s) => s.locked);
  const editing = useBoardStore((s) => s.editingId);
  const canvasTool = useCanvasToolStore((s) => s.tool);
  const shape = useBoardStore((s) => s.style.shape);
  const scale = useCanvasStore((s) => s.viewport.scale);
  const active: RailTool = boardTool ?? canvasTool;
  const ctx = useOptionsContext();
  const railRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<number | null>(null);
  const [anchorTop, setAnchorTop] = useState<number | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [tip, setTip] = useState<{ id: RailTool; top: number; name: string; keys: string[] } | null>(null);
  // A tool's name shows after a short wait, then at once while moving along
  // the rail; clicking puts it away until the pointer leaves that button.
  const tipTimer = useRef(0);
  const tipWarm = useRef(false);
  const tipQuiet = useRef<RailTool | null>(null);
  const showTip = (id: RailTool, button: HTMLElement, label: string, keys: string[]) => {
    window.clearTimeout(tipTimer.current);
    if (tipQuiet.current === id) return;
    const next = { id, top: button.getBoundingClientRect().top + 19, name: label, keys };
    if (tipWarm.current) setTip(next);
    else tipTimer.current = window.setTimeout(() => {
      tipWarm.current = true;
      setTip(next);
    }, 450);
  };
  const hideTip = () => {
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const btn = rail.querySelector<HTMLElement>(`[data-rail-tool="${active}"]`);
    if (btn) setIndicator(btn.offsetTop);
  }, [active]);

  const anchor = ctx ? anchorFor(ctx) : null;
  useLayoutEffect(() => {
    if (!anchor) return;
    const btn = railRef.current?.querySelector<HTMLElement>(`[data-rail-tool="${anchor}"]`);
    if (btn) setAnchorTop(btn.getBoundingClientRect().top);
  }, [anchor]);
  // The panel's height, so it can sit beside its tool without running under zoom.
  useLayoutEffect(() => {
    const node = optionsRef.current;
    if (!node) return;
    const measure = () => setPanelHeight(node.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  // Hidden while typing, so the panel doesn't sit over the words.
  const optionsOpen = !!ctx && !editing;
  // What it last showed stays while it slides away, so it doesn't shrink first.
  const lastCtx = useRef(ctx);
  if (ctx) lastCtx.current = ctx;
  const shown = ctx ?? lastCtx.current;
  const ctxKey = shown ? (shown.kind === "tool" ? `t:${shown.tool}` : shown.kind === "element" ? `e:${shown.el.id}` : "many") : "none";
  // It slides in from the rail. Only once it's in does it glide to another
  // tool's height; on the way in, its height is still being measured, and
  // gliding then looked like it rose from the bottom.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!optionsOpen) {
      setSettled(false);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [optionsOpen]);

  const name = (id: RailTool) => (id === "shape" ? `${t.board_tool_shape} · ${t[`board_shape_${shape}`]}` : t[`board_tool_${id}`]);
  const iconFor = (id: RailTool): BoardIconName => (id === "shape" ? shape : id);

  return (
    <>
      <div
        ref={railRef}
        className="tc-float tc-bd-rail"
        data-scene-box-select-block=""
        role="toolbar"
        aria-orientation="vertical"
        aria-label={t.board_tools}
        style={{ right: CHROME_INSET, top: `calc(${CHROME_TOP} + (100vh - ${CHROME_TOP} - ${CHROME_INSET}px) / 2)` }}
        onPointerLeave={() => {
          hideTip();
          tipWarm.current = false;
          tipQuiet.current = null;
        }}
      >
        {indicator !== null && <span className="tc-bd-rail-ind" style={{ transform: `translateY(${indicator}px)` }} />}
        {RAIL_TOOLS.map((tool, i) => (
          <div key={tool.id} className="contents">
            {(i === 2) && <span className="tc-bd-rail-sep" />}
            <button
              type="button"
              className="tc-bd-tool"
              data-rail-tool={tool.id}
              aria-pressed={active === tool.id}
              aria-label={name(tool.id)}
              onClick={() => {
                hideTip();
                tipQuiet.current = tool.id;
                // The tool in hand, clicked again, is put away: back to Select, its options closed.
                pickTool(boardTool === tool.id ? "select" : tool.id);
              }}
              onPointerEnter={(e) => showTip(tool.id, e.currentTarget, name(tool.id), [tool.key, String(tool.num)])}
              onPointerLeave={() => {
                hideTip();
                if (tipQuiet.current === tool.id) tipQuiet.current = null;
              }}
            >
              <BoardIcon name={iconFor(tool.id)} />
              {tool.id === "shape" && <span className="tc-bd-more" />}
              {/* Q keeps a tool after drawing; it shows on the tool, not as a button. */}
              {locked && active === tool.id && boardTool && <span className="tc-bd-kept" title={t.board_keep_tool} />}
            </button>
          </div>
        ))}
      </div>

      {/* Never over the options, which sit in the same place and name their tool. */}
      {tip && !optionsOpen && (
        <div className="tc-bd-tip" role="tooltip" style={{ top: tip.top, right: CHROME_INSET + 48 + 10 }}>
          {tip.name}
          {tip.keys.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </div>
      )}

      <div
        className={`tc-float tc-bd-options${optionsOpen ? " is-open" : ""}${settled ? " is-settled" : ""}`}
        data-scene-box-select-block=""
        aria-label={t.board_options}
        aria-hidden={!optionsOpen}
        ref={optionsRef}
        style={{
          right: CHROME_INSET + 48 + 10,
          // Level with its tool, but never lower than the space above the zoom pill.
          top: Math.max(56, Math.min((anchorTop ?? 120) - 12, window.innerHeight - panelHeight - CHROME_INSET - 52)),
          // Never taller than the room between the top and the zoom pill; past that it scrolls.
          maxHeight: window.innerHeight - 56 - CHROME_INSET - 52,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {shown && (
          <div key={ctxKey} className="tc-bd-options-body">
            <OptionsBody ctx={shown} />
          </div>
        )}
      </div>

      <div className="tc-float tc-bd-zoom" data-scene-box-select-block="" style={{ right: CHROME_INSET, bottom: CHROME_INSET }}>
        <button type="button" onClick={() => stepZoomAtCenter("out")} aria-label={t.zoom_out} title={t.zoom_out}>
          −
        </button>
        <button type="button" className="tc-bd-pct" onClick={setZoomToHundred} title={t.board_zoom_reset(MOD)}>
          {Math.round(scale * 100)}%
        </button>
        <button type="button" onClick={() => stepZoomAtCenter("in")} aria-label={t.zoom_in} title={t.zoom_in}>
          +
        </button>
        <button type="button" onClick={fitAllProjects} title={`${t.fit} (${MOD}0)`} aria-label={t.fit}>
          {t.fit}
        </button>
      </div>
    </>
  );
});
