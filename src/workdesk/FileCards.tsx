import { useEffect, useRef, useState } from "react";
import { formatFileSize } from "../../shared/file-tiles";
import { useT } from "../i18n/useT";
import { useFileTileStore, type FileTileData } from "../stores/fileTileStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { FileKindIcon } from "../canvas/FileTileNode";
import { fileName } from "../files/FilePreview";
import { useFileInfo, versionedUrl } from "../files/useFileInfo";

/**
 * The grid's Files row: every file shown on the canvas, as a card with its
 * preview. A video plays muted while the pointer is over it; a card opens
 * the file full size in a tab, where it plays with sound and edits.
 */

const cardCls =
  "group flex h-[196px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] text-left transition-[border-color,transform] duration-quick hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] active:scale-[0.99] motion-reduce:transition-none";
const headCls =
  "flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_35%,var(--surface))] px-2.5";

export function useFileTiles(): FileTileData[] {
  const tiles = useFileTileStore((s) => s.tiles);
  return Object.values(tiles);
}

export function FileCardView({ tile }: { tile: FileTileData }) {
  const t = useT();
  const { info } = useFileInfo(tile.path);
  const kind = info?.ok ? info.kind : null;
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <button
      type="button"
      className={cardCls}
      onClick={() => useWorkdeskViewStore.getState().openFile(tile.path)}
      onMouseEnter={() => {
        const v = videoRef.current;
        if (v) {
          v.muted = true;
          void v.play().catch(() => {});
        }
      }}
      onMouseLeave={() => videoRef.current?.pause()}
    >
      <div className={headCls}>
        <FileKindIcon kind={kind} />
        <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">{fileName(tile.path)}</span>
        {info?.ok && (
          <span className="ml-auto shrink-0 pl-1 text-[11px] tabular-nums text-[var(--text-muted)]">{formatFileSize(info.size)}</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {info && !info.ok && (
          <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--text-muted)]">{t.file_tile_missing_title}</div>
        )}
        {info?.ok && kind === "image" && (
          <img src={versionedUrl(info)} alt="" className="h-full w-full object-cover" draggable={false} />
        )}
        {info?.ok && kind === "video" && (
          <video ref={videoRef} src={versionedUrl(info)} className="h-full w-full bg-black object-cover" preload="metadata" muted loop playsInline />
        )}
        {info?.ok && kind === "text" && <TextLines path={tile.path} modified={info.modified} />}
        {info?.ok && (kind === "pdf" || kind === "audio" || kind === "other") && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[12px] text-[var(--text-muted)]">
            <span className="scale-[1.6]"><FileKindIcon kind={kind} /></span>
            <span className="mt-1.5">{kind === "pdf" ? "PDF" : kind === "audio" ? t.file_tile_audio : t.file_tile_no_preview}</span>
          </div>
        )}
      </div>
    </button>
  );
}

/** The first lines of a text file, as the card's preview. */
function TextLines({ path, modified }: { path: string; modified: number }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.tacit.fs.readFile(path).then((result) => {
      if (cancelled) return;
      if ("content" in result && typeof result.content === "string") setLines(result.content.split("\n").slice(0, 12));
    });
    return () => {
      cancelled = true;
    };
  }, [path, modified]);
  return (
    <pre className="tc-mono h-full overflow-hidden whitespace-pre px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--text-secondary)]">
      {lines.join("\n")}
    </pre>
  );
}
