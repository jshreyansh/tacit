import { useState, type ReactNode } from "react";
import { toolVerb } from "../components/transcriptModel";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { columnOf, type Column } from "../../shared/task";
import { findTerminal } from "../actions/terminalLookup";
import { useProjectStore } from "../stores/projectStore";
import { changeTask, goToTerminal, openTask } from "./taskActions";
import { AgentMark, HandOverButton } from "./HandOver";
import { TaskAsks } from "./TaskAsks";
import { COLUMN_COLOR, PRIORITY_COLOR, ago, partTry, runLines, sortRequests, waitsForYou } from "./taskWords";
import { useNow } from "./useNow";

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

/** How a priority shows: nothing for none, else bars filled to its level. */
export function PriorityMark({ priority, bare }: { priority: Task["priority"]; /** The bars alone, with the word on hover. */ bare?: boolean }) {
  const t = useT();
  if (priority === "none") return null;
  const level = { low: 1, medium: 2, high: 3, urgent: 4 }[priority];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" style={{ color: PRIORITY_COLOR[priority] }} title={t.tb.priorities[priority]}>
      <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 3.4} y={8 - i * 2.4} width="2.2" height={3 + i * 2.4} rx="0.8" fill="currentColor" opacity={i < level ? 1 : 0.25} />
        ))}
      </svg>
      <span className={bare ? "sr-only" : undefined}>{t.tb.priorities[priority]}</span>
    </span>
  );
}

const KIND_MARK: Record<Task["kind"], ReactNode> = {
  build: <path d="M8 1.8l5.4 3v6.4L8 14.2l-5.4-3V4.8zM2.8 4.9L8 7.8l5.2-2.9M8 7.8v6.2" />,
  bug: <path d="M5.2 6.2a2.8 2.8 0 015.6 0v3.6a2.8 2.8 0 01-5.6 0zM5.2 8H2.4M13.6 8h-2.8M5.4 5.4L3.4 3.6M10.6 5.4l2-1.8M5.4 10.6l-2 1.8M10.6 10.6l2 1.8M6.4 3.6L5.6 2.2M9.6 3.6l.8-1.4" />,
  research: <path d="M7 2.4a4.6 4.6 0 100 9.2 4.6 4.6 0 000-9.2zM10.4 10.4l3.4 3.4" />,
  write: <path d="M3 13h2.6l7-7-2.6-2.6-7 7zM8.6 4.8l2.6 2.6" />,
  other: <path d="M4.6 2.6h6.8a2 2 0 012 2v6.8a2 2 0 01-2 2H4.6a2 2 0 01-2-2V4.6a2 2 0 012-2zM5.4 8.2l1.8 1.8 3.4-3.8" />,
};

/** What kind of work it is. */
export function KindMark({ kind }: { kind: Task["kind"] }) {
  const t = useT();
  return (
    <span className="tc-tk-kindmark" title={t.tb.kinds[kind]}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {KIND_MARK[kind]}
      </svg>
      <span className="sr-only">{t.tb.kinds[kind]}</span>
    </span>
  );
}

/** Its name, with what it is, where it is and how long. The same on the board and on the canvas. */
export function TaskHead({ task, id = true }: { task: Task; /** The canvas tile has it in its header. */ id?: boolean }) {
  const t = useT();
  const now = useNow();
  const folder = useFolderName(task.folder);
  const closed = task.closed;
  return (
    <span className="tc-tk-cardhead">
      <KindMark kind={task.kind} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="tc-tk-card-title">
          {closed && !task.seen && <span className="tc-tk-unseen" title={t.tb.unseen} aria-label={t.tb.unseen} />}
          {task.title || t.tb.untitled}
        </span>
        <span className="tc-tk-cardmeta">
          {id && <span className="tc-tk-id">{`T-${task.n}`}</span>}
          {folder && <span className="min-w-0 truncate">{folder}</span>}
          <span className="shrink-0">{ago(closed?.at ?? task.updated, now) === "now" ? t.tb.waited("now") : ago(closed?.at ?? task.updated, now)}</span>
          {!closed && task.doneWhen.length > 0 && <span className="shrink-0">{t.tb.checksCount(task.doneWhen.length)}</span>}
        </span>
      </span>
      {id && <PriorityMark priority={task.priority} bare />}
    </span>
  );
}

/** An agent on it: who, and under that what it's doing, with the tool in its hand. Takes you to its terminal. */
export function RunRow({ run }: { run: ReturnType<typeof runLines>[number] }) {
  const t = useT();
  const type = findTerminal(run.terminal)?.terminal.type ?? "";
  const tool = useTerminalRuntimeStore((s) => s.terminals[run.terminal]?.telemetry?.foreground_tool);
  const working = run.state === "working" && !run.waits;
  return (
    <button type="button" className="tc-tk-run" data-working={working || undefined} onClick={() => goToTerminal(run.terminal)} title={t.tb.openTerminal}>
      <span className="tc-tk-runmark">
        <AgentMark type={type} size={17} />
        {working && <span className="tc-live-pip tc-tk-runpip" aria-hidden="true" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px] text-[var(--text-primary)]">{run.name}</span>
        <span className="truncate text-[12px]">
          {run.waits ? t.tb.waitsForYou : t.tb.runs[run.state]}
          {working && tool && `, ${t.tb.using(toolVerb(tool))}`}
        </span>
      </span>
    </button>
  );
}

export function TaskParts({ task }: { task: Task }) {
  const t = useT();
  if (task.parts.length === 0) return null;
  const done = task.parts.filter((p) => p.state === "done").length;
  return (
    <div className="flex flex-col gap-2">
      <span className="tc-tk-progress" role="img" aria-label={t.tb.partsDone(done, task.parts.length)}>
        {task.parts.map((p) => (
          <span key={p.id} data-state={p.state} />
        ))}
      </span>
      <ul className="tc-tk-parts">
        {task.parts.map((p) => {
          const on = partTry(task, p.id);
          return (
            <li key={p.id}>
              <Dot column={p.state === "done" ? "done" : p.state === "doing" ? "working" : "later"} hollow={p.state === "todo"} />
              <span className={`min-w-0 flex-1 truncate ${p.state === "done" ? "text-[var(--text-metadata)]" : ""}`}>{p.text}</span>
              {on && p.state === "doing" && <span className="max-w-[45%] truncate text-[var(--text-metadata)]">{waitsForYou(task, on) ? t.tb.waitsForYou : on.name}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What's on a task, under its name: the same on the board and on the canvas. */
export function TaskBody({ task, reason }: { task: Task; reason?: string | null }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const column = columnOf(task);
  const requests = sortRequests(task);
  // The one you filtered for first; the rest one press away. One agent's questions are one card.
  const ordered = reason ? [...requests.filter((r) => r.kind === reason), ...requests.filter((r) => r.kind !== reason)] : requests;
  const first = ordered[0];
  const shown = all || !first ? ordered : ordered.filter((r) => r === first || (first.kind === "decide" && r.kind === "decide" && r.by === first.by));
  const runs = runLines(task).filter((r) => r.part === null);
  const closed = task.closed;
  const waits = column === "next" || column === "later";
  return (
    <>
      {(runs.length > 0 || (!closed && task.parts.length > 0) || closed?.as === "done" || waits) && (
        <div className="tc-tk-card-mid">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
          {!closed && <TaskParts task={task} />}
          {closed?.as === "done" && (
            <p className="tc-tk-proof">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              <span className="min-w-0">
                {closed.how}
                {task.landed && t.tb.landed[task.landed.state] && <span className="block">{t.tb.landed[task.landed.state]}</span>}
              </span>
            </p>
          )}
          {waits && (
            <span className="tc-tk-card-foot">
              <HandOverButton task={task} />
              <span className="flex-1" />
              <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => void changeTask(task, { op: "wait", wait: column === "next" ? "later" : "next" })}>
                {column === "next" ? t.tb.columns.later : t.tb.columns.next}
              </button>
            </span>
          )}
        </div>
      )}
      <TaskAsks task={task} requests={shown} />
      {ordered.length > shown.length && (
        <button type="button" className="tc-tk-more-asks" onClick={() => setAll(true)}>
          {t.tb.moreAsks(ordered.length - shown.length)}
        </button>
      )}
    </>
  );
}

/** One task on the board: what it is, what's happening, and what it needs from you. */
export function TaskCard({ task, reason, onDrag }: { task: Task; reason?: string | null; onDrag?: (id: string | null) => void }) {
  const column = columnOf(task);
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
        <TaskHead task={task} />
      </button>
      <TaskBody task={task} reason={reason} />
    </article>
  );
}
