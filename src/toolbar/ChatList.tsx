import { useEffect, useMemo, useRef, useState } from "react";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { findTerminal } from "../actions/terminalLookup";
import { shouldRefreshHistorySection } from "../components/historySectionModel";
import { loadHiddenSessions } from "../components/SessionsPanel";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTasksNeedingYou } from "../tasks/useTasksNeedingYou";
import { agentIcon } from "./agentIcons";
import { chatTitle, stamp, type ChatHistoryEntry } from "./chatHistoryModel";
import { buildChatList, liveDot, type ChatListSource } from "./chatListModel";
import { useLiveTree } from "./LiveSessions";
import { treeTerminals } from "./liveSessionsModel";

/**
 * The list beside the open chat (the Manager panel, docked or full screen):
 * the manager, Tasks, then every chat on the workdesk by folder. A row opens
 * on the right; the list stays, so the manager chat is one click away.
 */

const PAGE_SIZE = 100;
/** Finished sessions shown per folder before "Show earlier". */
const PAST_LIMIT = 3;

type Dict = ReturnType<typeof useT>;

function pastTitle(entry: ChatHistoryEntry, t: Dict): string {
  const title = chatTitle(entry.firstPrompt);
  if (title.kind === "manager") return t.chat_history_manager_session;
  if (title.kind === "pasted") return t.chat_history_pasted;
  if (title.kind === "untitled") return t.chat_history_untitled;
  return title.text;
}

/** Finished sessions in this workdesk's folders, from the main process's session index. */
function usePastSessions(dirs: string[]): ChatHistoryEntry[] {
  const [entries, setEntries] = useState<ChatHistoryEntry[]>([]);
  const [version, setVersion] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHiddenSessions());
  const key = dirs.join("|");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const api = window.tacit?.search?.listSessionsPage;
    if (!api || dirs.length === 0) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void api(dirs, { limit: PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (!cancelled) setEntries(page.entries as ChatHistoryEntry[]);
      })
      .catch(() => {
        // An unreadable index is an empty list, not a broken panel.
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // New activity in one of these folders refreshes the list.
  useEffect(() => {
    if (!window.tacit?.sessions?.onHistoryChanged) return;
    const off = window.tacit.sessions.onHistoryChanged((payload) => {
      if (!shouldRefreshHistorySection(dirs, payload.projectDirs)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setVersion((v) => v + 1), 150);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A session hidden from the reader's menu leaves the list too.
  useEffect(() => {
    const reload = () => setHidden(loadHiddenSessions());
    window.addEventListener("tacit:history-hidden", reload);
    return () => window.removeEventListener("tacit:history-hidden", reload);
  }, []);

  return useMemo(() => entries.filter((e) => !hidden.has(e.sessionId)), [entries, hidden]);
}

function Dot({ kind }: { kind: "run" | "need" | "ended" }) {
  if (kind === "ended") {
    return <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full border border-[var(--text-muted)] opacity-70" />;
  }
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full${kind === "run" ? " tc-live-pip" : ""}`}
      style={{ background: kind === "run" ? "var(--green)" : "var(--amber)" }}
    />
  );
}

function Row({
  icon,
  label,
  detail,
  selected,
  dim,
  trailing,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  selected: boolean;
  dim?: boolean;
  trailing?: React.ReactNode;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      title={title}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors duration-instant ${
        selected ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={`truncate text-[13px] ${dim ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"}`}>{label}</span>
        {detail && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{detail}</span>}
      </span>
      {trailing}
    </button>
  );
}

export function ChatList() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const managerId = useCanvasRegistryStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.workspaceManagerTerminalId ?? null,
  );
  const workdeskName = useCanvasRegistryStore((s) => s.canvases.find((c) => c.id === s.activeCanvasId)?.name ?? "");
  const face = useChatDockStore((s) => s.face);
  const readerTerminalId = useChatDockStore((s) => s.readerTerminalId);
  const liveChatId = useSessionStore((s) => s.liveChatTerminalId);
  const replaySessionId = useSessionStore((s) => s.replayTimeline?.sessionId ?? null);
  const tasksWaiting = useTasksNeedingYou().length;
  const { tree } = useLiveTree();
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sources: ChatListSource[] = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name, path: p.path, worktreePaths: p.worktrees.map((w) => w.path) })),
    [projects],
  );
  const dirs = useMemo(() => [...new Set(sources.flatMap((s) => [s.path, ...s.worktreePaths]))], [sources]);
  const past = usePastSessions(dirs);

  // Each terminal's kind: the manager is pinned above, and shells aren't chats.
  const types = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) for (const w of p.worktrees) for (const term of w.terminals) map.set(term.id, term.type);
    return map;
  }, [projects]);
  const hidden = useMemo(() => {
    const set = new Set<string>();
    if (managerId) set.add(managerId);
    for (const [id, type] of types) if (!findAgentAdapter(type)) set.add(id);
    return set;
  }, [types, managerId]);
  const live = useMemo(() => treeTerminals(tree), [tree]);
  const folders = useMemo(() => buildChatList(sources, live, past, { hidden, query }), [sources, live, past, hidden, query]);

  const reading = face === "sessions";
  const managerType = managerId ? types.get(managerId) : undefined;

  const openLive = (terminalId: string) => {
    const terminal = findTerminal(terminalId)?.terminal;
    if (terminal?.chatMode) {
      useSessionStore.getState().openLiveChat(terminalId);
      useChatDockStore.getState().showReader(null);
    } else {
      useChatDockStore.getState().showReader(terminalId);
    }
  };
  const openPast = (entry: ChatHistoryEntry) => {
    void useSessionStore.getState().loadReplay(entry.filePath);
    useChatDockStore.getState().showReader(null);
  };
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <nav aria-label={t.chat_list_label} className="flex h-full min-h-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">{workdeskName}</span>
        <button
          type="button"
          className="tc-rail-btn inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => useChatDockStore.getState().setListOpen(false)}
          title={t.chat_list_fold}
          aria-label={t.chat_list_fold}
        >
          <SidebarGlyph />
        </button>
      </div>
      <div className="shrink-0 px-2.5 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 text-[var(--text-muted)] focus-within:border-[var(--border-hover)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M13.5 13.5l-3.2-3.2" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" && query) setQuery("");
            }}
            placeholder={t.chat_list_search}
            aria-label={t.chat_list_search}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <Row
          icon={managerType ? <img src={agentIcon(managerType)} alt="" className="h-4 w-4 object-contain" /> : <span className="h-3 w-3 rounded-full border border-dashed border-[var(--text-muted)]" />}
          label={t.project_chat_title}
          detail={managerType ? (findAgentAdapter(managerType)?.displayName ?? managerType) : t.assign_none}
          selected={face === "chat" || face === "roster"}
          onClick={() => useChatDockStore.getState().setFace(managerId ? "chat" : "roster")}
        />
        <Row
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]" aria-hidden="true">
              <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
              <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
            </svg>
          }
          label={t.tasks_title}
          selected={face === "pins"}
          trailing={
            tasksWaiting > 0 ? (
              <span className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold" style={{ background: "color-mix(in srgb, var(--amber) 18%, transparent)", color: "var(--amber)" }}>
                {tasksWaiting}
              </span>
            ) : undefined
          }
          onClick={() => useChatDockStore.getState().setFace("pins")}
        />

        {folders.map((folder) => {
          const isFolded = !query && folded.has(folder.key);
          const limit = query || expanded.has(folder.key) ? folder.past.length : PAST_LIMIT;
          const shownPast = folder.past.slice(0, limit);
          const more = folder.past.length - shownPast.length;
          return (
            <section key={folder.key} aria-label={folder.name} className="mt-2">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 pb-1 pt-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                aria-expanded={!isFolded}
                title={folder.path}
                onClick={() => setFolded((s) => toggle(s, folder.key))}
              >
                <span className="truncate font-medium">{folder.name}</span>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform duration-quick ${isFolded ? "-rotate-90" : ""}`} aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {!isFolded && (
                <>
                  {folder.live.map((item) => {
                    const dot = liveDot(item.state);
                    const type = types.get(item.terminalId) ?? "";
                    return (
                      <Row
                        key={item.terminalId}
                        icon={<img src={agentIcon(type)} alt="" className="h-4 w-4 object-contain" />}
                        label={item.title}
                        title={item.locationLabel}
                        selected={reading && (readerTerminalId === item.terminalId || (!readerTerminalId && liveChatId === item.terminalId))}
                        trailing={dot ? <Dot kind={dot} /> : undefined}
                        onClick={() => openLive(item.terminalId)}
                      />
                    );
                  })}
                  {shownPast.map((entry) => (
                    <Row
                      key={entry.sessionId}
                      dim
                      icon={<img src={agentIcon(entry.provider)} alt="" className="h-4 w-4 object-contain opacity-60" />}
                      label={pastTitle(entry, t)}
                      title={entry.firstPrompt}
                      selected={reading && !readerTerminalId && !liveChatId && replaySessionId === entry.sessionId}
                      trailing={<span className="tc-timestamp shrink-0 text-[11px] text-[var(--text-muted)]">{stamp(entry.lastActivityAt)}</span>}
                      onClick={() => openPast(entry)}
                    />
                  ))}
                  {more > 0 && (
                    <button
                      type="button"
                      className="ml-8 px-1 py-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      onClick={() => setExpanded((s) => toggle(s, folder.key))}
                    >
                      {t.chat_list_earlier(more)}
                    </button>
                  )}
                </>
              )}
            </section>
          );
        })}
        {folders.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">{query ? t.chat_history_no_match : t.chat_list_empty}</div>
        )}
      </div>
    </nav>
  );
}

/** A window with a sidebar: folds or unfolds the list. */
export function SidebarGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </svg>
  );
}
