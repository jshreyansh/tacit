import { useCallback, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { TileResizer } from "./TileResizer";
import { TileFarLabel, TileMoveSurface, useZoomedOut } from "./TileFarChrome";
import { useT } from "../i18n/useT";
import { useCanvasStore } from "../stores/canvasStore";
import { useFileTileStore } from "../stores/fileTileStore";
import { useProjectStore } from "../stores/projectStore";
import { openFileInView } from "../actions/openSession";
import { flyToBounds } from "../utils/panToTerminal";
import { FILE_TILE_MIN, removeFileTile } from "../files/fileTileActions";
import { useFileInfo } from "../files/useFileInfo";
import {
  AudioPreview,
  CantPreview,
  HoverVideo,
  ImagePreview,
  MissingFile,
  PdfPreview,
  TextPreview,
  fileName,
  type TextFileState,
} from "../files/FilePreview";
import { formatFileSize } from "../../shared/file-tiles";
import type { FileFlowNode } from "./nodeProjection";

/**
 * A file from one of the workdesk's folders, on the canvas. Plain DOM like a
 * note, so it lives in React Flow's own node tree: the header drags, the
 * body is for looking and editing (nodrag, nowheel).
 */
export function FileTileNode({ data }: NodeProps<FileFlowNode>) {
  const t = useT();
  const far = useZoomedOut();
  const tile = useFileTileStore((s) => s.tiles[data.tileId]);
  const { info } = useFileInfo(data.path);
  const [text, setText] = useState<TextFileState | null>(null);
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  // The editor can only be typed in at 100%: Monaco places the caret as if unscaled.
  const atFullSize = useCanvasStore((s) => Math.abs(s.viewport.scale - 1) < 0.02);
  const folderRelative = useFolderRelativePath(data.path);

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { x: number; y: number; width: number; height: number }) => {
      useFileTileStore.getState().update(data.tileId, {
        x: Math.round(params.x),
        y: Math.round(params.y),
        w: Math.round(params.width),
        h: Math.round(params.height),
      });
    },
    [data.tileId],
  );

  if (!tile) return null;
  const kind = info?.ok ? info.kind : null;
  const missing = info !== null && !info.ok;

  // Clicking into text away from 100% brings the tile to 100%, centred, to type in.
  const zoomToEdit = (e: React.MouseEvent) => {
    if (kind !== "text" || atFullSize || tooLarge) return;
    e.preventDefault();
    e.stopPropagation();
    flyToBounds(tile.x, tile.y, tile.w, tile.h, { scale: 1 });
  };

  return (
    <>
    <TileResizer minWidth={FILE_TILE_MIN.w} minHeight={FILE_TILE_MIN.h} onResizeEnd={handleResizeEnd} />
    {far && (
      <>
        <TileFarLabel width={tile.w} icon={<FileKindIcon kind={kind} />} title={fileName(data.path)} onOpen={() => flyToBounds(tile.x, tile.y, tile.w, tile.h)} />
        <TileMoveSurface onOpen={() => flyToBounds(tile.x, tile.y, tile.w, tile.h)} />
      </>
    )}
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-lg border bg-[var(--surface)]"
      style={{ borderColor: "var(--border)", boxShadow: "var(--shadow-elev-1)" }}
      data-record-node={`file:${tile.id}`}
    >
      <div className="flex h-[30px] flex-none items-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_35%,var(--surface))] pl-2.5 pr-1" data-scene-box-select-block>
        <FileKindIcon kind={kind} />
        <span className="min-w-0 truncate text-[12px] font-medium text-[var(--text-primary)]" title={data.path}>
          {fileName(data.path)}
        </span>
        {text?.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" title={t.file_editor_dirty} />}
        <span className="tc-mono min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]" title={data.path}>
          {folderRelative}
        </span>
        {info?.ok && kind !== "text" && (
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{formatFileSize(info.size)}</span>
        )}
        <TileMenu path={data.path} tileId={tile.id} canSave={!!text?.dirty} onSave={() => void text?.save()} />
      </div>
      <div
        className="nodrag nowheel relative min-h-0 flex-1"
        data-scene-box-select-block
        onMouseDownCapture={zoomToEdit}
      >
        {info === null && <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">{t.loading}</div>}
        {missing && <MissingFile path={data.path} onRemove={() => removeFileTile(tile.id)} />}
        {info?.ok && kind === "image" && <ImagePreview info={info} path={data.path} />}
        {info?.ok && kind === "video" && <HoverVideo info={info} />}
        {info?.ok && kind === "audio" && <AudioPreview info={info} path={data.path} />}
        {info?.ok && kind === "pdf" && <PdfPreview info={info} path={data.path} />}
        {info?.ok && kind === "other" && <CantPreview path={data.path} info={info} />}
        {info?.ok && kind === "text" && tooLarge !== null && (
          <CantPreview path={data.path} info={info} reason={t.file_tile_too_large} />
        )}
        {info?.ok && kind === "text" && tooLarge === null && (
          <TextPreview
            path={data.path}
            info={info}
            editable={atFullSize}
            onState={setText}
            onTooLarge={(size) => setTooLarge(size ?? "")}
          />
        )}
        {info?.ok && kind === "text" && !atFullSize && tooLarge === null && (
          <span className="pointer-events-none absolute bottom-2 right-3 z-10 rounded-md bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] shadow-sm">
            {t.file_tile_click_to_edit}
          </span>
        )}
      </div>
    </div>
    </>
  );
}

/** Where the file sits in its folder: `lantern/src/hero.png`. */
function useFolderRelativePath(path: string): string {
  return useProjectStore((s) => {
    for (const project of s.projects) {
      for (const dir of [project.path, ...project.worktrees.map((w) => w.path)]) {
        if (path.startsWith(dir + "/")) {
          const rel = path.slice(dir.length + 1);
          const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
          return parent ? `${project.name}/${parent}` : project.name;
        }
      }
    }
    return path.slice(0, path.lastIndexOf("/"));
  });
}

export function FileKindIcon({ kind }: { kind: string | null }) {
  const common = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "var(--text-muted)", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "shrink-0" };
  if (kind === "image")
    return (
      <svg {...common}>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <circle cx="6" cy="6.5" r="1.2" />
        <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
      </svg>
    );
  if (kind === "video")
    return (
      <svg {...common}>
        <rect x="1.75" y="3.5" width="9" height="9" rx="1.5" />
        <path d="M10.75 7l3.5-2v6l-3.5-2" />
      </svg>
    );
  if (kind === "audio")
    return (
      <svg {...common}>
        <path d="M6 12V3.5l7-1.5v8.5" />
        <circle cx="4.5" cy="12" r="1.5" />
        <circle cx="11.5" cy="10.5" r="1.5" />
      </svg>
    );
  if (kind === "text")
    return (
      <svg {...common}>
        <path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z" />
      <path d="M9 1.75V5.25h3.5" />
    </svg>
  );
}

function TileMenu({ path, tileId, canSave, onSave }: { path: string; tileId: string; canSave: boolean; onSave: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const item = "tc-rail-btn flex w-full items-center px-2.5 py-1.5 text-left text-[13px] text-[var(--text-primary)]";
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="nodrag relative">
      <button
        type="button"
        className="tc-rail-btn inline-flex h-6 w-6 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-label={t.file_tile_more}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="tc-float absolute right-0 top-7 z-30 w-[210px] p-1.5" style={{ borderRadius: 10 }} onMouseDown={(e) => e.stopPropagation()}>
          {canSave && (
            <button type="button" role="menuitem" className={item} onClick={run(onSave)}>
              {t.file_editor_save}
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={run(() => openFileInView(path))}>
            {t.file_tile_open_full}
          </button>
          <button type="button" role="menuitem" className={item} onClick={run(() => void window.tacit.fileTiles.quickLook(path))}>
            {t.file_tile_quick_look}
          </button>
          <button type="button" role="menuitem" className={item} onClick={run(() => void window.tacit.fileTiles.openInApp(path))}>
            {t.file_tile_open_in_app}
          </button>
          <button type="button" role="menuitem" className={item} onClick={run(() => void window.tacit.fs.reveal(path))}>
            {t.ctx_reveal(window.tacit?.app.platform ?? "darwin")}
          </button>
          <div className="mx-1 my-1 h-px bg-[var(--border)]" />
          <button type="button" role="menuitem" className={item} onClick={run(() => removeFileTile(tileId))} title={t.file_tile_remove_hint}>
            {t.file_tile_remove}
          </button>
        </div>
      )}
    </div>
  );
}
