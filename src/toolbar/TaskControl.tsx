import { useCallback, useEffect, useRef, useState } from "react";
import type { RunChange, RunInfo } from "../../shared/capture";
import { RUN_GOAL_MAX_LENGTH } from "../../shared/capture";
import { useT } from "../i18n/useT";
import { useActivityFocusStore } from "../stores/activityFocusStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useNotificationStore } from "../stores/notificationStore";
import { taskActorName } from "../utils/taskActor";
import { useCloseOnOutsideClick } from "./pillChrome";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";

/**
 * Task recording (T4.1), centred in the title strip where a window title
 * would be. A task groups one piece of work's entries in the record (a "run"
 * there). Recording starts on its own when you first type into an agent, so
 * this is where you see that it has, name it, end it, or start one with a
 * goal of your own. Clicking the chip opens a panel that says what a task is.
 *
 * Only the chip and panel are `no-drag`: the rest of the strip still moves
 * the window.
 */

/** How long a just-started automatic task says where it came from. */
const AUTO_HINT_MS = 6_000;

export function TaskControl() {
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

  return (
    <div
      ref={rootRef}
      className="fixed left-1/2 top-0 z-[96] flex -translate-x-1/2 flex-col items-center"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div className="flex items-center" style={{ height: TITLE_STRIP_HEIGHT }}>
        <button
          className="tc-discovery-chip flex items-center gap-2 rounded-full border px-2.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          style={{ height: TITLE_STRIP_HEIGHT - 6 }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={run ? undefined : t.task_record_title}
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${run ? "animate-pulse" : ""}`}
            style={run ? { background: "var(--red)" } : { border: "1px solid var(--text-faint)" }}
          />
          {run ? (
            <>
              <span className="text-[var(--text-faint)]">{t.task_recording}</span>
              <span className="max-w-[20rem] truncate text-[var(--text-primary)]">{name}</span>
              <span className="tc-mono tabular-nums text-[var(--text-faint)]">
                {autoHint ? t.task_auto_hint : elapsed(run.started_at)}
              </span>
            </>
          ) : (
            <span>{t.task_record}</span>
          )}
        </button>
      </div>
      {open && <TaskPanel run={run} onDone={close} />}
    </div>
  );
}

function TaskPanel({ run, onDone }: { run: RunInfo | null; onDone: () => void }) {
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
      className="tc-enter-fade-down mt-1 w-[22rem] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] shadow-lg"
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
          <div className="mt-1.5 space-y-0.5 text-[var(--text-muted)]">
            <div>
              {startedLine(run, t)} · {t.task_ago(elapsed(run.started_at))}
            </div>
            {namedLine(run, t) && <div>{namedLine(run, t)}</div>}
            <div>{t.task_entries(run.entries)}</div>
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
