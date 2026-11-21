import { useEffect, useRef, useState } from "react";
import type { CaptureEntryView } from "../../shared/capture";
import { useT } from "../i18n/useT";
import { ActivityRow } from "./RightPanel/ActivityRow";
import { useActivityFocusStore } from "../stores/activityFocusStore";
import { taskActorName } from "../utils/taskActor";
import { TaskControl } from "../toolbar/TaskControl";

/**
 * A workdesk's Activity: what happened on it (agents started, wired,
 * prompted, what they did), grouped by the recorded task it happened in,
 * newest first, with the recording control on top. Opens in the pane from
 * the navigator's Activity row, or a grid tab.
 */

const ACTIVITY_LIMIT = 300;
// The record grows while you are looking at it — a browser node alone writes
// a line per action. Polling beats fs.watch here: a read is a couple of files
// and the cache in RecallService makes a repeat cheap, whereas a watcher on an
// append-heavy directory fires far more often than this list needs to change.
const ACTIVITY_POLL_MS = 15_000;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const today = new Date();
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TaskGroup {
  taskId: string | null;
  entries: CaptureEntryView[];
}

/** Consecutive entries of one task, newest first, as the list shows them. */
function groupByTask(entries: CaptureEntryView[]): TaskGroup[] {
  const groups: TaskGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.taskId === entry.taskId) last.entries.push(entry);
    else groups.push({ taskId: entry.taskId, entries: [entry] });
  }
  return groups;
}

/**
 * A task's heading: its latest name, who started it, when, and how it
 * ended, read off the task's own run entries. Entries are newest first, so
 * the first name met is the current one.
 */
function TaskHeading({ group, openTaskId }: { group: TaskGroup; openTaskId: string | null }) {
  const t = useT();
  if (!group.taskId) {
    return (
      <div className="tc-eyebrow px-1 pt-3 pb-1" style={{ color: "var(--text-muted)" }}>
        {t.task_group_none}
      </div>
    );
  }
  const name = group.entries.find((e) => e.run?.goal)?.run?.goal ?? t.task_untitled;
  const started = group.entries.find((e) => e.kind === "run_started");
  const ended = group.entries.find((e) => e.kind === "run_ended");
  const first = group.entries.at(-1)!;
  const last = group.entries[0];
  const minutes = Math.max(0, Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000));
  const by = started?.run?.by;
  const startedText = !by
    ? null
    : by === "user"
      ? t.task_started_by_you
      : by === "auto"
        ? t.task_started_auto
        : t.task_started_by(taskActorName(by, t.task_manager));
  let endText: string;
  if (group.taskId === openTaskId && !ended) endText = t.task_group_recording;
  else if (!ended?.run) endText = "";
  else if (ended.run.reason === "idle") endText = t.task_group_idle;
  else if (ended.run.reason === "superseded") endText = t.task_group_superseded;
  else endText = ended.run.by === "user" ? t.task_group_ended_by_you : t.task_group_ended_by(taskActorName(ended.run.by, t.task_manager));

  const recording = group.taskId === openTaskId && !ended;
  return (
    <div
      className="mx-1 mb-1.5 mt-3 flex items-start gap-2.5 rounded-lg border px-2.5 py-2"
      style={{
        background: "color-mix(in srgb, var(--green) 7%, var(--surface))",
        borderColor: "color-mix(in srgb, var(--green) 28%, var(--border))",
      }}
    >
      <span
        className="mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
        style={{ background: "color-mix(in srgb, var(--green) 18%, transparent)", color: "var(--green)" }}
        aria-hidden="true"
      >
        {recording ? (
          <span className="tc-live-pip h-2 w-2 rounded-full" style={{ background: "var(--red)" }} />
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 13.5V2.5M4 3h7.5l-1.5 2.5L11.5 8H4" />
          </svg>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>
          {name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
          {startedText && <span>{startedText}</span>}
          {startedText && <span aria-hidden="true">·</span>}
          <span className="tabular-nums">{`${timeLabel(first.at)}–${timeLabel(last.at)}`}</span>
          <span className="rounded-full bg-[var(--surface-hover)] px-1.5 tabular-nums">{minutes}m</span>
          {endText && <span aria-hidden="true">·</span>}
          {endText && <span style={recording ? { color: "var(--red)" } : undefined}>{endText}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Run entries the heading already says (a rename stays, as it's news), and
 * session links, which are for joining the record to transcripts.
 */
const SAID_BY_HEADING = new Set(["run_started", "run_ended", "session"]);

function ActivityList({
  entries,
  openTaskId,
  focus,
}: {
  entries: CaptureEntryView[];
  openTaskId: string | null;
  focus: { taskId: string | null; nonce: number };
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  let lastDay = "";

  useEffect(() => {
    if (!focus.taskId || !listRef.current) return;
    const target = listRef.current.querySelector(`[data-task="${CSS.escape(focus.taskId)}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus.taskId, focus.nonce, entries.length]);

  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
      {groupByTask(entries).map((group) => (
        <div key={`${group.taskId ?? "none"}:${group.entries[0].id}`} data-task={group.taskId ?? undefined}>
          <TaskHeading group={group} openTaskId={openTaskId} />
          <div className={group.taskId ? "ml-2" : undefined}>
      {(() => {
        const shown = group.entries.filter((entry) => !SAID_BY_HEADING.has(entry.kind));
        return shown.map((entry, i) => {
        const day = dayLabel(entry.at);
        const newDay = day !== lastDay;
        lastDay = day;
        return (
          <div key={entry.id}>
            {newDay && (
              <div className="tc-eyebrow sticky top-0 z-[1] -mx-2 bg-[var(--chrome-glass)] px-3 pb-1 pt-2 [backdrop-filter:var(--glass-filter)]" style={{ color: "var(--text-muted)" }}>
                {day}
              </div>
            )}
            <ActivityRow entry={entry} time={timeLabel(entry.at)} isLast={i === shown.length - 1} />
          </div>
        );
        });
      })()}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The open task's id while recording, else null; kept current. */
export function useRecordingTask(): string | null {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  useEffect(() => {
    const api = window.tacit?.run;
    if (!api) return;
    void api.current().then((run) => setOpenTaskId(run?.run_id ?? null));
    return api.onChanged(({ run }) => setOpenTaskId(run?.run_id ?? null));
  }, []);
  return openTaskId;
}

export function ActivityView({ workdeskId }: { workdeskId: string }) {
  const t = useT();
  // "Show in Activity" from the task control: scroll to that task.
  const focusTaskId = useActivityFocusStore((st) => st.taskId);
  const focusNonce = useActivityFocusStore((st) => st.nonce);
  const openTaskId = useRecordingTask();
  const [entries, setEntries] = useState<CaptureEntryView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.tacit.record
        .list({ limit: ACTIVITY_LIMIT, canvasId: workdeskId })
        .then((rows) => {
          if (cancelled) return;
          setEntries(rows);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    setLoading(true);
    load();
    const timer = setInterval(load, ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workdeskId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The open task: name it, end it, or record a new one. */}
      <TaskControl variant="strip" inActivity />
      {loading && entries.length === 0 ? (
        <div className="tc-label flex flex-1 items-center justify-center">{t.activity_loading}</div>
      ) : entries.length === 0 ? (
        <div className="tc-label flex flex-1 flex-col items-center justify-center px-4 text-center leading-relaxed">
          <span>{t.activity_empty}</span>
          <span>{t.activity_empty_hint}</span>
        </div>
      ) : (
        <ActivityList entries={entries} openTaskId={openTaskId} focus={{ taskId: focusTaskId, nonce: focusNonce }} />
      )}
    </div>
  );
}
