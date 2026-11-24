import { useState } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { columnOf, type Column } from "../../shared/task";
import { useProjectStore } from "../stores/projectStore";
import { changeTask, goToTerminal, openTask } from "./taskActions";
import { HandOverButton } from "./HandOver";
import { RequestBlock } from "./RequestBlock";
import { COLUMN_COLOR, PRIORITY_COLOR, partTry, runLines, sortRequests, waitsForYou } from "./taskWords";

export const TASK_DRAG = "application/x-tacit-task";

/** The name a folder goes by on this workdesk; its last part when it isn't here. */
export function useFolderName(path: string | null): string {
  const projects = useProjectStore((s) => s.projects);
  if (!path) return "";
  return projects.find((p) => p.path === path)?.name ?? projects.flatMap((p) => p.worktrees).find((w) => w.path === path)?.name ?? path.split("/").pop() ?? path;
}

export function Dot({ column, size = 8, hollow }: { column: Column; size?: number; hollow?: boolean }) {
  return <span aria-hidden="true" className="tc-tk-dot" style={{ width: size, height: size, ...(hollow ? { boxShadow: `inset 0 0 0 1.5px ${COLUMN_COLOR[column]}` } : { background: COLUMN_COLOR[column] }) }} />;
}

/** One task on the board: what it is, what's happening, and what it needs from you. */
export function TaskCard({ task, reason, onDrag }: { task: Task; reason?: string | null; onDrag?: (id: string | null) => void }) {
  const t = useT();
  const folder = useFolderName(task.folder);
  const [all, setAll] = useState(false);
  const column = columnOf(task);
  const requests = sortRequests(task);
  // The one you filtered for first; the rest one press away.
  const ordered = reason ? [...requests.filter((r) => r.kind === reason), ...requests.filter((r) => r.kind !== reason)] : requests;
  const shown = all ? ordered : ordered.slice(0, 1);
  const runs = runLines(task).filter((r) => r.part === null);
  const closed = task.closed;
  return (
    <article
      className="tc-tk-card"
      data-column={column}
      data-unseen={closed && !task.seen ? "true" : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_DRAG, task.id);
        e.dataTransfer.effectAllowed = "copyMove";
        onDrag?.(task.id);
      }}
      onDragEnd={() => onDrag?.(null)}
    >
      <button type="button" className="tc-tk-card-open" onClick={() => openTask(task.id)}>
        <span className="tc-tk-card-top">
          {closed && !task.seen && <span className="tc-tk-unseen" title={t.tb.unseen} aria-label={t.tb.unseen} />}
          <span className="tc-tk-id">{`T-${task.n}`}</span>
          {folder && <span className="truncate">{folder}</span>}
          <span className="flex-1" />
          {task.priority !== "none" && <span style={{ color: PRIORITY_COLOR[task.priority] }}>{t.tb.priorities[task.priority]}</span>}
        </span>
        <span className="tc-tk-card-title">{task.title || t.tb.untitled}</span>
      </button>
      {runs.map((r) => (
        <button key={r.id} type="button" className="tc-tk-run" onClick={() => goToTerminal(r.terminal)} title={t.tb.openTerminal}>
          <Dot column={r.state === "working" ? "working" : "next"} hollow={r.state === "queued" || r.state === "sending"} />
          <span className="truncate">{r.name}</span>
          <span className="shrink-0">{r.waits ? t.tb.waitsForYou : t.tb.runs[r.state]}</span>
        </button>
      ))}
      {!closed && task.parts.length > 0 && (
        <ul className="tc-tk-parts">
          {task.parts.map((p) => {
            const on = partTry(task, p.id);
            return (
              <li key={p.id}>
                <Dot column={p.state === "done" ? "done" : p.state === "doing" ? "working" : "later"} hollow={p.state === "todo"} />
                <span className={`min-w-0 flex-1 truncate ${p.state === "done" ? "text-[var(--text-metadata)]" : ""}`}>{p.text}</span>
                <span className="max-w-[45%] truncate text-[var(--text-metadata)]">{p.state === "done" ? t.tb.partStates.done : on && p.state === "doing" ? `${on.name}, ${waitsForYou(task, on) ? t.tb.waitsForYou : t.tb.runs[on.state]}` : ""}</span>
              </li>
            );
          })}
        </ul>
      )}
      {shown.map((r) => (
        <RequestBlock key={r.id} task={task} request={r} />
      ))}
      {ordered.length > 1 && (
        <button type="button" className="tc-tk-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t.tb.cancel : `+${ordered.length - 1}`}
        </button>
      )}
      {closed?.as === "done" && (
        <p className="tc-tk-proof">
          {closed.how}
          {task.landed && t.tb.landed[task.landed.state] ? ` · ${t.tb.landed[task.landed.state]}` : ""}
        </p>
      )}
      {(column === "next" || column === "later") && (
        <span className="tc-tk-card-foot">
          <HandOverButton task={task} />
          <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => void changeTask(task, { op: "wait", wait: column === "next" ? "later" : "next" })}>
            {column === "next" ? t.tb.columns.later : t.tb.columns.next}
          </button>
        </span>
      )}
    </article>
  );
}
