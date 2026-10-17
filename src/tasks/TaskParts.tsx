import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import type { Pin, PinStatus } from "../types";
import type { TaskStep } from "../../shared/pin";
import { useProjectStore } from "../stores/projectStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { findTerminal } from "../actions/terminalLookup";
import { agentIcon } from "../toolbar/agentIcons";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { PICKABLE_STATUSES, STATUS_COLOR, cycleStep, moveStep, progressOf } from "./taskModel";
import { answerTask, updateTask } from "./taskActions";

/**
 * The pieces every view of a task shares (Tasks in the chat, the node on
 * the canvas, the full-size editor): its status, steps, who's on it, and
 * an agent's question with the person's answer.
 */

type Dict = ReturnType<typeof useT>;

export function statusLabel(status: PinStatus, t: Dict): string {
  return {
    open: t.task_status_open,
    in_progress: t.task_status_in_progress,
    needs_you: t.task_status_needs_you,
    done: t.task_status_done,
    dropped: t.task_status_dropped,
  }[status];
}

/** A task owner as people read it: the manager, a terminal by its name, or a closed one. */
export function useOwnerView(owner: string): { label: string; icon: string | null; closed: boolean } {
  const t = useT();
  useProjectStore((s) => s.projects);
  const managerId = useCanvasRegistryStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.workspaceManagerTerminalId ?? null,
  );
  if (owner === "manager" || owner === managerId) {
    const manager = managerId ? findTerminal(managerId)?.terminal : null;
    return { label: t.task_owner_manager, icon: (manager ? agentIcon(manager.type) : null) ?? null, closed: false };
  }
  const found = findTerminal(owner);
  if (!found) return { label: t.task_owner_closed, icon: null, closed: true };
  return { label: found.terminal.customTitle?.trim() || found.terminal.title, icon: agentIcon(found.terminal.type) ?? null, closed: false };
}

function OwnerChip({ owner }: { owner: string }) {
  const view = useOwnerView(owner);
  return (
    <span
      className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-[var(--border)] py-px pl-1 pr-2 text-[11px] text-[var(--text-muted)]"
      style={{ opacity: view.closed ? 0.6 : 1 }}
      title={owner}
    >
      {view.icon ? <img src={view.icon} alt="" className="h-3 w-3 object-contain" draggable={false} /> : <span className="h-3 w-3" />}
      <span className="truncate">{view.label}</span>
    </span>
  );
}

export function OwnerChips({ task, emptyHint }: { task: Pin; emptyHint?: string }) {
  const owners = task.owners ?? [];
  if (owners.length === 0) return emptyHint ? <span className="text-[11px] text-[var(--text-faint)]">{emptyHint}</span> : null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {owners.map((o) => (
        <OwnerChip key={o} owner={o} />
      ))}
    </span>
  );
}

export function StatusDot({ status, size = 8 }: { status: PinStatus; size?: number }) {
  const style =
    status === "open"
      ? { width: size, height: size, border: "1.5px solid var(--text-muted)" }
      : { width: size, height: size, background: STATUS_COLOR[status] };
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={style} />;
}

/** The status as a chip; clicking it picks another (Needs you is an agent's to set). */
export function StatusChip({ task }: { task: Pin }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const color = STATUS_COLOR[task.status];
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        className="inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px]"
        style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {statusLabel(task.status, t)}
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={t.task_status_menu} className="tc-float absolute left-0 top-7 z-30 w-[210px] p-1.5" style={{ borderRadius: 10 }} onMouseDown={(e) => e.stopPropagation()}>
          {PICKABLE_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={task.status === status}
              className="tc-rail-btn flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-primary)]"
              data-on={task.status === status ? "" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                void updateTask(task, { status });
              }}
            >
              <StatusDot status={status} />
              {statusLabel(status, t)}
            </button>
          ))}
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] leading-snug text-[var(--text-faint)]">{t.task_needs_you_by_agent}</div>
        </div>
      )}
    </span>
  );
}

const MARK: Record<TaskStep["status"], { mark: string; color: string; text: string }> = {
  done: { mark: "✓", color: "var(--green)", text: "text-[var(--text-muted)] line-through" },
  active: { mark: "▸", color: "var(--cyan)", text: "text-[var(--text-primary)]" },
  pending: { mark: "○", color: "var(--text-faint)", text: "text-[var(--text-secondary)]" },
};

function stepAria(step: TaskStep, t: Dict): string {
  const state = step.status === "done" ? t.task_step_state_done : step.status === "active" ? t.task_step_state_active : t.task_step_state_pending;
  return t.task_step_cycle(step.text, state);
}

/** The steps as a checklist: click one to move it on; "+ step" adds one. */
export function StepList({ task, allowAdd = true }: { task: Pin; allowAdd?: boolean }) {
  const t = useT();
  const steps = task.steps ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-px">
      {steps.map((step, i) => (
        <button
          key={`${i}-${step.text}`}
          type="button"
          className="tc-rail-btn flex w-full items-start gap-2 px-1.5 py-1 text-left text-[12.5px] leading-snug"
          aria-label={stepAria(step, t)}
          onClick={(e) => {
            e.stopPropagation();
            void updateTask(task, { steps: cycleStep(steps, i) });
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span aria-hidden="true" className="w-3.5 shrink-0 text-center" style={{ color: MARK[step.status].color }}>
            {MARK[step.status].mark}
          </span>
          <span className={MARK[step.status].text}>{step.text}</span>
        </button>
      ))}
      {allowAdd && adding && (
        <label className="flex items-center gap-2 px-1.5 py-1">
          <span aria-hidden="true" className="w-3.5 text-center text-[var(--text-faint)]">
            ○
          </span>
          <span className="sr-only">{t.task_step_placeholder}</span>
          <input
            autoFocus
            value={draft}
            placeholder={t.task_step_placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              } else if (e.key === "Enter" && draft.trim()) {
                void updateTask(task, { steps: [...steps, { text: draft.trim(), status: "pending" }] });
                setDraft("");
              }
            }}
            onBlur={() => {
              if (!draft.trim()) setAdding(false);
            }}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
          />
        </label>
      )}
      {allowAdd && !adding && (
        <button
          type="button"
          className="tc-rail-btn w-fit px-1.5 py-1 text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={(e) => {
            e.stopPropagation();
            setAdding(true);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {t.task_add_step}
        </button>
      )}
    </div>
  );
}

/** An agent's question: its choices, or a typed answer, sent into its terminal. */
export function NeedsYouBlock({ task }: { task: Pin }) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const asker = useOwnerView(task.ask?.by ?? "");
  if (task.status !== "needs_you" || !task.ask) return null;
  const who = task.ask.by ? asker.label : t.task_owner_manager;
  return (
    <div
      className="flex flex-col gap-2 rounded-[9px] border px-2.5 py-2"
      style={{ borderColor: "color-mix(in srgb, var(--amber) 35%, transparent)", background: "color-mix(in srgb, var(--amber) 7%, transparent)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: "var(--amber)" }}>
        {asker.icon && task.ask.by && <img src={asker.icon} alt="" className="mt-px h-3.5 w-3.5 shrink-0 object-contain" draggable={false} />}
        <span>
          <span className="text-[var(--text-muted)]">{t.task_asks(who)}: </span>
          {task.ask.reason}
        </span>
      </span>
      {task.ask.choices && task.ask.choices.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {task.ask.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="tc-rail-btn h-7 border px-2.5 text-[12px] text-[var(--text-primary)]"
              style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, transparent)" }}
              onClick={(e) => {
                e.stopPropagation();
                void answerTask(task, choice);
              }}
            >
              {choice}
            </button>
          ))}
        </span>
      )}
      <label className="flex">
        <span className="sr-only">{t.task_answer_placeholder}</span>
        <input
          value={draft}
          placeholder={t.task_answer_placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && draft.trim()) {
              void answerTask(task, draft);
              setDraft("");
            }
          }}
          className="min-w-0 flex-1 rounded-md bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:ring-1 focus:ring-[var(--border-hover)]"
        />
      </label>
      {task.ask.by && <span className="text-[10.5px] text-[var(--text-muted)]">{t.task_answer_hint}</span>}
    </div>
  );
}

export function ProgressBar({ task, width = 42 }: { task: Pin; width?: number | string }) {
  const p = progressOf(task);
  if (p.total === 0) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
      <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]" style={{ width }}>
        <span className="block h-1 rounded-full" style={{ width: `${p.percent}%`, background: STATUS_COLOR[task.status] }} />
      </span>
      <span className="tc-mono tabular-nums">{p.label}</span>
    </span>
  );
}

/** Who can be put on a task: the manager, and the agents on this project's canvas. */
function useOwnerChoices(task: Pin): string[] {
  const projects = useProjectStore((s) => s.projects);
  return useMemo(() => {
    const ids: string[] = ["manager"];
    for (const project of projects) {
      if (project.path !== task.repo) continue;
      for (const worktree of project.worktrees) {
        for (const terminal of worktree.terminals) {
          if (findAgentAdapter(terminal.type) && !terminal.stashed) ids.push(terminal.id);
        }
      }
    }
    for (const owner of task.owners ?? []) if (!ids.includes(owner)) ids.push(owner);
    return ids;
  }, [projects, task.repo, task.owners]);
}

function OwnerToggle({ task, owner }: { task: Pin; owner: string }) {
  const view = useOwnerView(owner);
  const on = (task.owners ?? []).includes(owner);
  return (
    <button
      type="button"
      aria-pressed={on}
      className="tc-rail-btn inline-flex h-[30px] items-center gap-1.5 border px-2.5 text-[12px]"
      style={{ borderColor: on ? "var(--cyan)" : "var(--border)", color: on ? "var(--text-primary)" : "var(--text-muted)", opacity: view.closed ? 0.6 : 1 }}
      onClick={() => {
        const owners = task.owners ?? [];
        void updateTask(task, { owners: on ? owners.filter((o) => o !== owner) : [...owners, owner] });
      }}
    >
      {view.icon && <img src={view.icon} alt="" className="h-3.5 w-3.5 object-contain" draggable={false} />}
      <span className="max-w-[160px] truncate">{view.label}</span>
    </button>
  );
}

function Section({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <span className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
        {label}
        {extra}
      </span>
      {children}
    </section>
  );
}

function StepEditor({ task }: { task: Pin }) {
  const t = useT();
  const steps = task.steps ?? [];
  const [draft, setDraft] = useState("");
  const [names, setNames] = useState<string[]>(steps.map((s) => s.text));
  useEffect(() => setNames(steps.map((s) => s.text)), [task.updated]); // eslint-disable-line react-hooks/exhaustive-deps
  const icon = "tc-rail-btn inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]";
  return (
    <div className="flex flex-col gap-0.5">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1.5 rounded-lg px-1 py-0.5">
          <button type="button" className={icon} style={{ color: MARK[step.status].color }} aria-label={stepAria(step, t)} onClick={() => void updateTask(task, { steps: cycleStep(steps, i) })}>
            {MARK[step.status].mark}
          </button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">{step.text}</span>
            <input
              value={names[i] ?? step.text}
              onChange={(e) => setNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              onBlur={() => {
                const text = (names[i] ?? "").trim();
                if (text && text !== step.text) void updateTask(task, { steps: steps.map((s, j) => (j === i ? { ...s, text } : s)) });
                else setNames(steps.map((s) => s.text));
              }}
              className={`w-full rounded-md bg-transparent px-1.5 py-1 text-[13px] outline-none focus:bg-[var(--surface-hover)] ${MARK[step.status].text}`}
            />
          </label>
          <button type="button" className={icon} aria-label={t.task_step_up} title={t.task_step_up} onClick={() => void updateTask(task, { steps: moveStep(steps, i, -1) })}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 10l4-4 4 4" />
            </svg>
          </button>
          <button type="button" className={icon} aria-label={t.task_step_down} title={t.task_step_down} onClick={() => void updateTask(task, { steps: moveStep(steps, i, 1) })}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <button type="button" className={icon} aria-label={t.task_step_delete} title={t.task_step_delete} onClick={() => void updateTask(task, { steps: steps.filter((_, j) => j !== i) })}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ))}
      <label className="flex items-center gap-1.5 px-1 py-0.5">
        <span aria-hidden="true" className="w-7 text-center text-[var(--text-faint)]">
          +
        </span>
        <span className="sr-only">{t.task_step_placeholder}</span>
        <input
          value={draft}
          placeholder={t.task_step_placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && draft.trim()) {
              void updateTask(task, { steps: [...steps, { text: draft.trim(), status: "pending" }] });
              setDraft("");
            }
          }}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:bg-[var(--surface-hover)]"
        />
      </label>
    </div>
  );
}

function ActorName({ by }: { by: string }) {
  const t = useT();
  const view = useOwnerView(by.startsWith("terminal:") ? by.slice("terminal:".length) : "");
  return <span className="text-[var(--text-secondary)]">{by === "user" ? t.task_actor_you : view.label}</span>;
}

/** The full editor's task parts: status, an agent's question, who's on it, steps, history. */
export function TaskSections({ task }: { task: Pin }) {
  const t = useT();
  const owners = useOwnerChoices(task);
  const activity = [...(task.activity ?? [])].reverse();
  return (
    <div className="flex flex-col gap-5">
      <Section label={t.task_status_menu}>
        <span className="flex flex-wrap gap-1.5">
          {PICKABLE_STATUSES.map((status) => {
            const on = task.status === status;
            const color = STATUS_COLOR[status];
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                className="tc-rail-btn h-[30px] border px-3 text-[12.5px]"
                style={{ borderColor: on ? color : "var(--border)", color: on ? color : "var(--text-muted)", background: on ? `color-mix(in srgb, ${color} 10%, transparent)` : undefined }}
                onClick={() => void updateTask(task, { status })}
              >
                {statusLabel(status, t)}
              </button>
            );
          })}
        </span>
        <NeedsYouBlock task={task} />
      </Section>
      <Section label={t.task_owners}>
        <span className="flex flex-wrap gap-1.5">
          {owners.map((owner) => (
            <OwnerToggle key={owner} task={task} owner={owner} />
          ))}
        </span>
      </Section>
      <Section label={t.task_steps} extra={<span className="tc-mono normal-case tracking-normal">{progressOf(task).label}</span>}>
        <StepEditor task={task} />
      </Section>
      {activity.length > 0 && (
        <Section label={t.task_activity}>
          <div className="flex flex-col gap-1">
            {activity.slice(0, 12).map((a, i) => (
              <span key={`${a.at}-${i}`} className="text-[12px] text-[var(--text-muted)]">
                <ActorName by={a.by} /> {a.text} · {new Date(a.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/**
 * The manager's task, above its message box: kept with the project (not
 * scrolled away with the chat), folded to the step under way; open, its
 * steps can be ticked like anywhere else.
 */
export function TaskBar({ task, onOpen }: { task: Pin; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const p = progressOf(task);
  const steps = task.steps ?? [];
  const current = steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending");
  return (
    <div className="mx-3 mb-2 rounded-[10px] border px-3 py-2" style={{ borderColor: task.status === "needs_you" ? "color-mix(in srgb, var(--amber) 45%, transparent)" : "var(--border)" }}>
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="uppercase tracking-[0.06em]">{t.task_kind}</span>
          {p.label && <span className="tc-mono tabular-nums">{p.label}</span>}
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
            {task.title}
            {current && !open ? ` — ${current.text}` : ""}
          </span>
        </button>
        <button type="button" className="tc-rail-btn shrink-0 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={onOpen}>
          {t.task_open_full}
        </button>
      </div>
      {task.status === "needs_you" && (
        <div className="mt-2">
          <NeedsYouBlock task={task} />
        </div>
      )}
      {open && (
        <div className="mt-1.5">
          <StepList task={task} />
        </div>
      )}
    </div>
  );
}
