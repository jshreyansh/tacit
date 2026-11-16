import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { useSessionStore } from "../stores/sessionStore";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { agentIcon } from "./agentIcons";
import { StatusChip } from "../components/ui/parts";
import { groupHistoryByProject, shouldRefreshHistorySection } from "../components/historySectionModel";
import {
  loadHiddenSessions,
  loadPinnedSessions,
  persistHiddenSessions,
  persistPinnedSessions,
} from "../components/SessionsPanel";
import {
  chatTitle,
  filterChatHistory,
  projectName,
  stamp,
  type ChatHistoryEntry,
} from "./chatHistoryModel";

/**
 * Past chats, inside the docked workdesk manager chat (SHR-127). It took
 * over from the left bar's History panel and says more per row: which
 * agent, a readable title (the manager's own sessions named as such rather
 * than by their briefing), how many messages, how long it ran, when, and
 * whether it held the manager's seat. Clicking a row opens the transcript
 * in the session view beside the chat, with Resume.
 *
 * Same data as the History panel (the main process's session index, scoped
 * to every worktree on this canvas) and the same hide and pin lists, so the
 * two never disagree.
 */

const PAGE_SIZE = 100;
const GROUP_LIMIT = 7;
const REFRESH_DEBOUNCE_MS = 120;

type Dict = ReturnType<typeof useT>;

function titleText(entry: ChatHistoryEntry, t: Dict): { text: string; manager: boolean } {
  const title = chatTitle(entry.firstPrompt);
  switch (title.kind) {
    case "manager":
      return { text: t.chat_history_manager_session, manager: true };
    case "pasted":
      return { text: t.chat_history_pasted, manager: false };
    case "untitled":
      return { text: t.chat_history_untitled, manager: false };
    case "text":
      return { text: title.text, manager: false };
  }
}

/** A star, not a pin: pins are the work you record (the Pins view). */
function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4L2.2 6.3l4-.6z" />
    </svg>
  );
}

function HistoryItem({
  entry,
  selected,
  heldSeat,
  current,
  pinned,
  onOpen,
  onTogglePin,
  onHide,
}: {
  entry: ChatHistoryEntry;
  selected: boolean;
  heldSeat: boolean;
  current: boolean;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onHide: () => void;
}) {
  const t = useT();
  const [armHide, setArmHide] = useState(false);
  useEffect(() => {
    if (!armHide) return;
    const timer = setTimeout(() => setArmHide(false), 3000);
    return () => clearTimeout(timer);
  }, [armHide]);

  const { text, manager } = titleText(entry, t);
  const icon = agentIcon(entry.provider);
  const agent = findAgentAdapter(entry.provider)?.displayName ?? entry.provider;
  // One meta line: which agent, and whether it held the manager's seat.
  // The index only estimates message counts from file size (off by 100x
  // for long sessions), so the row doesn't show one.
  const meta = heldSeat && !manager ? `${agent} · ${t.chat_history_badge_manager}` : agent;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      className="tc-row group relative cursor-pointer"
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={entry.firstPrompt}
    >
      <span className="tc-icon-shell shrink-0" style={{ width: 22, height: 22 }}>
        {icon && <img src={icon} alt="" className="h-[15px] w-[15px] object-contain" draggable={false} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="tc-row-title block">{text}</span>
        <span className="tc-row-meta block">{meta}</span>
      </span>
      {current ? (
        <span className="group-hover:hidden">
          <StatusChip tone="live">{t.chat_history_badge_now}</StatusChip>
        </span>
      ) : (
        <span className="tc-timestamp group-hover:hidden">{stamp(entry.lastActivityAt)}</span>
      )}
      {/* Star and hide on hover, in the stamp's place. Hiding takes two
          clicks, as in the History panel. */}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          className="tc-rail-btn inline-flex h-6 w-6 items-center justify-center"
          style={{ color: pinned ? "var(--accent)" : "var(--text-muted)" }}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          aria-label={pinned ? t.chat_history_unpin : t.chat_history_pin}
          title={pinned ? t.chat_history_unpin : t.chat_history_pin}
        >
          <StarGlyph filled={pinned} />
        </button>
        <button
          type="button"
          className="tc-rail-btn inline-flex h-6 w-6 items-center justify-center"
          style={{ color: armHide ? "var(--red)" : "var(--text-muted)" }}
          onClick={(e) => {
            e.stopPropagation();
            if (armHide) onHide();
            else setArmHide(true);
          }}
          aria-label={armHide ? t.chat_history_hide_confirm : t.chat_history_hide}
          title={armHide ? t.chat_history_hide_confirm : t.chat_history_hide}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </span>
    </div>
  );
}

export function ChatHistory({
  projectDirs,
  managerSessionIds,
  currentSessionId,
  onOpen,
  live,
}: {
  projectDirs: string[];
  /** Sessions that held the manager's seat, from the tenure log. */
  managerSessionIds: ReadonlySet<string>;
  /** The manager's live session, marked "now". */
  currentSessionId: string | null;
  onOpen: (filePath: string) => void;
  /**
   * What is on the workdesk now, above the past sessions, given the search
   * so one box searches both (the Sessions view).
   */
  live?: (query: string) => React.ReactNode;
}) {
  const t = useT();
  const [entries, setEntries] = useState<ChatHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHiddenSessions());
  const [pinned, setPinned] = useState<Set<string>>(() => loadPinnedSessions());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Map<string, number>>(new Map());
  const openSessionId = useSessionStore((s) => s.replayTimeline?.sessionId ?? null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dirsKey = projectDirs.join("|");

  useEffect(() => {
    const api = window.tacit?.search?.listSessionsPage;
    if (!api || projectDirs.length === 0) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api(projectDirs, { limit: PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (!cancelled) setEntries(page.entries as ChatHistoryEntry[]);
      })
      .catch(() => {
        // An unreadable index is an empty list, not a broken chat.
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dirsKey, refreshVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // New activity in a project on this canvas refreshes the list.
  useEffect(() => {
    if (!window.tacit?.sessions?.onHistoryChanged) return;
    const off = window.tacit.sessions.onHistoryChanged((payload) => {
      if (!shouldRefreshHistorySection(projectDirs, payload.projectDirs)) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        setRefreshVersion((v) => v + 1);
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [dirsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  // A session hidden from the reader's menu leaves this list too.
  useEffect(() => {
    const reload = () => setHidden(loadHiddenSessions());
    window.addEventListener("tacit:history-hidden", reload);
    return () => window.removeEventListener("tacit:history-hidden", reload);
  }, []);

  const togglePin = useCallback((sessionId: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      persistPinnedSessions(next);
      return next;
    });
  }, []);

  const hide = useCallback((sessionId: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      persistHiddenSessions(next);
      return next;
    });
  }, []);

  const visible = useMemo(
    () => filterChatHistory(entries.filter((e) => !hidden.has(e.sessionId)), query),
    [entries, hidden, query],
  );
  const pinnedEntries = useMemo(
    () =>
      visible
        .filter((e) => pinned.has(e.sessionId))
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
    [visible, pinned],
  );
  const groups = useMemo(() => groupHistoryByProject(visible.filter((e) => !pinned.has(e.sessionId))), [visible, pinned]);
  const searching = query.trim().length > 0;

  const item = (entry: ChatHistoryEntry) => (
    <HistoryItem
      key={entry.sessionId}
      entry={entry}
      selected={openSessionId === entry.sessionId}
      heldSeat={managerSessionIds.has(entry.sessionId)}
      current={currentSessionId === entry.sessionId}
      pinned={pinned.has(entry.sessionId)}
      onOpen={() => onOpen(entry.filePath)}
      onTogglePin={() => togglePin(entry.sessionId)}
      onHide={() => hide(entry.sessionId)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-2.5 text-[var(--text-muted)] focus-within:border-[var(--border-hover)]">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M13.5 13.5l-3.2-3.2" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The canvas listens globally for single-key shortcuts.
              e.stopPropagation();
              if (e.key === "Escape" && query) {
                setQuery("");
              }
            }}
            placeholder={live ? t.chat_sessions_search : t.chat_history_search}
            aria-label={live ? t.chat_sessions_search : t.chat_history_search}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {live?.(query)}
        {live && (
          <div className="tc-eyebrow px-3.5 pb-1 pt-3">{t.chat_sessions_earlier}</div>
        )}
        {loading && entries.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">{t.chat_history_loading}</div>
        )}
        {!loading && entries.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">{t.chat_history_empty}</div>
        )}
        {entries.length > 0 && visible.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">{t.chat_history_no_match}</div>
        )}

        {pinnedEntries.length > 0 && (
          <section className="mb-1" aria-label={t.chat_history_pinned}>
            <div className="tc-eyebrow px-4 pb-1 pt-1.5">{t.chat_history_pinned}</div>
            {pinnedEntries.map(item)}
          </section>
        )}

        {groups.map((group) => {
          const isCollapsed = !searching && collapsed.has(group.projectDir);
          const limit = searching ? group.entries.length : (limits.get(group.projectDir) ?? GROUP_LIMIT);
          const shown = group.entries.slice(0, limit);
          const more = group.entries.length - shown.length;
          return (
            <section key={group.projectDir} className="mb-1" aria-label={projectName(group.projectDir)}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3.5 pb-1 pt-2 text-left"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.projectDir)) next.delete(group.projectDir);
                    else next.add(group.projectDir);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                title={group.projectDir}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" className={`shrink-0 text-[var(--text-muted)] transition-transform duration-quick ${isCollapsed ? "" : "rotate-90"}`} aria-hidden="true">
                  <path d="M3 2l4 3-4 3z" fill="currentColor" />
                </svg>
                <span className="tc-eyebrow truncate">{projectName(group.projectDir)}</span>
                <span className="tc-count">{group.entries.length}</span>
              </button>
              {!isCollapsed && shown.map(item)}
              {!isCollapsed && more > 0 && (
                <button
                  type="button"
                  className="ml-12 mt-0.5 px-1 py-1 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={() => setLimits((prev) => new Map(prev).set(group.projectDir, limit + GROUP_LIMIT))}
                >
                  {t.chat_history_more(more)}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
