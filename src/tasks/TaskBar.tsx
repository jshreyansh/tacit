import { useState } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { RequestBlock } from "./RequestBlock";
import { Dot } from "./TaskCard";
import { columnOf } from "../../shared/task";
import { runLines, sortRequests } from "./taskWords";
import "./tasks.css";

/** The manager's task, above its message box: where it's got to, and what it needs from you. */
export function TaskBar({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const done = task.parts.filter((p) => p.state === "done").length;
  const requests = sortRequests(task);
  return (
    <div className="mx-3 mb-2 rounded-[10px] border px-3 py-2" style={{ borderColor: requests.length ? "color-mix(in srgb, var(--amber) 45%, transparent)" : "var(--border)" }}>
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-metadata)]">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Dot column={columnOf(task)} />
          <span className="tc-tk-id">{`T-${task.n}`}</span>
          {task.parts.length > 0 && <span className="tabular-nums">{`${done}/${task.parts.length}`}</span>}
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{task.title}</span>
        </button>
        <button type="button" className="tc-tk-btn tc-tk-quiet" onClick={onOpen}>
          {t.chat_task_open}
        </button>
      </div>
      {requests.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {requests.map((r) => (
            <RequestBlock key={r.id} task={task} request={r} />
          ))}
        </div>
      )}
      {open && (
        <ul className="tc-tk-parts mt-2">
          {task.parts.map((p) => (
            <li key={p.id}>
              <Dot column={p.state === "done" ? "done" : p.state === "doing" ? "working" : "later"} hollow={p.state === "todo"} />
              <span className="min-w-0 flex-1 truncate">{p.text}</span>
            </li>
          ))}
          {runLines(task).map((r) => (
            <li key={r.id}>
              <Dot column="working" />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="text-[var(--text-metadata)]">{r.waits ? t.tb.waitsForYou : t.tb.runs[r.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
