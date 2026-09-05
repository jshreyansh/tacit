import { useEffect } from "react";
import { parseDiff } from "../utils/diffParser";
import {
  EMPTY_DIFF_CACHE,
  useLeftPanelRepoStore,
} from "../stores/leftPanelRepoStore";

export function useWorktreeDiff(worktreePath: string | null) {
  const snapshot = useLeftPanelRepoStore((state) =>
    worktreePath
      ? state.diffByPath[worktreePath] ?? EMPTY_DIFF_CACHE
      : EMPTY_DIFF_CACHE,
  );

  useEffect(() => {
    if (!worktreePath || !window.tacit) {
      return;
    }

    let active = true;
    let requestSeq = 0;

    const fetchDiff = () => {
      const currentRequest = ++requestSeq;
      useLeftPanelRepoStore.getState().beginDiffLoad(worktreePath);
      window.tacit.project.diff(worktreePath).then((result) => {
        if (!active || currentRequest !== requestSeq) return;
        useLeftPanelRepoStore.getState().resolveDiffLoad(
          worktreePath,
          parseDiff(result.diff, result.files),
        );
      }).catch(() => {
        if (!active || currentRequest !== requestSeq) return;
        useLeftPanelRepoStore.getState().failDiffLoad(worktreePath);
      });
    };

    fetchDiff();

    window.tacit.git.watch(worktreePath);
    const removeGitChanged = window.tacit.git.onChanged((changedPath) => {
      if (changedPath === worktreePath) fetchDiff();
    });

    const handleActivity = (e: Event) => {
      if ((e as CustomEvent).detail === worktreePath) fetchDiff();
    };
    const handleFocus = () => fetchDiff();

    window.addEventListener("tacit:worktree-activity", handleActivity);
    window.addEventListener("focus", handleFocus);

    return () => {
      active = false;
      requestSeq += 1;
      window.tacit.git.unwatch(worktreePath);
      removeGitChanged();
      window.removeEventListener("tacit:worktree-activity", handleActivity);
      window.removeEventListener("focus", handleFocus);
    };
  }, [worktreePath]);

  return {
    fileDiffs: snapshot.fileDiffs,
    loading: snapshot.loading,
    refreshing: snapshot.refreshing,
  };
}
