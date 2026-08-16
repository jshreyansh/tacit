import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayTimeline } from "../../shared/sessions";
import type { ManagerSessionRow } from "../../shared/manager-role";
import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { useNotificationStore } from "../stores/notificationStore";
import { useT } from "../i18n/useT";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import {
  buildAssistantNodes,
  buildTurns,
  summarizeToolNames,
  toolSubjectHint,
  toolVerb,
  type AssistantNode,
} from "../components/transcriptModel";
import { markdownClassName, renderMarkdown } from "../utils/markdownClass";

/**
 * Reading surface for the workspace manager's conversation, so it can be
 * followed without flying the camera to its tile.
 *
 * A window onto the manager's real terminal, never a second place to talk to
 * it — one process, one transcript, whichever surface you read. Two
 * independently drivable chat surfaces for "the same" manager would break the
 * continuity the role depends on.
 *
 * Two data sources, deliberately:
 *  - the transcript, for everything already said. It is read as a snapshot, so
 *    finished prose arrives in jumps when a turn ends rather than streaming.
 *  - live telemetry, for the step running right now. This is the part being
 *    watched, and it moves smoothly because the app already tracks the
 *    foreground tool per terminal to drive tile status.
 *
 * That split is why the jumpiness is tolerable: the stale half is the half
 * that has already stopped changing.
 */

interface Props {
  terminalId: string;
  /** Transcript file for the manager's current conversation, if it has one. */
  sessionFilePath: string | null;
  onClose: () => void;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** How often the running step's clock re-renders. */
const ELAPSED_TICK_MS = 1000;

function formatElapsed(sinceIso: string | undefined, now: number): string {
  if (!sinceIso) return "";
  const ms = now - new Date(sinceIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The live step, from telemetry rather than the transcript. */
function RunningStep({
  telemetry,
  now,
}: {
  telemetry: TerminalTelemetrySnapshot | null;
  now: number;
}) {
  const t = useT();
  if (!telemetry || telemetry.turn_state !== "in_turn") return null;

  const tool = telemetry.foreground_tool;
  const elapsed = formatElapsed(telemetry.turn_started_at, now);

  return (
    <div className="flex items-center gap-1.5 py-1 pl-1">
      <span
        aria-hidden
        className="tc-live-pip shrink-0 rounded-full"
        style={{ width: 5, height: 5, background: "var(--cyan)" }}
      />
      <span
        className="tc-mono truncate"
        style={{ fontSize: "var(--text-xs)", color: "var(--cyan)" }}
      >
        {tool ? toolVerb(tool) : t.project_chat_thinking}
      </span>
      {telemetry.active_tool_calls > 1 && (
        <span
          className="tc-mono tabular-nums shrink-0"
          style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}
        >
          ×{telemetry.active_tool_calls}
        </span>
      )}
      {elapsed && (
        <span
          className="tc-mono tabular-nums shrink-0"
          style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}
        >
          {elapsed}
        </span>
      )}
    </div>
  );
}

/** One collapsed run of tool calls, opening to the individual calls. */
function ToolTags({ node }: { node: AssistantNode }) {
  const items = node.items ?? [];
  const failed = items.filter((it) => it.result?.isError).length;
  // A run that failed opens by default; the toggle records "differs from the
  // default" so one piece of state drives both directions. Folding away the
  // one call worth reading is the failure this treatment exists to prevent.
  const [toggled, setToggled] = useState(false);
  const open = toggled !== failed > 0;

  return (
    <div className="py-0.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left cursor-pointer"
        onClick={() => setToggled((v) => !v)}
      >
        <span
          className="shrink-0"
          style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span
          className="tc-mono truncate"
          style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        >
          {summarizeToolNames(items)}
        </span>
        {failed > 0 && (
          <span
            className="tc-mono tabular-nums shrink-0"
            style={{ fontSize: "var(--text-xs)", color: "var(--red)" }}
          >
            {failed === 1 ? "failed" : `${failed} failed`}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-4">
          {items.map((item) => {
            const isError = item.result?.isError === true;
            const subject = toolSubjectHint(item.tool);
            return (
              <div
                key={item.tool.index}
                className="flex items-baseline gap-1.5"
                title={item.tool.toolName}
              >
                <span
                  className="tc-mono shrink-0"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: isError ? "var(--red)" : "var(--text-secondary)",
                  }}
                >
                  {toolVerb(item.tool.toolName)}
                </span>
                {subject && (
                  <span
                    className="tc-mono truncate"
                    style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
                  >
                    {subject}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ProjectChatPanel({ terminalId, sessionFilePath, onClose }: Props) {
  const t = useT();
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState<ManagerSessionRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Which past conversation is being read, or null for the live one. Only the
   * live one gets the composer and the running step — typing into a finished
   * conversation would silently start a different one.
   */
  const [viewing, setViewing] = useState<ManagerSessionRow | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const telemetry = useTerminalRuntimeStore(
    (s) => s.terminals[terminalId]?.telemetry ?? null,
  );

  const isLive = viewing === null;
  const activeFile = isLive ? sessionFilePath : viewing.sessionFile;

  const load = useCallback(async () => {
    if (!activeFile) {
      setTimeline(null);
      return;
    }
    setLoading(true);
    try {
      setTimeline(await window.termcanvas.sessions.loadReplay(activeFile));
    } catch {
      // A conversation that can't be read yet is not an error worth shouting
      // about — the file appears once the agent writes its first turn.
      setTimeline(null);
    } finally {
      setLoading(false);
    }
  }, [activeFile]);

  useEffect(() => {
    let cancelled = false;
    void window.termcanvas.managerRole
      .listSessions()
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        // An unreadable history is an empty menu, not a broken panel.
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId, sessionFilePath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read when a turn ends. Coarse on purpose: the transcript is a snapshot
  // read, so this is the moment its content actually changed. The live step
  // above does not wait for it. Skipped while reading a past conversation —
  // that file is finished, and refreshing it would yank the reader's scroll.
  useEffect(() => {
    if (!isLive) return;
    return window.termcanvas.hooks.onTurnComplete((payload) => {
      if (payload.terminalId !== terminalId) return;
      void load();
    });
  }, [terminalId, load, isLive]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const found = findTerminal(terminalId);
    const ptyId = found ? getLivePtyId(terminalId) : null;
    if (!found || ptyId == null) {
      useNotificationStore
        .getState()
        .notify("warn", t.project_chat_send_not_ready);
      return;
    }
    setSending(true);
    try {
      const result = await window.termcanvas.managerChat.send(
        {
          terminalId,
          ptyId,
          terminalType: found.terminal.type,
          worktreePath: found.worktree.path,
        },
        text,
      );
      if (result.ok) {
        setDraft("");
      } else {
        useNotificationStore
          .getState()
          .notify("warn", result.detail ?? result.error ?? t.project_chat_send_failed);
      }
    } finally {
      setSending(false);
    }
  }, [draft, sending, terminalId, t]);

  // Only ticks while something is running, so an idle panel is not repainting
  // once a second forever.
  useEffect(() => {
    if (telemetry?.turn_state !== "in_turn") return;
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [telemetry?.turn_state]);

  const turns = useMemo(
    () => (timeline ? buildTurns(timeline.events) : []),
    [timeline],
  );

  // Newest at the bottom, like every other chat surface. Runs after content
  // changes rather than on an interval so it can't fight a user who scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, telemetry?.turn_state]);

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
      style={{ boxShadow: "var(--shadow-elev-2, 0 12px 40px rgba(0,0,0,.35))" }}
    >
      <div className="relative flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="tc-eyebrow tc-mono">
          {isLive
            ? t.project_chat_label
            : `${t.project_chat_label} · ${formatWhen(viewing.startedAt)}`}
        </span>
        <div className="flex items-center gap-2">
          {!isLive && (
            <button
              type="button"
              onClick={() => setViewing(null)}
              className="tc-mono cursor-pointer text-[var(--cyan)] hover:underline"
              style={{ fontSize: "var(--text-xs)" }}
            >
              {t.project_chat_back_to_live}
            </button>
          )}
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              className="tc-mono cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              style={{ fontSize: "var(--text-xs)" }}
            >
              {t.project_chat_history} ▾
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-[var(--text-faint)] hover:text-[var(--text-primary)]"
            aria-label={t.close}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 2L8 8M8 2L2 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Only conversations that held the manager role, which is what the
            tenure log exists to make knowable — the session list on disk is
            filed by project and cannot answer this. */}
        {historyOpen && (
          <div className="absolute right-2 top-full z-10 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
            {history.map((row) => (
              <button
                key={row.sessionId}
                type="button"
                disabled={!row.sessionFile}
                onClick={() => {
                  setViewing(row.isCurrent ? null : row);
                  setHistoryOpen(false);
                }}
                className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
                style={{ fontSize: "var(--text-xs)" }}
              >
                <span className="tc-mono truncate text-[var(--text-secondary)]">
                  {row.cli ?? "agent"}
                  {row.isCurrent && (
                    <span style={{ color: "var(--cyan)" }}> · {t.project_chat_now}</span>
                  )}
                </span>
                <span className="tc-mono shrink-0 tabular-nums text-[var(--text-faint)]">
                  {formatWhen(row.startedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {turns.length === 0 && (
          <div
            className="py-6 text-center"
            style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
          >
            {loading ? t.project_chat_loading : t.project_chat_empty}
          </div>
        )}

        {turns.map((turn) => {
          const nodes = buildAssistantNodes(turn.assistantEvents);
          return (
            <div key={turn.startIndex} className="mb-3 space-y-1">
              {turn.userEvent && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] rounded-lg rounded-br-sm border border-[var(--border)] bg-[var(--surface-hover)] px-2.5 py-1.5"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {turn.userEvent.textPreview}
                  </div>
                </div>
              )}
              {nodes.map((node) => {
                if (node.type === "tool_group") {
                  return <ToolTags key={node.index} node={node} />;
                }
                if (node.type === "thinking") {
                  return (
                    <div
                      key={node.index}
                      className="italic"
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {node.primary.textPreview}
                    </div>
                  );
                }
                if (node.type === "error") {
                  return (
                    <div
                      key={node.index}
                      className="tc-mono"
                      style={{ fontSize: "var(--text-xs)", color: "var(--red)" }}
                    >
                      {node.primary.textPreview}
                    </div>
                  );
                }
                return (
                  <div
                    key={node.index}
                    className={markdownClassName}
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--text-secondary)",
                    }}
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(node.primary.textPreview),
                    }}
                  />
                );
              })}
            </div>
          );
        })}

        {isLive && <RunningStep telemetry={telemetry} now={now} />}
      </div>

      {/* Live conversation only. A finished one has no process to type into —
          sending there would quietly start a different conversation than the
          one on screen. */}
      {isLive && (
        <div className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <span
            className="tc-mono shrink-0 pb-1"
            style={{ fontSize: "var(--text-xs)", color: "var(--cyan)" }}
          >
            ›
          </span>
          <textarea
            rows={1}
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. This is the user's
              // own message — the opposite of the injected notices, which
              // deliberately wait in the input rather than spending a turn.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
              // The canvas listens globally for single-key shortcuts.
              e.stopPropagation();
            }}
            placeholder={t.project_chat_placeholder}
            className="max-h-24 min-h-[1.5rem] flex-1 resize-none bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
            style={{ fontSize: "var(--text-sm)" }}
          />
        </div>
      )}
    </div>
  );
}
