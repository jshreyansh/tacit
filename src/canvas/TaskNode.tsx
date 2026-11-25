import { useCallback } from "react";
import { type NodeProps } from "@xyflow/react";
import { columnOf } from "../../shared/task";
import { activateTaskInScene } from "../actions/sceneSelectionActions";
import { useT } from "../i18n/useT";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { useSelectionStore } from "../stores/selectionStore";
import { openTask, takeOffCanvas } from "../tasks/taskActions";
import { Dot, PriorityMark, TaskBody, TaskHead } from "../tasks/TaskCard";
import { useTask } from "../tasks/taskStore";
import { TASK_TILE } from "../tasks/taskWords";
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
          <PriorityMark priority={task.priority} />
          <button type="button" className="nodrag tc-tk-icon" data-small="true" aria-label={t.tb.takeOffCanvas} title={t.tb.takeOffCanvas} onMouseDown={(e) => e.stopPropagation()} onClick={() => takeOffCanvas(task.id)}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="nodrag nowheel flex min-h-0 flex-1 flex-col overflow-y-auto" data-scene-box-select-block>
          <button type="button" className="tc-tk-tile-title" onClick={() => openTask(task.id)}>
            <TaskHead task={task} id={false} />
          </button>
          <TaskBody task={task} />
        </div>
      </div>
    </>
  );
}
