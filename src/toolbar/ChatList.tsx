import { useEffect, useMemo, useRef, useState } from "react";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { shouldRefreshHistorySection } from "../components/historySectionModel";
import { loadHiddenSessions } from "../components/SessionsPanel";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useProjectStore } from "../stores/projectStore";
import { useTasksNeedingYou } from "../tasks/useTasksNeedingYou";
import { agentIcon } from "./agentIcons";
import { chatTitle, stamp, type ChatHistoryEntry } from "./chatHistoryModel";
import { buildChatList, folderDot, liveDot, openTaskCount, orderLive, type ChatListFolder, type ChatListSource } from "./chatListModel";
import { WorkdeskMenu } from "./WorkdeskMenu";
import { usePinStore } from "../stores/pinStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useNotificationStore } from "../stores/notificationStore";
import { panToTerminal } from "../utils/panToTerminal";
import { addProjectFromDirectoryPath, promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { recentFolders } from "../components/canvasEmptyModel";
import { pinKind } from "../../shared/pin";
import type { Pin, ProjectData } from "../types";
import { diffTotals, type DiffTotals } from "./chat/chatPlaceModel";
import { useLiveTree } from "./LiveSessions";
import { useSessionStore } from "../stores/sessionStore";
import { openAllTasks, openListedLiveChat, openListedPastSession } from "../actions/openSession";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { showGridOnFocusedNode, showOpenNodeOnCanvas } from "../workdesk/workdeskModeSwitch";
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

export function ChatList() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const managerId = useCanvasRegistryStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.workspaceManagerTerminalId ?? null,
  );
  const workdeskName = useCanvasRegistryStore((s) => s.canvases.find((c) => c.id === s.activeCanvasId)?.name ?? "");
  const face = useChatDockStore((s) => s.face);
  const tasksWaiting = useTasksNeedingYou().length;
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const { tree } = useLiveTree();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Folders opened or closed by hand; the rest follow `defaultOpen`.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sources: ChatListSource[] = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name, path: p.path, worktreePaths: p.worktrees.map((w) => w.path) })),
    [projects],
  );
  const dirs = useMemo(() => [...new Set(sources.flatMap((s) => [s.path, ...s.worktreePaths]))], [sources]);
  const past = usePastSessions(dirs);
  const gitFolders = useGitFolders(projects.map((p) => p.path));

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
  const folders = useMemo(() => buildChatList(sources, live, past, { hidden, query, keepEmpty: true }), [sources, live, past, hidden, query]);

  const managerType = managerId ? types.get(managerId) : undefined;
  const managerState = managerId ? live.find((i) => i.terminalId === managerId)?.state : undefined;
  const managerLine = !managerId
    ? t.nav_manager_none
    : managerState === "attention"
      ? t.nav_needs_you_word
      : managerState === "active"
        ? t.chat_working
        : (findAgentAdapter(managerType ?? "")?.displayName ?? managerType ?? "");

  // The panel is the manager's: other chats open on the canvas or as grid tabs.
  const openLive = (terminalId: string) => openListedLiveChat(terminalId);
  const openPast = (entry: ChatHistoryEntry) => openListedPastSession({ filePath: entry.filePath, sessionId: entry.sessionId });
  const page = useCanvasPageStore((s) => s.page);
  const readingSession = useSessionStore((s) => (page === "session" ? (s.replayTimeline?.sessionId ?? null) : null));
  const focusedId = useMemo(() => {
    for (const p of projects) for (const w of p.worktrees) for (const term of w.terminals) if (term.focused) return term.id;
    return null;
  }, [projects]);
  // The folder you're in opens by itself: the one whose chat is open, or
  // any with something live; a lone folder is always open.
  const openChatId = focusedId;
  const defaultOpen = (folder: ChatListFolder) =>
    projects.length === 1 || folder.live.some((i) => i.terminalId === openChatId) || folder.live.some((i) => i.state === "attention" || i.state === "active");
  const isOpen = (folder: ChatListFolder) => (query ? true : (openState[folder.key] ?? defaultOpen(folder)));

  return (
    <nav aria-label={t.chat_list_label} className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-1 pl-2.5 pr-2">
        <WorkdeskMenu name={workdeskName} />
        <span className="flex-1" />
        <button
          type="button"
          className={`tc-sq-ctl inline-flex h-8 w-8 shrink-0 items-center justify-center hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] ${searching ? "bg-[var(--surface-hover)] text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
          onClick={() => {
            setSearching((v) => !v);
            if (searching) setQuery("");
          }}
          title={t.chat_list_search}
          aria-label={t.chat_list_search}
          aria-pressed={searching}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M13.5 13.5l-3.2-3.2" />
          </svg>
        </button>
        <button
          type="button"
          className="tc-sq-ctl inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          onClick={() => useChatDockStore.getState().setListOpen(false)}
          title={t.chat_list_fold}
          aria-label={t.chat_list_fold}
        >
          <SidebarGlyph />
        </button>
      </div>
      {searching && (
        <div className="shrink-0 px-2.5 pb-2">
          <label className="tc-sq-ctl flex h-8 items-center gap-2 px-2.5 text-[var(--text-muted)]" style={{ boxShadow: "inset 0 0 0 1px var(--border-hover)" }}>
            <span className="sr-only">{t.chat_list_search}</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                }
              }}
              placeholder={t.chat_list_search}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {!query && (
          <>
            <button
              type="button"
              aria-current={face === "chat" || face === "roster" || undefined}
              onClick={() => useChatDockStore.getState().setFace(managerId ? "chat" : "roster")}
              className={`tc-sq-ctl flex h-11 w-full items-center gap-2.5 px-2 text-left ${face === "chat" || face === "roster" ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"}`}
            >
              <span className="tc-sq-sm flex h-6 w-6 shrink-0 items-center justify-center" style={{ background: managerType ? "color-mix(in srgb, var(--text-primary) 6%, transparent)" : undefined, boxShadow: managerType ? undefined : "inset 0 0 0 1.5px color-mix(in srgb, var(--text-primary) 18%, transparent)" }}>
                {managerType && <img src={agentIcon(managerType)} alt="" className="h-4 w-4 object-contain" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{t.project_chat_title}</span>
                <span className="truncate text-[11.5px] text-[var(--text-muted)]">{managerLine}</span>
              </span>
              {managerState === "attention" ? <Dot kind="need" /> : managerState === "active" ? <Dot kind="run" /> : null}
            </button>
            <NavRow
              icon={<TaskGlyph />}
              label={t.nav_all_tasks}
              selected={page === "tasks"}
              onClick={openAllTasks}
              trailing={tasksWaiting > 0 ? <NeedsBadge text={t.nav_needs_you(tasksWaiting)} /> : undefined}
            />
            <ViewSwitch />
          </>
        )}

        <div className="flex items-center pb-1 pl-2 pr-1 pt-4">
          <span className="tc-eyebrow flex-1">{t.nav_folders}</span>
          <button
            type="button"
            className="tc-sq-sm inline-flex h-6 w-6 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            onClick={() => void promptAndAddProjectToScene(t)}
            title={t.nav_add_folder}
            aria-label={t.nav_add_folder}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>

        {projects.length === 0 && !query && <EmptyFolders />}

        {folders.map((folder) => {
          const project = projects.find((p) => p.id === folder.key) ?? null;
          const open = isOpen(folder);
          const limit = query || expanded.has(folder.key) ? folder.past.length : PAST_LIMIT;
          const shownPast = folder.past.slice(0, limit);
          const more = folder.past.length - shownPast.length;
          const git = project ? gitFolders[project.path] : undefined;
          const primary = project?.worktrees.find((w) => w.isPrimary) ?? project?.worktrees[0];
          const dot = folderDot(folder.live);
          return (
            <section key={folder.key} aria-label={folder.name} className="mt-0.5">
              <button
                type="button"
                className="tc-sq-ctl flex h-8 w-full items-center gap-2 px-2 text-left hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
                aria-expanded={open}
                title={folder.path}
                onClick={() => setOpenState((s) => ({ ...s, [folder.key]: !open }))}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-[var(--text-muted)] transition-transform duration-quick ${open ? "" : "-rotate-90"}`} aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
                <FolderGlyph git={git === true} label={git ? t.nav_git_folder : undefined} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">{folder.name}</span>
                {git && primary?.name && <span className="tc-mono max-w-[40%] shrink truncate text-[11px] text-[var(--text-muted)]">{primary.name}</span>}
                {dot && <Dot kind={dot} />}
              </button>
              {open && (
                <div className="mb-1 ml-[15px] flex flex-col gap-px border-l border-[var(--border)] pl-2">
                  {project && (
                    <FolderTools project={project} git={git === true} open={open} pins={pinsByProject[project.path] ?? []} types={types} />
                  )}
                  {(folder.live.length > 0 || shownPast.length > 0) && <div className="tc-eyebrow px-2 pb-0.5 pt-2">{t.nav_chats}</div>}
                  {orderLive(folder.live).map((item) => {
                    const type = types.get(item.terminalId) ?? "";
                    const state = liveDot(item.state);
                    return (
                      <NavRow
                        key={item.terminalId}
                        small
                        icon={<img src={agentIcon(type)} alt="" className="h-4 w-4 object-contain" />}
                        label={item.title}
                        title={item.locationLabel}
                        selected={focusedId === item.terminalId}
                        trailing={state === "need" ? <NeedsBadge text={t.nav_needs_you_word} /> : state === "run" ? <Dot kind="run" /> : undefined}
                        onClick={() => openLive(item.terminalId)}
                      />
                    );
                  })}
                  {shownPast.map((entry) => (
                    <NavRow
                      key={entry.sessionId}
                      small
                      dim
                      icon={<img src={agentIcon(entry.provider)} alt="" className="h-4 w-4 object-contain opacity-60" />}
                      label={pastTitle(entry, t)}
                      trailing={<span className="shrink-0 text-[11px] text-[var(--text-muted)]">{stamp(entry.lastActivityAt)}</span>}
                      selected={readingSession === entry.sessionId}
                      onClick={() => openPast(entry)}
                    />
                  ))}
                  {more > 0 && (
                    <button
                      type="button"
                      className="tc-sq-ctl flex h-7 w-full items-center px-2 pl-8 text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      onClick={() => setExpanded((s) => new Set(s).add(folder.key))}
                    >
                      {t.chat_list_earlier(more)}
                    </button>
                  )}
                  {project && git && <Worktrees project={project} />}
                </div>
              )}
            </section>
          );
        })}
        {query && folders.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">{t.chat_list_empty}</div>}
      </div>
    </nav>
  );
}

function TaskGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
    </svg>
  );
}

/** A folder; one git tracks wears </> inside it. */
function FolderGlyph({ git, label }: { git: boolean; label?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={git ? "var(--green)" : "var(--text-muted)"} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" className="shrink-0" style={{ opacity: git ? 0.85 : 1 }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />
      {git && <path d="M6.6 7.4L5.2 8.8l1.4 1.4M9.4 7.4l1.4 1.4-1.4 1.4" strokeWidth="1.3" />}
    </svg>
  );
}

function NeedsBadge({ text }: { text: string }) {
  return (
    <span className="shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-[18px]" style={{ background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }}>
      {text}
    </span>
  );
}

/** One row, one destination: an icon, a label and at most one value on the right. */
function NavRow({
  icon,
  label,
  selected,
  dim,
  small,
  trailing,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  dim?: boolean;
  small?: boolean;
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
      className={`tc-sq-ctl flex ${small ? "h-7" : "h-8"} w-full items-center gap-2.5 px-2 text-left transition-colors duration-instant ${
        selected ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">{icon}</span>
      <span className={`min-w-0 flex-1 truncate ${small ? "text-[12.5px]" : "text-[13px]"} ${dim ? "text-[var(--text-muted)]" : selected || !small ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{label}</span>
      {trailing}
    </button>
  );
}

/** Canvas ◐ Grid: the workdesk's two views, one small switch; the knob sits on the side that's on. */
function ViewSwitch() {
  const t = useT();
  const mode = useWorkdeskViewStore((s) => s.mode);
  const grid = mode === "grid";
  // As the rail's view button: the same node (or the tasks) on the other side.
  const flip = () => (grid ? void showOpenNodeOnCanvas() : showGridOnFocusedNode());
  return (
    <div className="flex h-8 items-center gap-2 px-2 text-[13px]">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="2" y="2" width="5" height="5" rx="1.2" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" />
          <rect x="9" y="9" width="5" height="5" rx="1.2" />
        </svg>
      </span>
      <button type="button" className={`ml-0.5 ${grid ? "text-[var(--text-muted)] hover:text-[var(--text-secondary)]" : "text-[var(--text-primary)]"}`} onClick={() => grid && flip()}>
        {t.nav_view_canvas}
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={grid}
        aria-label={t.nav_view_switch}
        title={t.nav_view_switch}
        onClick={flip}
        className="relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors"
        style={{ background: "color-mix(in srgb, var(--text-primary) 14%, transparent)", boxShadow: "inset 0 0 0 1px var(--border)" }}
      >
        <span
          aria-hidden="true"
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left] duration-quick"
          style={{ left: grid ? 14 : 2, background: "var(--text-primary)", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}
        />
      </button>
      <button type="button" className={grid ? "text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"} onClick={() => !grid && flip()}>
        {t.nav_view_grid}
      </button>
    </div>
  );
}

/** A folder's own places: Files, Changes (git), Tasks, Terminal; or a way to start git. */
function FolderTools({ project, git, open, pins, types }: { project: ProjectData; git: boolean; open: boolean; pins: readonly Pin[]; types: ReadonlyMap<string, string> }) {
  const t = useT();
  const primary = project.worktrees.find((w) => w.isPrimary) ?? project.worktrees[0];
  const totals = useFolderChanges(git && open ? (primary?.path ?? null) : null);
  const tasks = openTaskCount(pins.filter((p) => pinKind(p) === "task"));
  const shells = project.worktrees.flatMap((w) => w.terminals).filter((term) => !term.stashed && !findAgentAdapter(types.get(term.id) ?? term.type));
  const panel = (tab: "files" | "diff") => {
    if (primary) useProjectStore.getState().setPanelWorktree(primary.id);
    const canvas = useCanvasStore.getState();
    canvas.setRightPanelCollapsed(false);
    canvas.setRightPanelActiveTab(tab);
  };
  const [settingUp, setSettingUp] = useState(false);
  return (
    <>
      <NavRow
        small
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 1.75h5l3 3v9.5H4z" />
            <path d="M9 1.75v3h3" />
          </svg>
        }
        label={t.nav_files}
        selected={false}
        onClick={() => panel("files")}
      />
      {git && (
        <NavRow
          small
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M5 2.5v6M2 5.5h6M8.5 12.5h5" />
            </svg>
          }
          label={t.nav_changes}
          selected={false}
          onClick={() => panel("diff")}
          trailing={
            totals && (totals.additions > 0 || totals.deletions > 0) ? (
              <span className="tc-mono shrink-0 text-[11px]">
                <span style={{ color: "var(--green)" }}>+{totals.additions}</span> <span style={{ color: "var(--red)" }}>−{totals.deletions}</span>
              </span>
            ) : undefined
          }
        />
      )}
      <NavRow
        small
        icon={<TaskGlyph />}
        label={t.nav_tasks}
        selected={false}
        onClick={openAllTasks}
        trailing={tasks > 0 ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{tasks}</span> : undefined}
      />
      {shells.length > 0 && (
        <NavRow
          small
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5" />
            </svg>
          }
          label={t.nav_terminal}
          selected={false}
          onClick={() => panToTerminal(shells[0].id)}
          trailing={shells.length > 1 ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{shells.length}</span> : undefined}
        />
      )}
      {!git && (
        <NavRow
          small
          dim
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M6.6 5.4L4 8l2.6 2.6M9.4 5.4L12 8l-2.6 2.6" />
            </svg>
          }
          label={t.nav_not_git}
          title={t.nav_git_setup_hint}
          selected={false}
          onClick={() => {
            if (settingUp || !primary) return;
            setSettingUp(true);
            void window.tacit.git
              .init(primary.path)
              .then(() => window.dispatchEvent(new CustomEvent("tacit:git-changed", { detail: { path: project.path } })))
              .catch((error: unknown) => useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error)))
              .finally(() => setSettingUp(false));
          }}
          trailing={<span className="shrink-0 text-[11.5px] text-[var(--text-secondary)]">{settingUp ? "…" : t.nav_git_setup}</span>}
        />
      )}
    </>
  );
}

/** A git folder's other worktrees, each opening the Diff on it. */
function Worktrees({ project }: { project: ProjectData }) {
  const t = useT();
  const others = project.worktrees.filter((w) => !w.isPrimary);
  if (others.length === 0) return null;
  return (
    <>
      <div className="tc-eyebrow px-2 pb-0.5 pt-2">{t.nav_worktrees}</div>
      {others.map((w) => (
        <NavRow
          key={w.id}
          small
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="5" cy="3.5" r="1.5" />
              <circle cx="5" cy="12.5" r="1.5" />
              <circle cx="11" cy="5.5" r="1.5" />
              <path d="M5 5v6M11 7c0 2.5-6 2-6 4" />
            </svg>
          }
          label={w.name}
          title={w.path}
          selected={false}
          onClick={() => {
            useProjectStore.getState().setPanelWorktree(w.id);
            const canvas = useCanvasStore.getState();
            canvas.setRightPanelCollapsed(false);
            canvas.setRightPanelActiveTab("diff");
          }}
          trailing={w.terminals.length > 0 ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{w.terminals.length}</span> : undefined}
        />
      ))}
    </>
  );
}

/** A workdesk with no folders yet: its first step, right here. */
function EmptyFolders() {
  const t = useT();
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const recent = useMemo(() => recentFolders(canvases, activeId), [canvases, activeId]);
  return (
    <div className="tc-sq-card mx-1 mt-1 flex flex-col gap-2.5 px-3 py-3.5" style={{ background: "color-mix(in srgb, var(--text-primary) 3.5%, transparent)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
      <div className="text-[13px] font-semibold text-[var(--text-primary)]">{t.canvas_empty_line_call}</div>
      <div className="text-[12px] leading-snug text-[var(--text-muted)]">{t.nav_empty_body}</div>
      <button
        type="button"
        className="tc-sq-ctl inline-flex h-8 items-center justify-center gap-1.5 text-[13px] font-medium"
        style={{ background: "var(--text-primary)", color: "var(--bg)" }}
        onClick={() => void promptAndAddProjectToScene(t)}
      >
        {t.onboarding_folders_add}
      </button>
      {recent.length > 0 && (
        <>
          <div className="tc-eyebrow pt-1">{t.canvas_empty_recent}</div>
          {recent.map((path) => (
            <button
              key={path}
              type="button"
              className="tc-sq-ctl flex h-7 items-center gap-2 px-1 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              title={path}
              onClick={() => void addProjectFromDirectoryPath(path, t)}
            >
              <FolderGlyph git={false} />
              <span className="min-w-0 flex-1 truncate">{path.split(/[\\/]/).filter(Boolean).pop()}</span>
              <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{t.nav_add}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** Which of these folders git tracks; asked once each, and again when one is set up. */
function useGitFolders(paths: readonly string[]): Record<string, boolean> {
  const [known, setKnown] = useState<Record<string, boolean>>({});
  const key = paths.join("|");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("tacit:git-changed", again);
    return () => window.removeEventListener("tacit:git-changed", again);
  }, []);
  useEffect(() => {
    if (!window.tacit?.git?.isRepo) return;
    let live = true;
    void Promise.all(paths.map(async (p) => [p, await window.tacit.git.isRepo(p).catch(() => false)] as const)).then((pairs) => {
      if (live) setKnown(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return known;
}

/** What a git folder has changed, read when it's open. */
function useFolderChanges(path: string | null): DiffTotals | null {
  const [totals, setTotals] = useState<DiffTotals | null>(null);
  useEffect(() => {
    if (!path || !window.tacit?.project?.diff) {
      setTotals(null);
      return;
    }
    let live = true;
    const read = () =>
      window.tacit.project
        .diff(path)
        .then((r) => live && setTotals(diffTotals(r.files)))
        .catch(() => live && setTotals(null));
    void read();
    // Again when something in the folder changes, a moment after.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.tacit.fs?.onDirChanged?.((changed) => {
      if (!changed.startsWith(path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void read(), 800);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, [path]);
  return totals;
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
