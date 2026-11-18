import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type * as MonacoNs from "monaco-editor";
import { formatFileSize, type FileTileInfo } from "../../shared/file-tiles";
import { useT } from "../i18n/useT";
import { useThemeStore } from "../stores/themeStore";
import { useNotificationStore } from "../stores/notificationStore";
import { markdownClassName, renderMarkdown } from "../utils/markdownClass";
import { MonacoEditor, guessLanguage } from "./monacoLazy";
import { versionedUrl } from "./useFileInfo";

/**
 * What a file looks like in a tile, on the canvas or in the grid: an image
 * fills it, a video plays muted while the pointer is over it, a PDF scrolls,
 * text and code are edited in place, and anything else says what it is and
 * opens in its app.
 */

const CHECKERBOARD = {
  backgroundImage:
    "linear-gradient(45deg, var(--border) 25%, transparent 25%), " +
    "linear-gradient(-45deg, var(--border) 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, var(--border) 75%), " +
    "linear-gradient(-45deg, transparent 75%, var(--border) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
} as const;

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function ImagePreview({ info, path }: { info: FileTileInfo; path: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden" style={CHECKERBOARD}>
      <img src={versionedUrl(info)} alt={fileName(path)} className="max-h-full max-w-full object-contain" draggable={false} />
    </div>
  );
}

/**
 * Plays muted while the pointer is over it, and stops when it leaves. The
 * play button plays it from the start with sound and the usual controls,
 * until it ends or is paused away.
 */
export function HoverVideo({ info }: { info: FileTileInfo }) {
  const t = useT();
  const ref = useRef<HTMLVideoElement>(null);
  const [withSound, setWithSound] = useState(false);
  const src = versionedUrl(info);

  const playWithSound = () => {
    const video = ref.current;
    if (!video) return;
    video.currentTime = 0;
    video.muted = false;
    setWithSound(true);
    void video.play().catch(() => {});
  };

  return (
    <div
      className="relative h-full w-full bg-black"
      onMouseEnter={() => {
        const video = ref.current;
        if (!video || withSound) return;
        video.muted = true;
        void video.play().catch(() => {});
      }}
      onMouseLeave={() => {
        if (!withSound) ref.current?.pause();
      }}
    >
      <video
        ref={ref}
        src={src}
        className="h-full w-full object-contain"
        preload="metadata"
        playsInline
        loop={!withSound}
        muted
        controls={withSound}
        onEnded={() => {
          setWithSound(false);
          if (ref.current) ref.current.muted = true;
        }}
      />
      {!withSound && (
        <button
          type="button"
          className="absolute bottom-2.5 left-2.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.6)] px-3 text-[12px] font-medium text-white backdrop-blur-sm hover:bg-[rgba(0,0,0,0.75)]"
          onClick={playWithSound}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={t.file_tile_play_sound}
          title={t.file_tile_play_sound}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <path d="M3 1.8v8.4L10 6z" />
          </svg>
          {t.file_tile_play}
        </button>
      )}
    </div>
  );
}

export function AudioPreview({ info, path }: { info: FileTileInfo; path: string }) {
  return (
    <div className="flex h-full w-full flex-col justify-center gap-3 px-4">
      <div className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 12V3.5l7-1.5v8.5" />
          <circle cx="4.5" cy="12" r="1.5" />
          <circle cx="11.5" cy="10.5" r="1.5" />
        </svg>
        <span className="truncate">{fileName(path)}</span>
      </div>
      <audio src={versionedUrl(info)} controls preload="metadata" className="w-full" />
    </div>
  );
}

export function PdfPreview({ info, path }: { info: FileTileInfo; path: string }) {
  return <iframe src={versionedUrl(info)} title={fileName(path)} className="h-full w-full border-0 bg-white" />;
}

/** A file there's no preview for: what it is, and where it opens. */
export function CantPreview({ path, info, reason }: { path: string; info: FileTileInfo | null; reason?: string }) {
  const t = useT();
  const ext = fileName(path).includes(".") ? fileName(path).split(".").pop()!.toUpperCase() : "";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center">
      <span className="flex h-11 w-9 items-end justify-center rounded-[5px] border border-[var(--border-hover)] pb-1 text-[9px] font-semibold tracking-wide text-[var(--text-muted)]">
        {ext.slice(0, 4)}
      </span>
      <span className="max-w-full truncate text-[13px] text-[var(--text-primary)]">{fileName(path)}</span>
      <span className="text-[11px] text-[var(--text-muted)]">
        {reason ?? t.file_tile_no_preview}
        {info?.ok ? ` · ${formatFileSize(info.size)}` : ""}
      </span>
      <span className="mt-1 flex gap-1.5">
        <FileActionButton label={t.file_tile_quick_look} onClick={() => void window.tacit.fileTiles.quickLook(path)} />
        <FileActionButton label={t.file_tile_open_in_app} onClick={() => void window.tacit.fileTiles.openInApp(path)} />
      </span>
    </div>
  );
}

/** The file isn't where the tile says any more. */
export function MissingFile({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center">
      <span className="text-[13px] text-[var(--text-primary)]">{t.file_tile_missing_title}</span>
      <span className="max-w-full truncate text-[11px] text-[var(--text-muted)]" title={path}>
        {t.file_tile_missing_body(fileName(path))}
      </span>
      {onRemove && (
        <span className="mt-1">
          <FileActionButton label={t.file_tile_remove} onClick={onRemove} />
        </span>
      )}
    </div>
  );
}

function FileActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="tc-rail-btn h-7 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {label}
    </button>
  );
}

export interface TextFileState {
  dirty: boolean;
  save: () => Promise<void>;
}

/**
 * Text and code, edited in place with the viewer's editor; markdown shows
 * rendered, with Edit to change it. ⌘S saves. A change on disk is taken in
 * unless there are edits not saved yet.
 */
export function TextPreview({
  path,
  info,
  editable,
  onState,
  onTooLarge,
}: {
  path: string;
  info: FileTileInfo;
  /** False keeps it read-only, as when the canvas isn't at a size to type in. */
  editable: boolean;
  onState?: (state: TextFileState) => void;
  onTooLarge?: (size: string | undefined) => void;
}) {
  const t = useT();
  const theme = useThemeStore((s) => s.theme);
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  const [editing, setEditing] = useState(!markdown);
  const dirty = content !== null && content !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const contentRef = useRef(content);
  contentRef.current = content;
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const modified = info.ok ? info.modified : 0;

  // Read when it opens and whenever it changes on disk, unless edits are waiting.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    window.tacit.fs
      .readFile(path)
      .then((result) => {
        if (cancelled) return;
        if ("content" in result && typeof result.content === "string") {
          setContent(result.content);
          setSaved(result.content);
          setError(null);
        } else if ("error" in result && result.error === "too-large") {
          onTooLarge?.(result.size);
        } else {
          setError("error" in result ? result.error : "read failed");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, modified]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const next = contentRef.current;
    if (next === null || !dirtyRef.current) return;
    try {
      await window.tacit.fs.writeFile(path, next);
      setSaved(next);
    } catch (err) {
      useNotificationStore.getState().notify("error", t.file_tile_save_failed(err instanceof Error ? err.message : String(err)));
    }
  }, [path, t]);

  useEffect(() => {
    onState?.({ dirty, save });
  }, [dirty, save, onState]);

  if (error) return <div className="flex h-full items-center justify-center px-4 text-[12px] text-[var(--red)]">{error}</div>;
  if (content === null) return <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">{t.loading}</div>;

  if (markdown && !editing) {
    return (
      <div className="relative h-full w-full">
        <div
          className={`${markdownClassName} h-full overflow-y-auto px-4 py-3`}
          // Sanitized by renderMarkdown.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
        {editable && (
          <button
            type="button"
            className="tc-rail-btn absolute right-2 top-2 h-6 border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => setEditing(true)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {t.file_tile_edit}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">{t.loading}</div>}>
        <MonacoEditor
          path={`tile:${path}`}
          value={content}
          language={guessLanguage(path)}
          theme={theme === "dark" ? "tacit-dark" : "tacit-light"}
          onChange={(v) => setContent(v ?? "")}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
          }}
          options={{
            readOnly: !editable,
            fontFamily: '"Geist Mono", monospace',
            fontSize: 12,
            lineHeight: 19,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderLineHighlight: "gutter",
            automaticLayout: true,
            tabSize: 2,
            wordWrap: markdown ? "on" : "off",
            lineNumbersMinChars: 3,
            folding: false,
            padding: { top: 8, bottom: 8 },
            scrollbar: { alwaysConsumeMouseWheel: false },
          }}
        />
      </Suspense>
      {markdown && (
        <button
          type="button"
          className="tc-rail-btn absolute right-3 top-2 z-10 h-6 border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => setEditing(false)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {t.file_tile_preview}
        </button>
      )}
    </div>
  );
}
