import { create } from "zustand";
import {
  entryPaths,
  folderKeyFor,
  folderPathFor,
  loadedPaths,
  onlyChildFolder,
  withFolderListed,
  withoutFolder,
} from "./folderListing";

// Cache of file lists per worktree, decoupled from any consuming component.
// Lifecycle:
//   acquire(wt) — first consumer attaches: subscribe fs/git watchers, kick
//     a refresh. Repeat consumers just bump the ref count.
//   release(wt) — last consumer detaches: unsubscribe watchers. The cached
//     paths/ignoredPaths stay in memory so re-acquiring is instant
//     (stale-while-revalidate: a fresh refresh fires immediately on re-attach).
//   refresh(wt) — explicit revalidation. Bumps loadId so any in-flight
//     phase 1 / phase 2 from earlier refreshes are dropped on arrival.
//
// The store owns the watcher subscriptions itself, so a tab toggle that
// unmounts the consumer does NOT churn the watcher when there are still
// other consumers (and a quick remount inside the same tick is fine —
// release/acquire just touches refCount, no fs work).
//
// Two modes. A git project of a reasonable size is "full": one listing
// holds the whole tree, its whole folder is watched, and any change in it
// re-lists. Anything else is "lazy", loaded a folder at a time as it is
// opened in the tree (VS Code's explorer and Finder work this way): only
// loaded folders are listed and watched, one level each, and a change in
// one re-lists that folder alone. A home folder is about a million files;
// listing it whole froze the app for minutes.

type LoadStatus = "idle" | "loading" | "loaded";
export type FilesMode = "full" | "lazy";
export type LazyReason = "not-git" | "large";

interface WorktreeEntry {
  paths: string[];
  ignoredPaths: string[];
  status: LoadStatus;
  // Unknown (null) until the first listing says which.
  mode: FilesMode | null;
  lazyReason: LazyReason | null;
  // Lazy: each loaded folder's entries, keyed "" (the worktree) or "a/b/".
  folders: Record<string, readonly string[]>;
  // Lazy: folders that couldn't be read, with why. Not retried until the
  // next refresh, so an expanded unreadable folder doesn't loop.
  unreadable: Record<string, string>;
  // Monotonic; bumped by every refresh. In-flight responses with older ids
  // are dropped so a watcher tick mid-load doesn't lose its data to the
  // earlier load's late phase 2.
  loadId: number;
  // Number of mounted consumers. Reaches 0 when the user navigates away
  // from this worktree's panel; the entry stays in cache.
  refCount: number;
}

interface WorktreeFilesStore {
  byWorktree: Record<string, WorktreeEntry>;
  acquire: (worktreePath: string) => void;
  release: (worktreePath: string) => void;
  refresh: (worktreePath: string) => Promise<void>;
  /** Lazy: loads a folder opened in the tree, if it isn't loaded already. */
  openFolder: (worktreePath: string, folder: string) => Promise<void>;
}

interface WatcherHandle {
  unsubFs: () => void;
  unsubGit: () => void;
}

// Watcher subscriptions live outside zustand state because they hold function
// references that aren't safe to put in a serializable store.
const watchers = new Map<string, WatcherHandle>();
// What each worktree has asked main to watch: its whole tree (full), or
// each loaded folder one level deep (lazy).
const treeWatched = new Set<string>();
const foldersWatched = new Map<string, Set<string>>();
// Lazy: the latest listing request per worktree and folder; an older one
// arriving late is dropped.
const folderLoads = new Map<string, number>();
let folderLoadSeq = 0;

function watchTree(worktreePath: string, on: boolean): void {
  const tc = window.tacit;
  if (!tc || treeWatched.has(worktreePath) === on) return;
  if (on) {
    treeWatched.add(worktreePath);
    void tc.fs.watchDir(worktreePath, true);
  } else {
    treeWatched.delete(worktreePath);
    void tc.fs.unwatchDir(worktreePath, true);
  }
}

function watchFolders(worktreePath: string, add: readonly string[], remove: readonly string[]): void {
  const tc = window.tacit;
  if (!tc) return;
  let watched = foldersWatched.get(worktreePath);
  if (!watched) {
    watched = new Set();
    foldersWatched.set(worktreePath, watched);
  }
  for (const folder of remove) {
    if (!watched.delete(folder)) continue;
    void tc.fs.unwatchDir(folderPathFor(worktreePath, folder), false);
  }
  for (const folder of add) {
    if (watched.has(folder)) continue;
    watched.add(folder);
    void tc.fs.watchDir(folderPathFor(worktreePath, folder), false);
  }
}

function unwatchAll(worktreePath: string): void {
  watchTree(worktreePath, false);
  watchFolders(worktreePath, [], [...(foldersWatched.get(worktreePath) ?? [])]);
}

function ensureWatcher(worktreePath: string): void {
  if (watchers.has(worktreePath)) return;
  const tc = window.tacit;
  if (!tc) return;

  // What gets watched waits for the first listing to say which mode this
  // is (refresh); watching a home folder whole is what this avoids. Main
  // reports the folder that changed, and only this worktree's own changes
  // re-list it.
  const unsubFs = tc.fs.onDirChanged((dirPath: string) => {
    const entry = useWorktreeFilesStore.getState().byWorktree[worktreePath];
    if (!entry) return;
    if (entry.mode === "full") {
      if (dirPath === worktreePath) void useWorktreeFilesStore.getState().refresh(worktreePath);
      return;
    }
    if (entry.mode === "lazy") {
      const folder = folderKeyFor(worktreePath, dirPath);
      if (folder != null && folder in entry.folders) void listFolder(worktreePath, folder);
    }
  });
  const unsubGit = tc.git.onChanged((changedPath: string) => {
    if (useWorktreeFilesStore.getState().byWorktree[worktreePath]?.mode !== "full") return;
    if (
      changedPath === worktreePath ||
      changedPath.startsWith(worktreePath + "/")
    ) {
      void useWorktreeFilesStore.getState().refresh(worktreePath);
    }
  });

  watchers.set(worktreePath, { unsubFs, unsubGit });
}

function dropWatcher(worktreePath: string): void {
  const handle = watchers.get(worktreePath);
  if (!handle) return;
  unwatchAll(worktreePath);
  handle.unsubFs();
  handle.unsubGit();
  watchers.delete(worktreePath);
}

function arraysShallowEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function patchEntry(worktreePath: string, patch: (entry: WorktreeEntry) => Partial<WorktreeEntry> | null): void {
  useWorktreeFilesStore.setState((state) => {
    const cur = state.byWorktree[worktreePath];
    if (!cur) return state;
    const next = patch(cur);
    if (!next) return state;
    return { byWorktree: { ...state.byWorktree, [worktreePath]: { ...cur, ...next } } };
  });
}

/**
 * Lazy: lists one folder and puts its entries in the tree, dropping loaded
 * folders under it that are gone. A folder whose only entry is a folder
 * loads that one too (see onlyChildFolder).
 */
async function listFolder(worktreePath: string, folder: string): Promise<void> {
  const tc = window.tacit;
  if (!tc) return;
  const key = `${worktreePath}\0${folder}`;
  const seq = ++folderLoadSeq;
  folderLoads.set(key, seq);

  let listed: string[] | null = null;
  let failure: string | null = null;
  try {
    const result = await tc.fs.listDir(folderPathFor(worktreePath, folder));
    if ("error" in result) failure = result.error;
    else listed = entryPaths(folder, result.entries);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (folderLoads.get(key) !== seq) return; // superseded
  folderLoads.delete(key);

  let dropped: string[] = [];
  let watchThis = false;
  patchEntry(worktreePath, (cur) => {
    if (cur.mode !== "lazy") return null;
    if (listed == null) {
      // Gone (its parent's listing will drop the row) or unreadable: either
      // way nothing under it is shown, and it isn't retried until a refresh.
      const without = withoutFolder(cur.folders, folder);
      dropped = without.dropped;
      return {
        folders: without.folders,
        unreadable: { ...cur.unreadable, [folder]: failure ?? "unreadable" },
        paths: loadedPaths(without.folders),
        status: "loaded",
      };
    }
    const next = withFolderListed(cur.folders, folder, listed);
    dropped = next.dropped;
    watchThis = true;
    const { [folder]: _wasUnreadable, ...unreadable } = cur.unreadable;
    return { folders: next.folders, unreadable, paths: loadedPaths(next.folders), status: "loaded" };
  });
  if (failure) console.warn(`[files] can't list ${folderPathFor(worktreePath, folder)}: ${failure}`);
  // A listing that lands after the panel let go of this worktree isn't watched.
  watchFolders(worktreePath, watchThis && watchers.has(worktreePath) ? [folder] : [], dropped);

  const chained = listed && onlyChildFolder(folder, listed);
  if (chained) await useWorktreeFilesStore.getState().openFolder(worktreePath, chained);
}

export const useWorktreeFilesStore = create<WorktreeFilesStore>((set, get) => ({
  byWorktree: {},

  acquire: (worktreePath) => {
    set((state) => {
      const existing = state.byWorktree[worktreePath];
      if (existing) {
        return {
          byWorktree: {
            ...state.byWorktree,
            [worktreePath]: { ...existing, refCount: existing.refCount + 1 },
          },
        };
      }
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: {
            paths: [],
            ignoredPaths: [],
            status: "idle",
            mode: null,
            lazyReason: null,
            folders: {},
            unreadable: {},
            loadId: 0,
            refCount: 1,
          },
        },
      };
    });
    ensureWatcher(worktreePath);
    // Always revalidate on acquire. First-time consumers see paths populated
    // when phase 1 lands; re-attaching consumers see cached data immediately
    // and updates roll in if the worktree changed underneath.
    void get().refresh(worktreePath);
  },

  release: (worktreePath) => {
    set((state) => {
      const existing = state.byWorktree[worktreePath];
      if (!existing) return state;
      const nextRefCount = existing.refCount - 1;
      if (nextRefCount > 0) {
        return {
          byWorktree: {
            ...state.byWorktree,
            [worktreePath]: { ...existing, refCount: nextRefCount },
          },
        };
      }
      // Last consumer detached: stop watching but keep the cache. The watcher
      // is the only thing we need to release — the path arrays are GC'd
      // naturally when the entry is replaced or the worktree is forgotten.
      dropWatcher(worktreePath);
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: { ...existing, refCount: 0 },
        },
      };
    });
  },

  refresh: async (worktreePath) => {
    const tc = window.tacit;
    if (!tc) return;
    const initial = get().byWorktree[worktreePath];
    if (!initial) return;

    const myId = initial.loadId + 1;
    set((state) => {
      const cur = state.byWorktree[worktreePath];
      if (!cur) return state;
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: {
            ...cur,
            loadId: myId,
            status: cur.status === "loaded" ? cur.status : "loading",
          },
        },
      };
    });

    // Phase 1: the whole tree of a git project (tracked + non-ignored
    // untracked), or word to load it a folder at a time. On failure the
    // previous list stays, so the user keeps seeing whatever was last good.
    let listing: Awaited<ReturnType<typeof tc.fs.listAllFiles>> | null = null;
    try {
      listing = await tc.fs.listAllFiles(worktreePath);
    } catch (err) {
      console.warn(`[files] can't list ${worktreePath}:`, err);
    }
    {
      const cur = get().byWorktree[worktreePath];
      if (!cur || cur.loadId !== myId) return; // superseded
    }
    if (listing == null) {
      patchEntry(worktreePath, (cur) => (cur.status === "loaded" ? null : { status: "loaded" }));
      return;
    }

    if (listing.type === "lazy") {
      const reason = listing.reason;
      const wasLazy = get().byWorktree[worktreePath]?.mode === "lazy";
      patchEntry(worktreePath, (cur) => ({
        mode: "lazy",
        lazyReason: reason,
        // Coming from full mode, the tree starts again from the top.
        folders: wasLazy ? cur.folders : {},
        paths: wasLazy ? cur.paths : [],
        ignoredPaths: [],
        unreadable: {},
      }));
      // Only the folders open in the tree are watched, and only while the
      // panel shows this worktree.
      watchTree(worktreePath, false);
      const loaded = Object.keys(get().byWorktree[worktreePath]?.folders ?? {});
      if (loaded.length === 0) loaded.push("");
      await Promise.all(loaded.map((folder) => listFolder(worktreePath, folder)));
      return;
    }

    const trackedNext = listing.paths;
    watchFolders(worktreePath, [], [...(foldersWatched.get(worktreePath) ?? [])]);
    if (get().byWorktree[worktreePath]?.refCount) watchTree(worktreePath, true);
    patchEntry(worktreePath, (cur) => {
      if (cur.loadId !== myId) return null;
      const modeChange =
        cur.mode !== "full" ? { mode: "full" as const, lazyReason: null, folders: {}, unreadable: {} } : {};
      if (!arraysShallowEqual(cur.paths, trackedNext)) {
        return { ...modeChange, paths: trackedNext, status: "loaded" };
      }
      // No content change but we did finish loading.
      return cur.status !== "loaded" || cur.mode !== "full" ? { ...modeChange, status: "loaded" } : null;
    });

    // Phase 2: ignored. Slower; runs in background after phase 1. The
    // renderer streams these into the tree via chunked batch-add so the UI
    // doesn't block on the 50k+ entries projects with node_modules can have.
    let ignoredNext: string[] = [];
    try {
      ignoredNext = await tc.fs.listIgnoredFiles(worktreePath);
    } catch {
      ignoredNext = [];
    }
    const cur = get().byWorktree[worktreePath];
    if (!cur || cur.loadId !== myId) return;
    if (arraysShallowEqual(cur.ignoredPaths, ignoredNext)) return;
    set((state) => {
      const c = state.byWorktree[worktreePath];
      if (!c || c.loadId !== myId) return state;
      return {
        byWorktree: {
          ...state.byWorktree,
          [worktreePath]: { ...c, ignoredPaths: ignoredNext },
        },
      };
    });
  },

  openFolder: async (worktreePath, folder) => {
    const entry = get().byWorktree[worktreePath];
    if (!entry || entry.mode !== "lazy") return;
    if (folder in entry.folders || folder in entry.unreadable) return;
    if (folderLoads.has(`${worktreePath}\0${folder}`)) return; // already loading
    await listFolder(worktreePath, folder);
  },
}));
