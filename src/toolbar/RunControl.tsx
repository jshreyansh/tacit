import { useEffect, useRef, useState } from "react";
import type { RunInfo } from "../../shared/capture";
import { RUN_GOAL_MAX_LENGTH } from "../../shared/capture";
import { useT } from "../i18n/useT";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";

/**
 * The run control (T4.1), centred in the title strip where a window title
 * would be. A run groups one task's entries in the record; starting one is
 * optional, since Tacit opens one on your first prompt if you didn't, but a
 * run you start carries its goal, which an automatic one can't.
 *
 * Only the chip itself is `no-drag`: the rest of the strip still moves the
 * window.
 */
export function RunControl() {
  const t = useT();
  const [run, setRun] = useState<RunInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState("");
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const api = window.tacit?.run;
    if (!api) return;
    let cancelled = false;
    void api.current().then((current) => {
      if (!cancelled) setRun(current);
    });
    const off = api.onChanged(setRun);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // The elapsed time only needs minutes.
  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [run]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const start = async () => {
    const started = await window.tacit.run.start(goal.trim() || null);
    if (started) setRun(started);
    setEditing(false);
    setGoal("");
  };

  const chip =
    "tc-discovery-chip flex items-center gap-2 rounded-full border px-2.5 text-[11px] text-[var(--text-muted)]";

  return (
    <div
      className="fixed left-1/2 top-0 z-[51] flex -translate-x-1/2 items-center"
      style={{ height: TITLE_STRIP_HEIGHT }}
    >
      <div
        className={chip}
        style={{ height: TITLE_STRIP_HEIGHT - 6, WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {run ? (
          <>
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--green)" }} />
            <span className="max-w-[22rem] truncate text-[var(--text-primary)]" title={run.goal ?? undefined}>
              {run.goal ?? t.run_auto}
            </span>
            <span className="tc-mono tabular-nums text-[var(--text-faint)]">{elapsed(run.started_at)}</span>
            <button
              className="rounded px-1 hover:text-[var(--text-primary)]"
              title={t.run_end_title}
              onClick={() => void window.tacit.run.end()}
            >
              {t.run_end}
            </button>
          </>
        ) : editing ? (
          <input
            ref={inputRef}
            className="w-[20rem] bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
            placeholder={t.run_goal_placeholder}
            value={goal}
            maxLength={RUN_GOAL_MAX_LENGTH}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
              if (e.key === "Escape") {
                setEditing(false);
                setGoal("");
              }
            }}
            onBlur={() => {
              if (!goal.trim()) setEditing(false);
            }}
          />
        ) : (
          <button className="hover:text-[var(--text-primary)]" title={t.run_start_title} onClick={() => setEditing(true)}>
            {t.run_start}
          </button>
        )}
      </div>
    </div>
  );
}

function elapsed(startedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
