import { useCallback, useEffect, useRef, useState } from "react";
import type { RunChange, RunInfo } from "../../shared/capture";
import { RUN_GOAL_MAX_LENGTH } from "../../shared/capture";
import { useT } from "../i18n/useT";
import { useActivityFocusStore } from "../stores/activityFocusStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useNotificationStore } from "../stores/notificationStore";
import { taskActorName } from "../utils/taskActor";
import { PILL_GLASS, useCloseOnOutsideClick } from "./pillChrome";

/**
 * Context recording (T4.1), as a chip beside the workdesk manager's pill. A
 * context groups one piece of work's entries in the record (a "run" there).
 * Recording starts on its own when you first type into an agent, so this is
 * where you see that it has, name it, end it, or start one with a goal of
 * your own. It sat in the title strip until the layout redesign (SHR-127)
 * put it next to the pill, so what you tell the manager and what is being
 * recorded live in one place. Clicking it opens its card upward.
 */

/** How long a just-started automatic task says where it came from. */
const AUTO_HINT_MS = 6_000;

/**
 * `rail`: a record button in the left bar, above the zoom: one click starts
 * recording; while it records, a click opens its card beside the bar, Stop
 * first, so a stray click doesn't end it.
 * `pill`: the chip beside the manager's pill, its card opening upward.
 * `strip`: the context line under the docked chat's header, its card
 * opening downward over the conversation.
 */
export function TaskControl({ variant = "pill", trailing }: { variant?: "rail" | "pill" | "strip"; trailing?: React.ReactNode } = {}) {
  const t = useT();
  const [run, setRun] = useState<RunInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [autoHint, setAutoHint] = useState(false);
  const [, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, rootRef, close);

  useEffect(() => {
    const api = window.tacit?.run;
    if (!api) return;
    let cancelled = false;
    void api.current().then((current) => {
      if (!cancelled) setRun(current);
    });
    let hintTimer: number | undefined;
    const off = api.onChanged(({ run: next, change }) => {
      setRun(next);
      if (change?.kind === "started" && change.by === "auto") {
        setAutoHint(true);
        window.clearTimeout(hintTimer);
        hintTimer = window.setTimeout(() => setAutoHint(false), AUTO_HINT_MS);
      }
      const notice = noticeFor(change, next, t);
      if (notice) useNotificationStore.getState().notify("info", notice);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(hintTimer);
      off();
    };
  }, [t]);

  // The elapsed time only needs minutes.
  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [run]);

  const name = run?.goal ?? t.task_untitled;

  if (variant === "rail") {
    const label = run ? `${t.task_recording_short} · ${name} · ${elapsed(run.started_at)}` : t.task_record_title;
    return (
      <div ref={rootRef} className="relative flex shrink-0 flex-col items-center">
        <button
          className="tc-rail-btn relative inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center gap-0.5 transition-transform duration-quick active:scale-[0.94]"
          data-on={open ? "" : undefined}
          onClick={() => {
            if (run) setOpen((v) => !v);
            else void window.tacit.run.start(null);
          }}
          aria-expanded={run ? open : undefined}
          aria-haspopup={run ? "dialog" : undefined}
          aria-label={label}
          title={label}
        >
          <RecordIcon recording={!!run} />
          {run && <span className="tc-mono text-[8.5px] leading-none tabular-nums text-[var(--red)]">{elapsed(run.started_at)}</span>}
        </button>
        {/* Started on its own when you first typed to an agent: said beside the bar. */}
        {autoHint && !open && (
          <div className="tc-float tc-enter-fade pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)]" style={{ borderRadius: 10 }}>
            {t.task_auto_hint}
          </div>
        )}
        {open && <TaskPanel run={run} onDone={close} placement="beside" />}
      </div>
    );
  }

  if (variant === "strip") {
    return (
      <div ref={rootRef} className="relative shrink-0 border-b border-[var(--border)]">
        <button
          className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[11.5px] text-[var(--text-muted)] transition-colors duration-quick hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]"
          style={open ? { background: "color-mix(in srgb, var(--text-primary) 6%, transparent)" } : undefined}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${run ? "animate-pulse" : ""}`}
            style={run ? { background: "var(--red)" } : { border: "1.5px solid var(--text-muted)" }}
          />
          {run ? (
            <>
              <span className="min-w-0 truncate text-[var(--text-secondary)]">
                {t.task_recording_short} · {name}
              </span>
              <span className="tc-mono shrink-0 tabular-nums">{autoHint ? t.task_auto_hint : elapsed(run.started_at)}</span>
            </>
          ) : (
            <span>{t.task_record}</span>
          )}
          {trailing && <span className="ml-auto flex shrink-0 items-center gap-1.5">{trailing}</span>}
        </button>
        {open && <TaskPanel run={run} onDone={close} placement="below" />}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="pointer-events-auto relative shrink-0">
      <button
        className={`tc-pill flex h-10 items-center gap-2.5 px-3 text-left text-[12px] text-[var(--text-muted)] transition-colors duration-quick hover:text-[var(--text-primary)] ${PILL_GLASS}`}
        style={open ? { borderColor: "color-mix(in srgb, var(--red) 45%, transparent)" } : undefined}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={run ? t.task_recording : t.task_record_title}
      >
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${run ? "animate-pulse" : ""}`}
          style={run ? { background: "var(--red)" } : { border: "1.5px solid var(--text-muted)" }}
        />
        {run ? (
          <>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[9.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{t.task_recording_short}</span>
              <span className="max-w-[11rem] truncate text-[12px] text-[var(--text-primary)]">{name}</span>
            </span>
            <span className="tc-mono tabular-nums text-[11px] text-[var(--text-muted)]">
              {autoHint ? t.task_auto_hint : elapsed(run.started_at)}
            </span>
          </>
        ) : (
          <span>{t.task_record}</span>
        )}
      </button>
      {open && <TaskPanel run={run} onDone={close} />}
    </div>
  );
}

/** Record: a red ring with a dot; recording: a red disc with a white stop square, breathing. */
function RecordIcon({ recording }: { recording: boolean }) {
  if (!recording) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--red)" strokeWidth="1.6" />
        <circle cx="10" cy="10" r="4.4" fill="var(--red)" />
      </svg>
    );
  }
  return (
    <span className="relative flex h-[18px] w-[18px] items-center justify-center">
      <span className="absolute inset-0 animate-ping rounded-full opacity-30" style={{ background: "var(--red)", animationDuration: "2s" }} />
      <svg width="18" height="18" viewBox="0 0 20 20" className="relative" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="var(--red)" />
        <rect x="6.6" y="6.6" width="6.8" height="6.8" rx="1.6" fill="white" />
      </svg>
    </span>
  );
}

function TaskPanel({ run, onDone, placement = "above" }: { run: RunInfo | null; onDone: () => void; placement?: "above" | "below" | "beside" }) {
  const t = useT();
  // "new" is a goal for a task to start; "rename" edits the open one's name.
  const [editing, setEditing] = useState<"new" | "rename" | null>(run ? null : "new");
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = async () => {
    if (editing === "rename") {
      if (text.trim()) await window.tacit.run.rename(text);
      setEditing(null);
      setText("");
      return;
    }
    await window.tacit.run.start(text.trim() || null);
    onDone();
  };

  const showInActivity = (taskId: string) => {
    const canvas = useCanvasStore.getState();
    canvas.setRightPanelCollapsed(false);
    canvas.setRightPanelActiveTab("memory");
    useActivityFocusStore.getState().focusTask(taskId);
    onDone();
  };

  const input = (
    <input
      ref={inputRef}
      className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
      placeholder={t.task_goal_placeholder}
      value={text}
      maxLength={RUN_GOAL_MAX_LENGTH}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") {
          e.stopPropagation();
          if (run) {
            setEditing(null);
            setText("");
          } else {
            onDone();
          }
        }
      }}
    />
  );

  const button =
    "rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]";

  return (
    <div
      role="dialog"
      aria-label={t.task_recording}
      // Upward from the chip beside the pill; downward from the docked chat's
      // context line, over the conversation.
      className={
        placement === "above"
          ? "tc-float tc-enter-fade-up absolute bottom-full left-0 z-10 mb-2 w-[22rem] p-3.5 text-[11px]"
          : placement === "beside"
            ? "tc-float tc-enter-fade absolute bottom-0 left-full z-50 ml-3 w-[22rem] p-3.5 text-[11px]"
            : "tc-float tc-enter-fade-down absolute left-2 right-2 top-full z-10 mt-1 p-3.5 text-[11px]"
      }
      style={{ borderRadius: 18 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
    >
      {run ? (
        <>
          {editing === "rename" ? (
            input
          ) : (
            <button
              className="block w-full truncate text-left text-[13px] font-medium text-[var(--text-primary)] hover:underline"
              title={t.task_rename_hint}
              onClick={() => {
                setText(run.goal ?? "");
                setEditing("rename");
              }}
            >
              {run.goal ?? t.task_untitled}
            </button>
          )}
          <div className="mt-1 text-[var(--text-muted)]">
            {namedLine(run, t) ?? startedLine(run, t)} · {t.task_rename_hint}
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-[var(--border)] px-2.5 py-1.5">
              <div className="text-[15px] font-semibold tabular-nums text-[var(--text-primary)]">{run.entries}</div>
              <div className="text-[10.5px] text-[var(--text-muted)]">{t.task_count_entries}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-2.5 py-1.5">
              <div className="tc-mono text-[15px] font-semibold tabular-nums text-[var(--text-primary)]">{elapsed(run.started_at)}</div>
              <div className="text-[10.5px] text-[var(--text-muted)]">{startedLine(run, t)}</div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            <button
              className={`${button} border border-[var(--border)]`}
              onClick={() => {
                void window.tacit.run.end();
                onDone();
              }}
            >
              {t.task_end}
            </button>
            <button className={button} onClick={() => showInActivity(run.run_id)}>
              {t.task_show_activity}
            </button>
          </div>
          <div className="mt-2.5 border-t border-[var(--border)] pt-2.5">
            {editing === "new" ? (
              <>
                {input}
                <div className="mt-1 text-[var(--text-faint)]">{t.task_new_hint}</div>
              </>
            ) : (
              <button className={button} title={t.task_new_hint} onClick={() => setEditing("new")}>
                {t.task_new}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {input}
          <div className="mt-1.5 flex justify-end">
            <button className={`${button} border border-[var(--border)]`} onClick={() => void submit()}>
              {t.task_start_recording}
            </button>
          </div>
        </>
      )}
      <p className="mt-2.5 leading-snug text-[var(--text-faint)]">{t.task_panel_what}</p>
      <p className="mt-1.5 leading-snug text-[var(--text-faint)]">{t.task_panel_how}</p>
    </div>
  );
}

type Dict = ReturnType<typeof useT>;

function who(ref: string, t: Dict): string {
  return taskActorName(ref, t.task_manager);
}

function startedLine(run: RunInfo, t: Dict): string {
  if (run.started_by === "user") return t.task_started_by_you;
  if (run.started_by === "auto") return t.task_started_auto;
  return t.task_started_by(who(run.started_by, t));
}

function namedLine(run: RunInfo, t: Dict): string | null {
  if (run.goal_source === "agent_title") return t.task_named_from_title;
  if (run.goal_source === "prompt") return t.task_named_from_prompt;
  if (run.named_by && run.named_by !== "user") return t.task_named_by(who(run.named_by, t));
  return null;
}

/**
 * A notice for what someone else did to the task: the person's own clicks,
 * and Tacit's naming from a prompt or title, go without one.
 */
function noticeFor(change: RunChange | null, run: RunInfo | null, t: Dict): string | null {
  if (!change) return null;
  switch (change.kind) {
    case "started":
      return change.by === "user" || change.by === "auto" ? null : t.task_notice_started(who(change.by, t), run?.goal ?? t.task_untitled);
    case "named":
      return change.by === "user" || change.by === "system" ? null : t.task_notice_named(who(change.by, t), run?.goal ?? t.task_untitled);
    case "ended": {
      const goal = change.goal ?? t.task_untitled;
      if (change.reason === "idle") return t.task_notice_idle(goal);
      if (change.reason === "superseded") return change.by === "user" ? null : t.task_notice_superseded(goal);
      return change.by === "user" ? null : t.task_notice_ended(who(change.by, t), goal);
    }
    case "refused":
      return t.task_notice_refused(who(change.by, t));
  }
}

function elapsed(startedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
