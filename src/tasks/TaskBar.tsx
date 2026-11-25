import { useState } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { columnOf } from "../../shared/task";
import { TaskAsks } from "./TaskAsks";
import { Dot, RunRow, TaskParts } from "./TaskCard";
import { runLines, sortRequests } from "./taskWords";
import "./tasks.css";

/** The manager's task, above its message box: where it's got to, and what it needs from you. */
export function TaskBar({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const done = task.parts.filter((p) => p.state === "done").length;
  return (
    <div className="tc-tk-card mx-3 mb-2">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-metadata)]">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Dot column={columnOf(task)} />
          <span className="tc-tk-id">{`T-${task.n}`}</span>
          {task.parts.length > 0 && <span className="tabular-nums">{`${done}/${task.parts.length}`}</span>}
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{task.title}</span>
        </button>
        <button type="button" className="tc-tk-btn" data-quiet="true" onClick={onOpen}>
          {t.chat_task_open}
        </button>
      </div>
      {open && (
        <div className="tc-tk-card-mid">
          <TaskParts task={task} />
          {runLines(task).map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      )}
      <TaskAsks task={task} requests={sortRequests(task)} />
    </div>
  );
}
