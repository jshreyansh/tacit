import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayTimeline } from "../../shared/sessions";
import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import { useT } from "../i18n/useT";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import {
  buildAssistantNodes,
  buildTurns,
  summarizeToolNames,
  toolSubjectHint,
  toolVerb,
  type AssistantNode,
  type Turn,
} from "../components/transcriptModel";
import { markdownClassName, renderMarkdown } from "../utils/markdownClass";

/**
 * The parts of the Project Chat control that deal with the conversation.
 *
 * The control itself — the three heights, the hover, the agent picker — lives
 * in WorkspaceManagerPill, which owns the role and the position. This file owns
 * only what is being said, so the two concerns don't tangle.
 *
 * A window onto the manager's real terminal, never a second place to talk to
 * it: one process, one transcript, whichever height you are reading at.
 */

/** How often the running step's clock re-renders while a turn is in flight. */
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

/** First line of text, trimmed to fit the single-line peek. */
function firstLine(text: string, max = 90): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface ManagerConversation {
  turns: Turn[];
  loading: boolean;
  telemetry: TerminalTelemetrySnapshot | null;
  /** Newest assistant reply, one line — what the peek shows when idle. */
  lastReply: string | null;
  now: number;
  reload: () => void;
}

/**
 * Reads the manager's conversation from two sources, deliberately split.
 *
 * The transcript covers everything already said and is read as a snapshot, so
 * finished prose arrives in jumps when a turn ends. Live telemetry covers the
 * step running right now, which the app already tracks per terminal to drive
 * tile status. The half being watched moves smoothly; only the half that has
 * stopped changing is stale.
 */
export function useManagerConversation(
  terminalId: string,
  sessionFilePath: string | null,
  isLive: boolean,
): ManagerConversation {
  const [timeline, setTimeline] = useState<ReplayTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const telemetry = useTerminalRuntimeStore(
    (s) => s.terminals[terminalId]?.telemetry ?? null,
  );

  const load = useCallback(async () => {
    if (!sessionFilePath) {
      setTimeline(null);
      return;
    }
    setLoading(true);
    try {
      setTimeline(await window.tacit.sessions.loadReplay(sessionFilePath));
    } catch {
      // A conversation that can't be read yet is not an error worth shouting
      // about — the file appears once the agent writes its first turn.
      setTimeline(null);
    } finally {
      setLoading(false);
    }
  }, [sessionFilePath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read when a turn ends: with a snapshot read, that is the moment the
  // content actually changed. Skipped for a past conversation — that file is
  // finished, and refreshing it would yank the reader's scroll.
  useEffect(() => {
    if (!isLive) return;
    return window.tacit.hooks.onTurnComplete((payload) => {
      if (payload.terminalId !== terminalId) return;
      void load();
    });
  }, [terminalId, load, isLive]);

  // Only ticks while something is running, so an idle control is not
  // repainting once a second forever.
  useEffect(() => {
    if (telemetry?.turn_state !== "in_turn") return;
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [telemetry?.turn_state]);

  const turns = useMemo(
    () => (timeline ? buildTurns(timeline.events) : []),
    [timeline],
  );

  const lastReply = useMemo(() => {
    if (!timeline) return null;
    for (let i = timeline.events.length - 1; i >= 0; i -= 1) {
      const ev = timeline.events[i];
      if (ev.type === "assistant_text" && ev.textPreview.trim()) {
        return firstLine(ev.textPreview);
      }
    }
    return null;
  }, [timeline]);

  return { turns, loading, telemetry, lastReply, now, reload: () => void load() };
}

/**
 * The single line above the composer.
 *
 * This is what makes the composer height usable on its own: you can send
 * something and watch the answer land without ever opening the full view. It
 * shows the running tool while the agent works, and the last thing it said once
 * it stops.
 */
export function PeekLine({
  conversation,
}: {
  conversation: ManagerConversation;
}) {
  const t = useT();
  const { telemetry, lastReply, now } = conversation;
  const running = telemetry?.turn_state === "in_turn";

  if (!running && !lastReply) return null;

  if (running) {
    const elapsed = formatElapsed(telemetry?.turn_started_at, now);
    return (
      <div
        className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-3 py-1.5"
        style={{ background: "color-mix(in srgb, var(--cyan) 7%, transparent)" }}
      >
        <span
          aria-hidden
          className="tc-live-pip shrink-0 rounded-full"
          style={{ width: 5, height: 5, background: "var(--cyan)" }}
        />
        <span
          className="tc-mono truncate"
          style={{ fontSize: "var(--text-xs)", color: "var(--cyan)" }}
        >
          {telemetry?.foreground_tool
            ? toolVerb(telemetry.foreground_tool)
            : t.project_chat_thinking}
        </span>
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

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-3 py-1.5">
      <span
        className="truncate"
        style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        title={lastReply ?? undefined}
      >
        {lastReply}
      </span>
    </div>
  );
}

/** One collapsed run of tool calls, opening to the individual calls. */
function ToolTags({ node }: { node: AssistantNode }) {
  const items = node.items ?? [];
  const failed = items.filter((it) => it.result?.isError).length;
  // A run that failed opens by default; the toggle records "differs from the
  // default" so one piece of state drives both directions. Folding away the one
  // call worth reading is the failure this treatment exists to prevent.
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
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-muted)",
                    }}
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

/** The scrolling conversation, shown only at the full height. */
export function ConversationBody({
  conversation,
  isLive,
}: {
  conversation: ManagerConversation;
  isLive: boolean;
}) {
  const t = useT();
  const { turns, loading, telemetry, now } = conversation;
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = isLive && telemetry?.turn_state === "in_turn";

  // Newest at the bottom. Runs after content changes rather than on a timer so
  // it can't fight a reader who scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, running]);

  return (
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
    </div>
  );
}
