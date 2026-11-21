import { FolderAddMenu } from "./FolderAddMenu";
import { FilesContent } from "../components/RightPanel/FilesContent";
import { openFileInView } from "../actions/openSession";
import { useWorktreeDiff } from "../hooks/useWorktreeDiff";
import { folderToolId, openFolderTool, workdeskActivityTool, workdeskMemoryTool, type FolderToolKind } from "../actions/folderTools";
import { useRecordingTask } from "../components/ActivityView";
import { useMemoryPendingCount } from "../components/MemoryView";
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
import { groupContentMatches, searchFiles, type ContentFileGroup, type FileSearchFolder, type FileSearchHit } from "./fileSearchModel";
import { useFileRevealStore } from "../stores/fileRevealStore";
import { useWorktreeFilesStore } from "../stores/worktreeFilesStore";
import { buildChatList, folderDot, liveDot, matchRanges, openTaskCount, orderLive, searchChats, type ChatListFolder, type ChatListSource, type ChatSearchHit } from "./chatListModel";
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
import { openAllTasks, openFolderTasks, openListedLiveChat, openListedPastSession } from "../actions/openSession";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { showGridOnFocusedNode, showOpenNodeOnCanvas } from "../workdesk/workdeskModeSwitch";
import { treeTerminals } from "./liveSessionsModel";

/**
 * The navigator: the manager, Tasks, then every chat on the workdesk by
 * folder. Its own panel beside the rail; a row opens on the canvas or in the
 * grid, and the list stays, so the manager chat is one click away.
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
  // Lit while the manager's chat is open on its own face, not just remembered.
  const managerLit = useChatDockStore((s) => s.open) && (face === "chat" || face === "roster");
  const tasksWaiting = useTasksNeedingYou().length;
  const workdeskId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const memoryWaiting = useMemoryPendingCount(workdeskId);
  const memoryToolId = useCanvasPageStore((s) => (s.page === "tool" ? s.toolId : null));
  const recordingTask = useRecordingTask();
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const { tree } = useLiveTree();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Folders opened or closed by hand; the rest follow `defaultOpen`.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // One folder's files or changes unfolded at a time.
  const [section, setSection] = useState<{ key: string; kind: FolderSection } | null>(null);
  // Asked for from elsewhere (the palette, a tile's folder label): unfold it here.
  const navRequest = useChatDockStore((s) => s.navRequest);

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
  const folders = useMemo(() => buildChatList(sources, live, past, { hidden, keepEmpty: true }), [sources, live, past, hidden]);
  // Searching swaps the folders for one flat list of matching chats.
  const q = query.trim();
  const hits = useMemo(() => searchChats(sources, live, past, { query: q, hidden, pastTitle: (e) => pastTitle(e, t) }), [sources, live, past, q, hidden, t]);
  // Files too: every folder's, listed while the search is open.
  const searchRoots = useMemo(() => searchRootsOf(projects), [projects]);
  const fileFolders = useSearchFileFolders(searching, searchRoots);
  const fileHits = useMemo(() => searchFiles(fileFolders.folders, q), [fileFolders.folders, q]);
  // Inside files only when asked, for the text as it was when asked.
  const [insideFor, setInsideFor] = useState<string | null>(null);
  const inside = useInsideFileSearch(searching && insideFor !== null && insideFor === q ? q : null, searchRoots);
  const searchInside = () => {
    if (q && searchRoots.length > 0) setInsideFor(q);
  };

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
  const openHit = (hit: ChatSearchHit) => (hit.kind === "live" ? openLive(hit.item.terminalId) : openPast(hit.entry));
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
  useEffect(() => {
    if (!navRequest) return;
    const project = projects.find((p) => p.path === navRequest.path || p.worktrees.some((w) => w.path === navRequest.path));
    useChatDockStore.getState().requestNavSection(null);
    if (!project) return;
    setSection({ key: project.id, kind: navRequest.kind });
    setOpenState(Object.fromEntries(projects.map((p) => [p.id, p.id === project.id])));
  }, [navRequest, projects]);
  const isOpen = (folder: ChatListFolder) => openState[folder.key] ?? defaultOpen(folder);

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
          onClick={() => useChatDockStore.getState().toggleList()}
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
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  // ⌘↵ always looks inside files; ↵ opens the first match, or looks inside when there is none.
                  if (e.metaKey || e.ctrlKey || (!hits[0] && !fileHits.hits[0])) searchInside();
                  else if (hits[0]) openHit(hits[0]);
                  else if (fileHits.hits[0]) openFileInView(fileHits.hits[0].absPath);
                }
              }}
              placeholder={t.chat_list_search}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            {query && (
              <button
                type="button"
                className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                onClick={() => setQuery("")}
                title={t.chat_list_search_clear}
                aria-label={t.chat_list_search_clear}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {q ? (
          <SearchResults
            hits={hits}
            files={fileHits}
            partialFolders={fileFolders.partial}
            inside={searchRoots.length > 0 ? inside : null}
            onSearchInside={searchInside}
            query={q}
            types={types}
            isSelected={(hit) => (hit.kind === "live" ? focusedId === hit.item.terminalId : readingSession === hit.entry.sessionId)}
            onOpen={openHit}
          />
        ) : (
          <>
            <button
              type="button"
              aria-current={managerLit || undefined}
              data-nav-pick=""
              onClick={() => useChatDockStore.getState().showFace(managerId ? "chat" : "roster")}
              className={`tc-sq-ctl flex h-11 w-full items-center gap-2.5 px-2 text-left ${managerLit ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"}`}
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
            <NavRow
              icon={<MemoryGlyph />}
              label={t.mem_title}
              selected={!!workdeskId && memoryToolId === folderToolId(workdeskMemoryTool(workdeskId))}
              onClick={() => workdeskId && openFolderTool(workdeskMemoryTool(workdeskId))}
              trailing={memoryWaiting > 0 ? <NeedsBadge text={t.nav_needs_you(memoryWaiting)} /> : undefined}
            />
            <NavRow
              icon={<ActivityGlyph />}
              label={t.nav_activity}
              selected={!!workdeskId && memoryToolId === folderToolId(workdeskActivityTool(workdeskId))}
              onClick={() => workdeskId && openFolderTool(workdeskActivityTool(workdeskId))}
              title={recordingTask ? t.nav_activity_recording : undefined}
              trailing={recordingTask ? <span className="tc-live-pip h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--red)" }} aria-label={t.nav_activity_recording} /> : undefined}
            />
            <ViewSwitch />

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

        {projects.length === 0 && <EmptyFolders />}

        {folders.map((folder) => {
          const project = projects.find((p) => p.id === folder.key) ?? null;
          const open = isOpen(folder);
          const limit = expanded.has(folder.key) ? folder.past.length : PAST_LIMIT;
          const shownPast = folder.past.slice(0, limit);
          const more = folder.past.length - shownPast.length;
          const git = project ? gitFolders[project.path] : undefined;
          const primary = project?.worktrees.find((w) => w.isPrimary) ?? project?.worktrees[0];
          const dot = folderDot(folder.live);
          return (
            <section key={folder.key} aria-label={folder.name} className="mt-0.5">
              <div className={`group relative ${section?.key === folder.key ? "tc-nav-sticky" : ""}`}>
              <button
                type="button"
                // While its files or changes are unfolded, its name stays on top as you scroll.
                className={`tc-sq-ctl flex h-8 w-full items-center gap-2 px-2 text-left hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)] ${project ? "pr-8" : ""}`}
                aria-expanded={open}
                title={folder.path}
                onClick={() => {
                  if (open && section?.key === folder.key) setSection(null);
                  setOpenState((s) => ({ ...s, [folder.key]: !open }));
                }}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-[var(--text-muted)] transition-transform duration-quick ${open ? "" : "-rotate-90"}`} aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
                <FolderGlyph git={git === true} label={git ? t.nav_git_folder : undefined} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">{folder.name}</span>
                {git && primary?.name && <span className="tc-mono max-w-[40%] shrink truncate text-[11px] text-[var(--text-muted)] transition-opacity duration-quick group-hover:opacity-0">{primary.name}</span>}
                {dot && <Dot kind={dot} />}
              </button>
              {/* Start something in this folder: a chat, a terminal, a worktree, a task. */}
              {project && <FolderAddMenu project={project} git={git === true} />}
              </div>
              {open && (
                <div className="mb-1 ml-[15px] flex flex-col gap-px border-l border-[var(--border)] pl-2">
                  {project && (
                    <FolderTools
                      project={project}
                      git={git === true}
                      open={open}
                      pins={pinsByProject[project.path] ?? []}
                      types={types}
                      section={section?.key === folder.key ? section.kind : null}
                      onSection={(kind) => {
                        setSection(kind ? { key: folder.key, kind } : null);
                        // Unfolding one folder's files or changes folds the others to one line.
                        if (kind) setOpenState(Object.fromEntries(folders.map((f) => [f.key, f.key === folder.key])));
                      }}
                    />
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
          </>
        )}
      </div>
    </nav>
  );
}

/** A title with the searched words brought forward. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, query)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="bg-transparent font-semibold text-[var(--text-primary)]">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * Searching: only the chats that match, in one list, each with its folder,
 * live ones first. A row opens like it does in the list: a live chat on its
 * tile (or its grid tab), a finished one as a page.
 */
function SearchResults({
  hits,
  files,
  partialFolders,
  inside,
  onSearchInside,
  query,
  types,
  isSelected,
  onOpen,
}: {
  hits: readonly ChatSearchHit[];
  files: { hits: readonly FileSearchHit[]; total: number };
  /** Folders too large to list whole: only their opened folders are searched. */
  partialFolders: readonly string[];
  /** Looking inside files, when the workdesk has folders to look in. */
  inside: InsideSearch | null;
  onSearchInside: () => void;
  query: string;
  types: ReadonlyMap<string, string>;
  isSelected: (hit: ChatSearchHit) => boolean;
  onOpen: (hit: ChatSearchHit) => void;
}) {
  const t = useT();
  const [chatsAll, setChatsAll] = useState(false);
  const openFile = useCanvasStore((s) => s.fileEditorPath);
  const insideBlock = inside && <InsideFiles state={inside} query={query} onRun={onSearchInside} enterRuns={hits.length === 0 && files.hits.length === 0} />;
  if (hits.length === 0 && files.hits.length === 0) {
    return (
      <div className="flex flex-col gap-px">
        {inside?.kind !== "done" && (
          <div className="flex flex-col items-center gap-1 px-4 pb-4 pt-8 text-center">
            <div className="text-[12.5px] text-[var(--text-secondary)]">{t.chat_list_no_match(query)}</div>
            <div className="text-[11.5px] leading-snug text-[var(--text-muted)]">{t.chat_list_no_match_hint}</div>
            {partialFolders.length > 0 && <div className="text-[11.5px] leading-snug text-[var(--text-muted)]">{t.nav_search_partial(partialFolders.join(", "))}</div>}
          </div>
        )}
        {insideBlock}
      </div>
    );
  }
  // With files to show too, chats stop at a few until asked for all.
  const chatLimit = files.hits.length > 0 && !chatsAll ? 6 : hits.length;
  return (
    <div className="flex flex-col gap-px">
      {hits.length > 0 && <div className="tc-eyebrow px-2 pb-1 pt-1">{t.nav_search_chats(hits.length)}</div>}
      <div role="list" aria-label={t.nav_search_chats(hits.length)} className="flex flex-col gap-px">
      {hits.slice(0, chatLimit).map((hit) => {
        const selected = isSelected(hit);
        const live = hit.kind === "live";
        const agent = live ? (types.get(hit.item.terminalId) ?? "") : hit.entry.provider;
        const state = live ? liveDot(hit.item.state) : null;
        return (
          <button
            key={live ? hit.item.terminalId : hit.entry.sessionId}
            type="button"
            role="listitem"
            data-nav-pick=""
            aria-current={selected || undefined}
            title={live ? hit.item.locationLabel : hit.title}
            onClick={() => onOpen(hit)}
            className={`tc-sq-ctl flex h-8 w-full items-center gap-2.5 px-2 text-left transition-colors duration-instant ${
              selected ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
            }`}
          >
            <img src={agentIcon(agent)} alt="" className={`h-4 w-4 shrink-0 object-contain${live ? "" : " opacity-60"}`} />
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${live ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"}`}>
              <Highlighted text={hit.title} query={query} />
            </span>
            {state === "need" ? <NeedsBadge text={t.nav_needs_you_word} /> : state === "run" ? <Dot kind="run" /> : null}
            <span className="max-w-[45%] shrink-0 truncate text-[11px] text-[var(--text-muted)]">
              {live ? hit.folder : `${hit.folder} · ${stamp(hit.entry.lastActivityAt)}`}
            </span>
          </button>
        );
      })}
      </div>
      {hits.length > chatLimit && (
        <button type="button" onClick={() => setChatsAll(true)} className="px-2 py-1 text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          {t.nav_search_more(hits.length - chatLimit)}
        </button>
      )}
      {files.hits.length > 0 && (
        <>
          <div className="tc-eyebrow px-2 pb-1 pt-3">{t.nav_search_files(files.total)}</div>
          <div role="list" aria-label={t.nav_search_files(files.total)} className="flex flex-col gap-px">
            {files.hits.map((file) => {
              const selected = openFile === file.absPath;
              return (
                <button
                  key={file.absPath}
                  type="button"
                  role="listitem"
                  data-nav-pick=""
                  aria-current={selected || undefined}
                  title={file.absPath}
                  onClick={() => openFileInView(file.absPath)}
                  className={`tc-sq-ctl flex h-8 w-full items-center gap-2.5 px-2 text-left transition-colors duration-instant ${
                    selected ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
                  }`}
                >
                  <FileGlyph />
                  <span className="min-w-0 shrink truncate text-[12.5px] text-[var(--text-secondary)]">
                    <Highlighted text={file.name} query={query} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]" dir="rtl" style={{ textAlign: "left" }}>
                    <bdi>{file.dir ? `${file.folderLabel}/${file.dir}` : file.folderLabel}</bdi>
                  </span>
                </button>
              );
            })}
          </div>
          {files.total > files.hits.length && <div className="px-2 py-1 text-[11.5px] text-[var(--text-muted)]">{t.nav_search_files_more(files.total - files.hits.length)}</div>}
        </>
      )}
      {partialFolders.length > 0 && <div className="px-2 pt-2 text-[11.5px] leading-snug text-[var(--text-muted)]">{t.nav_search_partial(partialFolders.join(", "))}</div>}
      {insideBlock && <div className="pt-2">{insideBlock}</div>}
    </div>
  );
}

type InsideSearch =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "failed" }
  | { kind: "done"; files: Array<ContentFileGroup & { more: number }>; lines: number };

/**
 * "Search inside files": the last row of the results, run only on a click
 * or Enter, then the matching lines grouped by file. A line opens its file
 * at that line.
 */
function InsideFiles({ state, query, onRun, enterRuns }: { state: InsideSearch; query: string; onRun: () => void; enterRuns: boolean }) {
  const t = useT();
  const openAt = (absPath: string, line: number) => {
    useFileRevealStore.getState().reveal(absPath, line);
    openFileInView(absPath);
  };
  if (state.kind === "idle") {
    return (
      <button
        type="button"
        data-nav-pick=""
        onClick={onRun}
        className="tc-sq-ctl flex h-8 w-full items-center gap-2.5 bg-[color-mix(in_srgb,var(--surface-hover)_55%,transparent)] px-2 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0 text-[var(--text-muted)]" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M13.5 13.5l-3.2-3.2" />
        </svg>
        <span className="min-w-0 flex-1 truncate">{t.nav_search_inside}</span>
        <kbd className="shrink-0 rounded border border-[var(--border)] px-1 font-mono text-[10.5px] text-[var(--text-muted)]">{enterRuns ? "↵" : "⌘↵"}</kbd>
      </button>
    );
  }
  if (state.kind === "running") return <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">{t.nav_search_inside_running}</div>;
  if (state.kind === "failed") return <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">{t.nav_search_inside_failed}</div>;
  if (state.files.length === 0) return <div className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">{t.nav_search_inside_none}</div>;
  return (
    <div className="flex flex-col gap-px">
      <div className="tc-eyebrow px-2 pb-1 pt-1">{t.nav_search_inside_found(state.lines, state.files.length)}</div>
      {state.files.map((file) => (
        <div key={file.absPath} role="group" aria-label={file.name} className="flex flex-col gap-px pb-1">
          <button
            type="button"
            data-nav-pick=""
            title={file.absPath}
            onClick={() => openAt(file.absPath, file.lines[0]?.line ?? 1)}
            className="tc-sq-ctl flex h-7 w-full items-center gap-2.5 px-2 text-left hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
          >
            <FileGlyph />
            <span className="min-w-0 shrink truncate text-[12.5px] text-[var(--text-secondary)]">{file.name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]" dir="rtl" style={{ textAlign: "left" }}>
              <bdi>{file.dir ? `${file.folderLabel}/${file.dir}` : file.folderLabel}</bdi>
            </span>
          </button>
          {file.lines.map((l) => (
            <button
              key={l.line}
              type="button"
              data-nav-pick=""
              aria-label={`${t.nav_search_inside_line(l.line)}: ${l.preview}`}
              onClick={() => openAt(file.absPath, l.line)}
              className="tc-sq-ctl flex h-6 w-full items-center gap-2 pl-8 pr-2 text-left font-mono text-[11.5px] hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"
            >
              <span className="w-8 shrink-0 text-right tabular-nums text-[var(--text-muted)]">{l.line}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                <Highlighted text={l.preview} query={query} />
              </span>
            </button>
          ))}
          {file.more > 0 && <div className="pl-[4.5rem] text-[11px] text-[var(--text-muted)]">{t.nav_search_inside_more(file.more)}</div>}
        </div>
      ))}
    </div>
  );
}

function useInsideFileSearch(query: string | null, roots: ReadonlyArray<{ path: string; label: string }>): InsideSearch {
  const [state, setState] = useState<InsideSearch>({ kind: "idle" });
  const key = roots.map((r) => r.path).join("\n");
  useEffect(() => {
    const search = window.tacit?.search;
    if (query === null || !search || roots.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "running" });
    Promise.all(roots.map((r) => search.fileContents(query, r.path)))
      .then((all) => {
        if (!cancelled) setState({ kind: "done", ...groupContentMatches(roots, all.flat()) });
      })
      .catch((err: unknown) => {
        console.error("[navigator] search inside files failed", err);
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the folders are compared by their paths
  }, [query, key]);
  return state;
}

/** Each folder's main checkout: where the navigator's search looks. */
function searchRootsOf(projects: ReturnType<typeof useProjectStore.getState>["projects"]): Array<{ path: string; label: string }> {
  return projects
    .map((p) => ({ path: (p.worktrees.find((w) => w.isPrimary) ?? p.worktrees[0])?.path ?? p.path, label: p.name }))
    .filter((f) => !!f.path);
}

function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8a.5.5 0 01-.5.5h-7.5a.5.5 0 01-.5-.5v-10.5a.5.5 0 01.5-.5z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

/**
 * Every folder's files, for the navigator's search: listed (and kept
 * current) only while the search is open, then let go, as the Files tree
 * does. A folder too large to list whole is searched as far as it's been
 * opened, and named so the person knows.
 */
function useSearchFileFolders(active: boolean, paths: ReadonlyArray<{ path: string; label: string }>) {
  const key = paths.map((f) => f.path).join("\n");
  useEffect(() => {
    if (!active || !key) return;
    const list = key.split("\n");
    const store = useWorktreeFilesStore.getState();
    for (const path of list) store.acquire(path);
    return () => {
      const s = useWorktreeFilesStore.getState();
      for (const path of list) s.release(path);
    };
  }, [active, key]);
  const byWorktree = useWorktreeFilesStore((s) => s.byWorktree);
  return useMemo(() => {
    if (!active) return { folders: [] as FileSearchFolder[], partial: [] as string[] };
    const folders: FileSearchFolder[] = [];
    const partial: string[] = [];
    for (const f of paths) {
      const entry = byWorktree[f.path];
      if (!entry) continue;
      if (entry.mode === "lazy") partial.push(f.label);
      folders.push({ path: f.path, label: f.label, files: entry.paths.filter((p) => !p.endsWith("/")) });
    }
    return { folders, partial };
  }, [active, paths, byWorktree]);
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
function ActivityGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 8.5h2.5l1.8-4 3.2 8 1.8-4H14" />
    </svg>
  );
}

function MemoryGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5c-2 0-3 1.2-3 2.5-1.3.3-2 1.3-2 2.5 0 1.3.8 2.2 2 2.5 0 1.5 1.2 3 3 3s3-1.5 3-3c1.2-.3 2-1.2 2-2.5 0-1.2-.7-2.2-2-2.5 0-1.3-1-2.5-3-2.5z" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

function NavRow({
  icon,
  label,
  selected,
  dim,
  small,
  trailing,
  title,
  onClick,
  pick = true,
  expanded,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  dim?: boolean;
  small?: boolean;
  trailing?: React.ReactNode;
  title?: string;
  onClick: () => void;
  /** Opens something (closes the navigator when it's over the rest); false for a row that unfolds. */
  pick?: boolean;
  /** For a row that unfolds: whether it is. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      data-nav-pick={pick ? "" : undefined}
      aria-expanded={expanded}
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

/** Which of a folder's own lists is unfolded in the navigator. */
type FolderSection = "files" | "changes";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-[var(--text-muted)] transition-transform duration-quick ${open ? "" : "-rotate-90"}`}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** A folder's changed files, under its Changes: one opens its diff in the pane (a tab in the grid). */
function ChangedFiles({ path, openTool }: { path: string; openTool: string | null }) {
  const t = useT();
  const { fileDiffs, loading } = useWorktreeDiff(path);
  const note = (text: string) => <div className="py-1 pl-9 pr-2 text-[12px] text-[var(--text-muted)]">{text}</div>;
  if (fileDiffs.length === 0) return note(loading ? t.loading : t.nav_no_changes);
  return (
    <div className="flex flex-col gap-px pl-3">
      {fileDiffs.map((fd) => {
        const name = fd.file.name;
        const tool = { kind: "changes" as const, path, focus: name };
        return (
          <NavRow
            key={name}
            small
            icon={
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 1.75h5l3 3v9.5H4z" />
              </svg>
            }
            label={name.split("/").pop() ?? name}
            title={name}
            selected={openTool === folderToolId(tool)}
            onClick={() => openFolderTool(tool)}
            trailing={
              <span className="tc-mono shrink-0 text-[11px]">
                <span style={{ color: "var(--green)" }}>+{fd.file.additions}</span> <span style={{ color: "var(--red)" }}>−{fd.file.deletions}</span>
              </span>
            }
          />
        );
      })}
      <NavRow
        small
        dim
        icon={<span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />}
        label={t.nav_all_changes}
        selected={openTool === folderToolId({ kind: "changes", path })}
        onClick={() => openFolderTool({ kind: "changes", path })}
      />
    </div>
  );
}

/** A folder's own places: Files and Changes (unfolding here), History, Tasks, Memory, Terminal; or a way to start git. */
function FolderTools({
  project,
  git,
  open,
  pins,
  types,
  section,
  onSection,
}: {
  project: ProjectData;
  git: boolean;
  open: boolean;
  pins: readonly Pin[];
  types: ReadonlyMap<string, string>;
  /** Which of its own lists is unfolded in the navigator. */
  section: FolderSection | null;
  onSection: (section: FolderSection | null) => void;
}) {
  const t = useT();
  const primary = project.worktrees.find((w) => w.isPrimary) ?? project.worktrees[0];
  const path = primary?.path ?? null;
  const totals = useFolderChanges(git && open ? path : null);
  const tasks = openTaskCount(pins.filter((p) => pinKind(p) === "task"));
  const shells = project.worktrees.flatMap((w) => w.terminals).filter((term) => !term.stashed && !findAgentAdapter(types.get(term.id) ?? term.type));
  const [settingUp, setSettingUp] = useState(false);
  const toolOpen = useCanvasPageStore((s) => (s.page === "tool" ? s.toolId : null));
  const isOpenTool = (kind: FolderToolKind) => !!path && !!toolOpen && toolOpen.startsWith(`${kind}:${path}`);
  return (
    <>
      <NavRow
        small
        pick={false}
        expanded={section === "files"}
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 1.75h5l3 3v9.5H4z" />
            <path d="M9 1.75v3h3" />
          </svg>
        }
        label={t.nav_files}
        selected={section === "files"}
        onClick={() => onSection(section === "files" ? null : "files")}
        trailing={<Chevron open={section === "files"} />}
      />
      {/* The folder's files, right here: picking one opens it in the pane (a tab in the grid). */}
      {section === "files" && path && (
        <div className="tc-nav-tree my-0.5 flex h-[min(420px,52vh)] min-h-0 flex-col overflow-hidden">
          <FilesContent worktreePath={path} onFileClick={openFileInView} active />
        </div>
      )}
      {git && (
        <NavRow
          small
          pick={false}
          expanded={section === "changes"}
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M5 2.5v6M2 5.5h6M8.5 12.5h5" />
            </svg>
          }
          label={t.nav_changes}
          selected={section === "changes"}
          onClick={() => onSection(section === "changes" ? null : "changes")}
          trailing={
            totals && (totals.additions > 0 || totals.deletions > 0) ? (
              <span className="tc-mono shrink-0 text-[11px]">
                <span style={{ color: "var(--green)" }}>+{totals.additions}</span> <span style={{ color: "var(--red)" }}>−{totals.deletions}</span>
              </span>
            ) : (
              <Chevron open={section === "changes"} />
            )
          }
        />
      )}
      {git && section === "changes" && path && <ChangedFiles path={path} openTool={toolOpen} />}
      {git && path && (
        <NavRow
          small
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 5v3.2l2 1.3" />
            </svg>
          }
          label={t.nav_history}
          selected={isOpenTool("history")}
          onClick={() => openFolderTool({ kind: "history", path })}
        />
      )}
      <NavRow
        small
        icon={<TaskGlyph />}
        label={t.nav_tasks}
        selected={false}
        // This folder's tasks; All tasks above is the workdesk's.
        onClick={() => openFolderTasks(project.path)}
        trailing={tasks > 0 ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{tasks}</span> : undefined}
      />
      {path && (
        <NavRow
          small
          icon={<MemoryGlyph />}
          label={t.nav_memory}
          selected={isOpenTool("memory")}
          onClick={() => openFolderTool({ kind: "memory", path })}
        />
      )}
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
          onClick={() => openFolderTool({ kind: "changes", path: w.path })}
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
