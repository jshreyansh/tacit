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
/** Long enough for the pointer to cross from the button into its card. */
const HOVER_LEAVE_MS = 180;

/**
 * `icon`: a record button, right of the manager's pill (`shell: "pill"`)
 * or in the open chat's message box, left of the usage ring (`shell:
 * "composer"`); its cards open upward either way. Hovering says what it is;
 * a click asks what the context is about, then starts. While it records it
 * is a stop button: a click ends the context, and hovering shows its card
 * (name, what's recorded, End, Show in Activity).
 * `pill`: the chip beside the manager's pill, its card opening upward.
 * `strip`: the context line under the docked chat's header, its card
 * opening downward over the conversation.
 */
export function TaskControl({
  variant = "pill",
  trailing,
  shell = "pill",
}: { variant?: "icon" | "pill" | "strip"; trailing?: React.ReactNode; shell?: "pill" | "composer" } = {}) {
  const t = useT();
  const [run, setRun] = useState<RunInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [autoHint, setAutoHint] = useState(false);
  const [, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // The icon's hover card: shown while the pointer is over the button or
  // its card, or something in the card has focus (renaming); `quiet` keeps
  // it away after a click until the pointer leaves.
  const [hovered, setHovered] = useState(false);
  const [holding, setHolding] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const hoverIn = () => {
    window.clearTimeout(leaveTimer.current);
    if (!hovered) setQuiet(false);
    setHovered(true);
  };
  const hoverOut = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      setHovered(false);
      setQuiet(false);
    }, HOVER_LEAVE_MS);
  };
  const close = useCallback(() => {
    setOpen(false);
    setQuiet(true);
  }, []);
  useCloseOnOutsideClick(open, rootRef, close);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // Started or stopped: whatever was being typed is gone with its card.
  useEffect(() => setHolding(false), [run?.run_id]);

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

  if (variant === "icon") {
    const label = run ? t.task_stop_label(name, elapsed(run.started_at)) : t.task_record_title;
    const pill = shell === "pill";
    const placement = pill ? "above-right" : "above-box";
    // Hovering shows what it is (or, while recording, the context's card);
    // a short delay lets the pointer cross the gap into the card.
    const showCard = !quiet && (hovered || holding);
    return (
      // In the message box the card is placed against the box (not the
      // button), spanning its width, so a narrow chat doesn't cut it off.
      <div
        ref={rootRef}
        className={`flex shrink-0 flex-col items-center ${pill ? "pointer-events-auto relative" : ""}`}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        // Typing in the card (renaming, a new context's goal) keeps it open.
        onFocus={(e) => setHolding(e.target instanceof HTMLInputElement)}
        onBlur={(e) => {
          if (!(e.relatedTarget instanceof HTMLInputElement && e.currentTarget.contains(e.relatedTarget))) setHolding(false);
        }}
      >
        <button
          className={
            pill
              ? `tc-pill relative inline-flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 text-[var(--text-muted)] transition-transform duration-quick hover:text-[var(--text-primary)] active:scale-[0.94] ${PILL_GLASS}`
              : "tc-rail-btn relative inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)] transition-transform duration-quick hover:text-[var(--text-primary)] active:scale-[0.94]"
          }
          style={pill && run ? { borderColor: "color-mix(in srgb, var(--red) 40%, transparent)" } : undefined}
          data-on={open ? "" : undefined}
          // Recording, a click stops it; otherwise it asks what the context
          // is about, then starts.
          onClick={() => {
            setQuiet(true);
            if (run) void window.tacit.run.end();
            else setOpen((v) => !v);
          }}
          aria-expanded={run ? undefined : open}
          aria-haspopup={run ? undefined : "dialog"}
          aria-label={label}
        >
          {run ? <StopIcon size={pill ? 20 : 17} /> : <RecordIcon size={pill ? 22 : 18} />}
          {run && pill && <span className="tc-mono text-[8.5px] leading-none tabular-nums text-[var(--red)]">{elapsed(run.started_at)}</span>}
        </button>
        {/* Started on its own when you first typed to an agent: said beside it.
            In the message box, over the box's left end: the chat's Stop sits
            over its right end. */}
        {autoHint && !open && !showCard && (
          <div
            className={`tc-float tc-enter-fade pointer-events-none absolute bottom-full z-50 mb-2 whitespace-nowrap px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] ${pill ? "right-0" : "left-0"}`}
            style={{ borderRadius: 10 }}
          >
            {t.task_auto_hint}
          </div>
        )}
        {!run && open && <TaskPanel run={null} onDone={close} placement={placement} />}
        {run && showCard && (
          <TaskPanel
            run={run}
            onDone={() => {
              setQuiet(true);
              setHolding(false);
            }}
            placement={placement}
          />
        )}
        {!run && !open && showCard && (
          <div
            role="tooltip"
            className={`tc-float tc-enter-fade-up pointer-events-none absolute bottom-full z-50 mb-2 p-3 text-left ${pill ? "right-0 w-[17rem]" : "inset-x-0"}`}
            style={{ borderRadius: 14 }}
          >
            <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.task_record}</div>
            <p className="mt-1 text-[11.5px] leading-snug text-[var(--text-muted)]">{t.task_panel_what}</p>
            <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">{t.task_record_click}</p>
          </div>
        )}
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

/** Record: a dotted screen with a red record dot at its corner. */
function RecordIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M16.8 17.5H4.7A2.7 2.7 0 0 1 2 14.8V5.7A2.7 2.7 0 0 1 4.7 3h13.6A2.7 2.7 0 0 1 21 5.7v5.1"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="1.2 2.2"
      />
      <path d="M5 6.1h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 14.1h7.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="18" cy="15.5" r="4.5" fill="var(--red)" />
      <circle cx="18" cy="15.5" r="2.9" stroke="white" strokeOpacity="0.75" strokeWidth="1.15" />
    </svg>
  );
}

/** Recording: a light disc with a stop square, a red pulse behind it. */
function StopIcon({ size }: { size: number }) {
  return (
    <span className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <span className="absolute inset-[-2px] animate-ping rounded-full opacity-25" style={{ background: "var(--red)", animationDuration: "2s" }} />
      <svg width={size} height={size} viewBox="0 0 20 20" className="relative" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="var(--text-primary)" />
        <rect x="6.6" y="6.6" width="6.8" height="6.8" rx="1.6" fill="var(--bg)" />
      </svg>
    </span>
  );
}

function TaskPanel({ run, onDone, placement = "above" }: { run: RunInfo | null; onDone: () => void; placement?: "above" | "above-right" | "above-box" | "below" }) {
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
      // Upward from the chip or record button beside the pill, or the one in
      // the chat's message box; downward from the docked chat's context line,
      // over the conversation.
      className={
        placement === "above"
          ? "tc-float tc-enter-fade-up absolute bottom-full left-0 z-10 mb-2 w-[22rem] p-3.5 text-[11px]"
          : placement === "above-right"
            ? "tc-float tc-enter-fade-up absolute bottom-full right-0 z-50 mb-2 w-[min(22rem,calc(100vw-2rem))] p-3.5 text-[11px]"
            : placement === "above-box"
              ? "tc-float tc-enter-fade-up absolute inset-x-0 bottom-full z-50 mb-2 p-3.5 text-[11px]"
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
