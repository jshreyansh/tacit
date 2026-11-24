import { useCallback } from "react";
import { type NodeProps } from "@xyflow/react";
import { columnOf } from "../../shared/task";
import { activateTaskInScene } from "../actions/sceneSelectionActions";
import { useT } from "../i18n/useT";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { useSelectionStore } from "../stores/selectionStore";
import { openTask, takeOffCanvas } from "../tasks/taskActions";
import { HandOverButton } from "../tasks/HandOver";
import { RequestBlock } from "../tasks/RequestBlock";
import { Dot } from "../tasks/TaskCard";
import { useTask } from "../tasks/taskStore";
import { TASK_TILE, partTry, runLines, sortRequests } from "../tasks/taskWords";
import { flyToBounds } from "../utils/panToTerminal";
import type { TaskFlowNode } from "./nodeProjection";
import { TileFarLabel, TileMoveSurface, useZoomedOut } from "./TileFarChrome";
import { TileResizer } from "./TileResizer";
import "../tasks/tasks.css";

/** As a selected browser shows. */
const SELECTED_OUTLINE = { outline: "2px solid var(--accent)", outlineOffset: -2 } as const;
const MIN = { w: 220, h: 120 };

/**
 * A task on the canvas. Plain DOM in React Flow's own node tree: the header
 * drags, the rest is for working in.
 */
export function TaskNode({ data, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<TaskFlowNode>) {
  const t = useT();
  const far = useZoomedOut();
  const task = useTask(data.taskId);
  const selected = useSelectionStore((s) => s.selectedItems.some((i) => i.type === "task" && i.taskId === data.taskId));
  const onResizeEnd = useCallback(
    (_event: unknown, p: { x: number; y: number; width: number; height: number }) =>
      // From the top or left edge the position moves too.
      useRecordPlaceStore.getState().place(data.taskId, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }),
    [data.taskId],
  );
  if (!task) return null;
  const column = columnOf(task);
  const w = width ?? TASK_TILE.w;
  const h = height ?? TASK_TILE.h;
  const fly = () => flyToBounds(positionAbsoluteX, positionAbsoluteY, w, h);
  const activate = () => {
    if (!selected) activateTaskInScene(task.id);
  };
  return (
    <>
      <TileResizer minWidth={MIN.w} minHeight={MIN.h} onResizeEnd={onResizeEnd} />
      {far && (
        <>
          <TileFarLabel width={w} title={task.title} onOpen={fly} />
          <TileMoveSurface onOpen={fly} />
        </>
      )}
      <div
        data-record-node={`note:${task.id}`}
        // A wire being dragged can end here (src/canvas/ConnectionLayer.tsx).
        data-connect-kind="note"
        data-connect-id={task.id}
        className="tc-tk-tile"
        data-column={column}
        style={selected ? SELECTED_OUTLINE : undefined}
        // Pressing anywhere in it is being on this task, as with a browser.
        onMouseDownCapture={activate}
        onFocus={activate}
        onMouseEnter={() => window.dispatchEvent(new CustomEvent("tacit:node-hover", { detail: { kind: "note", id: task.id } }))}
        onMouseLeave={() => window.dispatchEvent(new CustomEvent("tacit:node-hover", { detail: null }))}
      >
        <div className="flex flex-none items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5" data-scene-box-select-block>
          <Dot column={column} />
          <span className="tc-tk-id">{`T-${task.n}`}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-metadata)]">{t.tb.columns[column]}</span>
          <button type="button" className="nodrag tc-tk-icon" data-small="true" aria-label={t.tb.takeOffCanvas} title={t.tb.takeOffCanvas} onMouseDown={(e) => e.stopPropagation()} onClick={() => takeOffCanvas(task.id)}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="nodrag nowheel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2" data-scene-box-select-block>
          <button type="button" className="text-left text-[14px] font-semibold leading-snug text-[var(--text-primary)] hover:underline" onClick={() => openTask(task.id)}>
            {task.title || t.tb.untitled}
          </button>
          {runLines(task)
            .filter((r) => r.part === null)
            .map((r) => (
              <span key={r.id} className="tc-tk-run">
                <Dot column={r.state === "working" ? "working" : "next"} />
                <span className="truncate">{r.name}</span>
                <span className="shrink-0">{r.waits ? t.tb.waitsForYou : t.tb.runs[r.state]}</span>
              </span>
            ))}
          {task.parts.length > 0 && (
            <ul className="tc-tk-parts">
              {task.parts.map((p) => {
                const on = partTry(task, p.id);
                return (
                  <li key={p.id}>
                    <Dot column={p.state === "done" ? "done" : p.state === "doing" ? "working" : "later"} hollow={p.state === "todo"} />
                    <span className="min-w-0 flex-1 truncate">{p.text}</span>
                    {on && p.state === "doing" && <span className="max-w-[45%] truncate text-[var(--text-metadata)]">{on.name}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {sortRequests(task).map((r) => (
            <RequestBlock key={r.id} task={task} request={r} />
          ))}
          {task.closed?.as === "done" && <p className="tc-tk-proof">{task.closed.how}</p>}
          {(column === "next" || column === "later") && (
            <span>
              <HandOverButton task={task} />
            </span>
          )}
        </div>
      </div>
    </>
  );
}
