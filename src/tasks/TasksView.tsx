import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { usePinStore } from "../stores/pinStore";
import { useProjectStore } from "../stores/projectStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { visibleCanvasCenter } from "../actions/dockActions";
import { flyToBounds } from "../utils/panToTerminal";
import type { Pin } from "../types";
import { pinKind } from "../../shared/pin";
import { FILTERS, countByFilter, filterTasks, isTask, sortTasks, type TaskFilter } from "./taskModel";
import { NeedsYouBlock, OwnerChips, ProgressBar, StatusChip, StatusDot, StepList, statusLabel } from "./TaskParts";
import { createTask, deleteTask, handTaskToManager, makeNote, updateTask } from "./taskActions";

/**
 * The project's tasks, in the docked chat (it took over from the Pins
 * list). One list for the person and every agent: whoever needs you first,
 * then work under way. A task opens in place to its steps and actions; its
 * full editor opens beside the chat (or in a tab in the workdesk view).
 */

const DEFAULT_W = 300;
const DEFAULT_H = 220;

/** Opens a task or note full size: a tab in the workdesk view, else beside the chat. */
export function openPinFull(pin: Pin): void {
  if (useWorkdeskViewStore.getState().mode === "grid") {
    useWorkdeskViewStore.getState().setOpenNode({ kind: pinKind(pin), id: pin.id });
    return;
  }
  const store = usePinStore.getState();
  if (store.openProjectPath !== pin.repo) store.openDrawer(pin.repo);
  store.openDetail(pin.id);
}

/** Shows it on the canvas, putting it there first (in view) when it isn't. */
export async function showPinOnCanvas(pin: Pin): Promise<void> {
  useWorkdeskViewStore.getState().setMode("canvas");
  let placed = pin;
  if (typeof pin.x !== "number" || typeof pin.y !== "number") {
    const center = visibleCanvasCenter();
    placed = (await updateTask(pin, { x: Math.round(center.x - DEFAULT_W / 2), y: Math.round(center.y - DEFAULT_H / 2) })) ?? pin;
  }
  if (typeof placed.x === "number" && typeof placed.y === "number") flyToBounds(placed.x, placed.y, placed.w ?? DEFAULT_W, placed.h ?? DEFAULT_H);
}

function TaskRow({ task, open, onToggle, autoEdit }: { task: Pin; open: boolean; onToggle: () => void; autoEdit: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(autoEdit);
  const [title, setTitle] = useState(task.title);
  const [armDelete, setArmDelete] = useState(false);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => {
    if (!armDelete) return;
    const timer = window.setTimeout(() => setArmDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armDelete]);
  const onCanvas = typeof task.x === "number" && typeof task.y === "number";
  const needs = task.status === "needs_you";
  const commitTitle = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== task.title) void updateTask(task, { title: next });
    else setTitle(task.title);
  };
  const action = "tc-rail-btn inline-flex h-7 items-center gap-1.5 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]";
  return (
    <div
      className="rounded-[11px] border"
      style={{
        borderColor: needs ? "color-mix(in srgb, var(--amber) 45%, transparent)" : open ? "var(--border-hover)" : "var(--border)",
        background: "color-mix(in srgb, var(--bg) 55%, transparent)",
      }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button type="button" className="mt-[5px]" onClick={onToggle} aria-label={statusLabel(task.status, t)} aria-expanded={open}>
          <StatusDot status={task.status} size={9} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {editing ? (
            <label>
              <span className="sr-only">{t.task_title_placeholder}</span>
              <input
                autoFocus
                value={title}
                placeholder={t.task_title_placeholder}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") {
                    setTitle(task.title);
                    setEditing(false);
                  }
                }}
                className="w-full rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[13px] font-medium text-[var(--text-primary)] outline-none"
              />
            </label>
          ) : (
            <button
              type="button"
              className={`text-left text-[13px] font-medium leading-snug ${task.status === "done" || task.status === "dropped" ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}
              onClick={onToggle}
              onDoubleClick={() => setEditing(true)}
              title={task.title}
            >
              {task.title}
            </button>
          )}
          <span className="flex flex-wrap items-center gap-2">
            <StatusChip task={task} />
            <ProgressBar task={task} />
            <OwnerChips task={task} />
          </span>
        </div>
      </div>
      {needs && (
        <div className="px-3 pb-2.5 pl-[30px]">
          <NeedsYouBlock task={task} />
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-6">
          <StepList task={task} />
          <span className="flex flex-wrap gap-1.5 pl-1.5">
            {task.status !== "done" && (task.owners ?? []).every((o) => o !== "manager") && (
              <button type="button" className={action} onClick={() => void handTaskToManager(task)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 2.5v11M4 9.5l4 4 4-4" />
                </svg>
                {t.task_hand}
              </button>
            )}
            {task.status === "done" || task.status === "dropped" ? (
              <button type="button" className={action} onClick={() => void updateTask(task, { status: "in_progress" })}>
                {t.task_reopen}
              </button>
            ) : (
              <button type="button" className={action} onClick={() => void updateTask(task, { status: "done" })}>
                {t.task_mark_done}
              </button>
            )}
            <button type="button" className={action} onClick={() => void showPinOnCanvas(task)}>
              {onCanvas ? t.task_show_on_canvas : t.task_put_on_canvas}
            </button>
            <button type="button" className={action} onClick={() => openPinFull(task)}>
              {t.task_open_full}
            </button>
            <button type="button" className={action} onClick={() => void makeNote(task)}>
              {t.task_make_note}
            </button>
            <button
              type="button"
              className="tc-rail-btn inline-flex h-7 items-center px-2.5 text-[12px] text-[var(--red)]"
              onClick={() => {
                if (armDelete) void deleteTask(task);
                else setArmDelete(true);
              }}
            >
              {armDelete ? t.task_delete_confirm : t.task_delete}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function TasksView() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const openProjectPath = usePinStore((s) => s.openProjectPath);
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const openDrawer = usePinStore((s) => s.openDrawer);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [justMade, setJustMade] = useState<string | null>(null);

  // Opened from the header icon rather than a project's badge: the first project.
  useEffect(() => {
    if (!openProjectPath && projects[0]) openDrawer(projects[0].path);
  }, [openProjectPath, projects, openDrawer]);

  const pins = openProjectPath ? (pinsByProject[openProjectPath] ?? null) : null;
  const tasks = useMemo(() => sortTasks((pins ?? []).filter(isTask)), [pins]);
  const counts = useMemo(() => countByFilter(tasks), [tasks]);
  const shown = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const filters: TaskFilter[] = counts.dropped > 0 ? [...FILTERS, "dropped"] : [...FILTERS];

  if (projects.length === 0) {
    return <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">{t.chat_pins_no_project}</div>;
  }

  const add = async () => {
    if (!openProjectPath) return;
    const made = await createTask(openProjectPath);
    if (made) {
      setFilter("all");
      setExpanded(made.id);
      setJustMade(made.id);
      // A new task opens full size, beside the chat, to write it out.
      openPinFull(made);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {projects.length > 1 && (
        <div className="flex shrink-0 items-center px-3 pt-2.5">
          <label className="flex h-[28px] min-w-0 items-center rounded-[8px] border border-[var(--border)] px-2 text-[12.5px] text-[var(--text-primary)]">
            <span className="sr-only">{t.task_project}</span>
            <select value={openProjectPath ?? ""} onChange={(e) => openDrawer(e.target.value)} className="min-w-0 max-w-[200px] bg-transparent text-[12.5px] outline-none">
              {projects.map((project) => (
                <option key={project.id} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-2 pt-2.5" role="group" aria-label={t.tasks_title}>
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[var(--text-secondary)] text-[var(--bg)] hover:bg-[var(--text-primary)] disabled:opacity-40"
          onClick={() => void add()}
          disabled={!openProjectPath}
          title={t.tasks_new}
          aria-label={t.tasks_new}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        {filters.map((f) => {
          const on = filter === f;
          const count = counts[f];
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              className="tc-rail-btn inline-flex h-7 items-center gap-1.5 border px-2.5 text-[12px]"
              style={{ borderColor: on ? "var(--border-hover)" : "var(--border)", color: on ? "var(--text-primary)" : "var(--text-muted)", background: on ? "var(--surface-hover)" : undefined }}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? t.tasks_filter_all : statusLabel(f, t)}
              <span className="tc-mono text-[10.5px] tabular-nums" style={{ color: f === "needs_you" && count > 0 ? "var(--amber)" : undefined }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {pins === null ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">{t["pin.loading"]}</div>
        ) : tasks.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">{t.tasks_empty}</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-[var(--text-muted)]">{t.tasks_none_here}</div>
        ) : (
          shown.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              open={expanded === task.id}
              autoEdit={justMade === task.id}
              onToggle={() => setExpanded((cur) => (cur === task.id ? null : task.id))}
            />
          ))
        )}
      </div>
    </div>
  );
}
