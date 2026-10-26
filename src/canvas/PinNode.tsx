import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { usePinStore } from "../stores/pinStore";
import { useSelectionStore } from "../stores/selectionStore";
import { activatePinInScene } from "../actions/sceneSelectionActions";
import { updatePinInScene } from "../actions/scenePinActions";
import type { PinFlowNode } from "./nodeProjection";
import type { Pin } from "../types";
import { useT } from "../i18n/useT";
import { pinKind } from "../../shared/pin";
import { NeedsYouBlock, OwnerChips, ProgressBar, StatusChip, StepList } from "../tasks/TaskParts";
import { deleteTask, makeNote, makeTask, removeFromCanvas } from "../tasks/taskActions";
import { openPinFull } from "../tasks/TasksView";

const MIN_WIDTH = 220;
const MIN_HEIGHT = 160;

/**
 * A task or a note on the canvas. Both are plain DOM with no native surface
 * to protect (unlike BrowserCard's <webview>), so — per nodeProjection.ts's
 * buildPinFlowNodes — this lives directly inside React Flow's own node tree
 * and gets its drag/select/resize from React Flow; the header drags, the
 * rest is for working in (nodrag).
 */
/** As a selected browser shows. */
const SELECTED_OUTLINE = { outline: "2px solid var(--accent)", outlineOffset: -2 } as const;

export function PinNode({ data }: NodeProps<PinFlowNode>) {
  const [hovered, setHovered] = useState(false);
  const pin = usePinStore((state) =>
    state.pinsByProject[data.projectPath]?.find((p) => p.id === data.pinId),
  );
  const isSelected = useSelectionStore((state) =>
    state.selectedItems.some((item) => item.type === "pin" && item.pinId === data.pinId),
  );

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      if (!pin) return;
      updatePinInScene(pin.repo, pin.id, {
        w: Math.round(params.width),
        h: Math.round(params.height),
      });
    },
    [pin],
  );

  if (!pin) return null;
  const task = pinKind(pin) === "task";
  const needs = task && pin.status === "needs_you";

  return (
    <div
      data-record-node={`note:${pin.id}`}
      className="flex h-full w-full flex-col overflow-hidden rounded-lg border"
      style={
        task
          ? {
              background: "var(--surface)",
              borderColor: needs ? "color-mix(in srgb, var(--amber) 55%, var(--border))" : "var(--border)",
              boxShadow: "var(--shadow-elev-1)",
              ...(isSelected ? SELECTED_OUTLINE : {}),
            }
          : {
              background: "color-mix(in srgb, var(--amber) 10%, var(--surface))",
              borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))",
              boxShadow: "var(--shadow-elev-1)",
              ...(isSelected ? SELECTED_OUTLINE : {}),
            }
      }
      // Pressing anywhere in it, or typing in it, is being on this task or
      // note, as with a browser: the grid opens on it. Capture, since its
      // fields and buttons keep their presses from the canvas.
      onMouseDownCapture={() => {
        if (!isSelected) activatePinInScene(pin.id);
      }}
      onFocus={() => {
        if (!isSelected) activatePinInScene(pin.id);
      }}
      onMouseEnter={() => {
        setHovered(true);
        // Same reason as BrowserCard: a note wired to an agent should light
        // that wire from the note's end too.
        window.dispatchEvent(new CustomEvent("tacit:node-hover", { detail: { kind: "note", id: pin.id } }));
      }}
      onMouseLeave={() => {
        setHovered(false);
        window.dispatchEvent(new CustomEvent("tacit:node-hover", { detail: null }));
      }}
    >
      <NodeResizer
        isVisible={hovered}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        handleStyle={{ width: 8, height: 8, background: "var(--surface)", borderColor: "var(--border-hover)" }}
        onResizeEnd={handleResizeEnd}
      />
      {task ? <TaskBody pin={pin} /> : <NoteBody pin={pin} />}
    </div>
  );
}

function useTitle(pin: Pin) {
  const [title, setTitle] = useState(pin.title);
  useEffect(() => setTitle(pin.title), [pin.id, pin.title]);
  const commit = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== pin.title) updatePinInScene(pin.repo, pin.id, { title: trimmed });
    else setTitle(pin.title);
  };
  return { title, setTitle, commit };
}

function MoreMenu({ pin }: { pin: Pin }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [armDelete, setArmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const task = pinKind(pin) === "task";
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setArmDelete(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const item = "tc-rail-btn flex w-full items-center px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-primary)]";
  return (
    <div ref={ref} className="nodrag relative">
      <button
        type="button"
        className="tc-rail-btn inline-flex h-6 w-6 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-label={t.task_more}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="tc-float absolute right-0 top-7 z-30 w-[200px] p-1.5" style={{ borderRadius: 10 }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); openPinFull(pin); }}>
            {t.task_open_full}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); void (task ? makeNote(pin) : makeTask(pin)); }}>
            {task ? t.task_make_note : t.note_make_task}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); void removeFromCanvas(pin); }}>
            {t.task_remove_from_canvas}
          </button>
          <div className="mx-1 my-1 h-px bg-[var(--border)]" />
          <button
            type="button"
            role="menuitem"
            className={`${item} text-[var(--red)]`}
            onClick={() => {
              if (armDelete) {
                setOpen(false);
                void deleteTask(pin);
              } else setArmDelete(true);
            }}
          >
            {armDelete ? t.task_delete_confirm : task ? t.task_delete : t.note_delete}
          </button>
        </div>
      )}
    </div>
  );
}

function TaskBody({ pin }: { pin: Pin }) {
  const t = useT();
  const { title, setTitle, commit } = useTitle(pin);
  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5" data-scene-box-select-block>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 4l1.2 1.2L6 3M2.5 8l1.2 1.2L6 7M2.5 12h0.01M8 4h5.5M8 8h5.5M8 12h5.5" />
        </svg>
        <span className="nodrag">
          <StatusChip task={pin} />
        </span>
        <ProgressBar task={pin} width={36} />
        <span className="flex-1" />
        <MoreMenu pin={pin} />
      </div>
      <div className="nodrag nowheel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2" data-scene-box-select-block>
        <label>
          <span className="sr-only">{t.task_title_placeholder}</span>
          <input
            className="w-full rounded-md bg-transparent px-1 py-0.5 text-[13.5px] font-semibold text-[var(--text-primary)] outline-none focus:bg-[var(--surface-hover)]"
            value={title}
            placeholder={t.task_title_placeholder}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onFocus={(e) => {
              if (pin.title === "Untitled task") e.target.select();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </label>
        <NeedsYouBlock task={pin} />
        <StepList task={pin} />
        <OwnerChips task={pin} emptyHint={t.task_nobody} />
      </div>
    </>
  );
}

function NoteBody({ pin }: { pin: Pin }) {
  const t = useT();
  const { title, setTitle, commit } = useTitle(pin);
  const [body, setBody] = useState(pin.body);
  useEffect(() => setBody(pin.body), [pin.id, pin.updated]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div
        data-scene-box-select-block
        className="flex flex-none items-center gap-1.5 border-b px-2.5 py-1.5"
        style={{ borderColor: "color-mix(in srgb, var(--amber) 25%, var(--border))" }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t.note_title_placeholder}</span>
          <input
            data-scene-box-select-block
            className="nodrag w-full bg-transparent text-[13px] font-medium text-[var(--text-primary)] outline-none"
            value={title}
            placeholder={t.note_title_placeholder}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </label>
        <button
          type="button"
          className="nodrag tc-rail-btn h-6 shrink-0 border px-2 text-[11px] text-[var(--text-secondary)]"
          style={{ borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))" }}
          onClick={() => void makeTask(pin)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {t.note_make_task}
        </button>
        <MoreMenu pin={pin} />
      </div>
      <textarea
        data-scene-box-select-block
        className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)] outline-none"
        style={{ fontFamily: '"Geist Mono", monospace' }}
        placeholder={t.note_body_placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => {
          if (body !== pin.body) updatePinInScene(pin.repo, pin.id, { body });
        }}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </>
  );
}
