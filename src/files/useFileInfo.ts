import { useCallback, useEffect, useState } from "react";
import type { FileTileInfo } from "../../shared/file-tiles";

/**
 * What a file is, read again when its folder changes on disk or the window
 * comes back, so a tile notices the file was edited, moved or deleted.
 * `null` while the first look is under way.
 */
export function useFileInfo(path: string): { info: FileTileInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<FileTileInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    window.tacit.fileTiles
      .inspect(path)
      .then((next) => {
        if (cancelled) return;
        // Unchanged, it keeps the same object, so nothing below re-renders.
        setInfo((prev) => (prev && sameInfo(prev, next) ? prev : next));
      })
      .catch(() => {
        if (!cancelled) setInfo({ ok: false, error: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  useEffect(() => {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const offDir = window.tacit.fs.onDirChanged((changed) => {
      if (changed === dir || dir.startsWith(changed + "/") || path === changed) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      offDir();
      window.removeEventListener("focus", refresh);
    };
  }, [path, refresh]);

  return { info, refresh };
}

function sameInfo(a: FileTileInfo, b: FileTileInfo): boolean {
  if (a.ok !== b.ok) return false;
  if (!a.ok || !b.ok) return !a.ok && !b.ok && a.error === b.error;
  return a.kind === b.kind && a.size === b.size && a.modified === b.modified && a.url === b.url;
}

/** A media URL that changes when the file does, so the tile shows the new one. */
export function versionedUrl(info: FileTileInfo): string | undefined {
  if (!info.ok || !info.url) return undefined;
  return `${info.url}?v=${Math.round(info.modified)}`;
}
