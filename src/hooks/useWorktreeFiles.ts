import { useCallback, useEffect } from "react";
import { useWorktreeFilesStore } from "../stores/worktreeFilesStore";

// Stable empty references so consumers reading "no entry" state don't get
// fresh array identities on every render.
const EMPTY: string[] = [];
const NONE: Record<string, never> = {};

/**
 * A worktree's files for the Files panel. Nothing is listed or watched
 * until `active`: the panel stays mounted while hidden so it reopens
 * instantly, and listing a project nobody is looking at is how a home
 * folder froze the app with the panel closed.
 */
export function useWorktreeFiles(worktreePath: string | null, active = true) {
  const paths = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.paths ?? EMPTY) : EMPTY,
  );
  const ignoredPaths = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.ignoredPaths ?? EMPTY) : EMPTY,
  );
  const mode = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.mode ?? null) : null,
  );
  const lazyReason = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.lazyReason ?? null) : null,
  );
  const folders = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.folders ?? NONE) : NONE,
  );
  const unreadable = useWorktreeFilesStore((s) =>
    worktreePath ? (s.byWorktree[worktreePath]?.unreadable ?? NONE) : NONE,
  );

  // Acquire/release ref counts the worktree in the store so the watcher
  // subscription is shared across consumers and survives a tab toggle that
  // unmounts and immediately remounts this component.
  useEffect(() => {
    if (!worktreePath || !active) return;
    const store = useWorktreeFilesStore.getState();
    store.acquire(worktreePath);
    return () => {
      useWorktreeFilesStore.getState().release(worktreePath);
    };
  }, [worktreePath, active]);

  const refresh = useCallback(() => {
    if (!worktreePath) return Promise.resolve();
    return useWorktreeFilesStore.getState().refresh(worktreePath);
  }, [worktreePath]);

  const openFolder = useCallback(
    (folder: string) => {
      if (!worktreePath) return Promise.resolve();
      return useWorktreeFilesStore.getState().openFolder(worktreePath, folder);
    },
    [worktreePath],
  );

  return { paths, ignoredPaths, mode, lazyReason, folders, unreadable, refresh, openFolder };
}
