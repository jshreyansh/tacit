import { MonacoEditor, guessLanguage } from "../files/monacoLazy";
import { AudioPreview, CantPreview, HoverVideo, PdfPreview } from "../files/FilePreview";
import { showFileOnCanvasFromAnywhere } from "../files/fileTileActions";
import { fileTileKindByName, type FileTileInfo } from "../../shared/file-tiles";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CHROME_HEIGHT, CHROME_TOP } from "../canvas/floatingChrome";
import {
  useCanvasStore,
} from "../stores/canvasStore";
import {
  getRightPanelInset,
} from "../canvas/viewportBounds";
import { usePinStore } from "../stores/pinStore";
import { useLeftChromeInset, useLeftChromeShift } from "../stores/chromeLayout";
import {
  PANEL_TRANSITION_DURATION_MS,
  PANEL_TRANSITION_EASING_CSS,
} from "../utils/panelAnimation";
import { useThemeStore } from "../stores/themeStore";
import { useT } from "../i18n/useT";
import { confirmAsync } from "./ui/confirmAsync";
import type * as MonacoNs from "monaco-editor";

/*
 * Full-canvas file editor drawer.
 *
 * Slides in from the right over the right panel + canvas. Two levels:
 *   level-1 (default): 60% of viewport width — right panel fully
 *                      covered, canvas still half-visible so you can
 *                      see terminals running while reading code.
 *   level-2 (expanded): full area minus the left panel — immersive.
 *
 * The left panel is deliberately NOT covered: project navigation stays
 * reachable so switching files doesn't require closing the drawer.
 */
interface FileReadSuccess {
  content: string;
  type?: "text" | "markdown" | "image" | "binary" | string;
}
interface FileReadError {
  error: string;
  size?: string;
}
type FileReadResult = FileReadSuccess | FileReadError;

function isReadSuccess(r: FileReadResult): r is FileReadSuccess {
  return "content" in r;
}

/**
 * `embedded`: the editor fills a tab of the workdesk view instead of
 * floating over the canvas, for the file the tab holds; closing goes
 * through the tab.
 */
export function FileEditorDrawer({ embedded }: { embedded?: { path: string; onClose: () => void } } = {}) {
  const t = useT();
  const drawerPath = useCanvasStore((s) => s.fileEditorPath);
  const path = embedded ? embedded.path : drawerPath;
  const expanded = useCanvasStore((s) => s.fileEditorExpanded);
  const closeDrawer = useCanvasStore((s) => s.closeFileEditor);
  const close = embedded ? embedded.onClose : closeDrawer;
  const toggleExpanded = useCanvasStore((s) => s.toggleFileEditorExpanded);
  const rightPanelCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const rightPanelWidth = useCanvasStore((s) => s.rightPanelWidth);
  const taskDrawerOpen = usePinStore((s) => s.openProjectPath !== null);
  const chromeLeft = useLeftChromeInset();
  const leftShift = useLeftChromeShift();
  const theme = useThemeStore((s) => s.theme);

  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // File type decides what we render in the body: text → Monaco
  // (editable + savable), image → <img>, binary → placeholder.
  // The IPC returns the label alongside the content.
  const [fileKind, setFileKind] = useState<"text" | "image" | "binary">("text");
  // Video, audio and PDF stream from main, as a file tile's do; and a file
  // with no preview, inside the workdesk's folders, says what it is.
  const [media, setMedia] = useState<FileTileInfo | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);

  const dirty = content !== originalContent;
  const open = path !== null;

  // Only animate width/right during the brief window after the user
  // toggles maximize/restore OR opens/closes the task drawer (which
  // narrows the canvas-gap by 320 px). Continuous geometry changes
  // (window resize, side-panel drag) would otherwise queue a 180ms
  // transition every frame and make the drawer chase the pointer.
  const [animateLayout, setAnimateLayout] = useState(false);
  const prevExpandedRef = useRef(expanded);
  const prevTaskDrawerOpenRef = useRef(taskDrawerOpen);
  useEffect(() => {
    if (
      prevExpandedRef.current === expanded &&
      prevTaskDrawerOpenRef.current === taskDrawerOpen
    ) {
      return;
    }
    prevExpandedRef.current = expanded;
    prevTaskDrawerOpenRef.current = taskDrawerOpen;
    setAnimateLayout(true);
    const timer = setTimeout(
      () => setAnimateLayout(false),
      PANEL_TRANSITION_DURATION_MS + 40,
    );
    return () => clearTimeout(timer);
  }, [expanded, taskDrawerOpen]);

  // Load file when path changes.
  useEffect(() => {
    if (!path || !window.tacit) {
      setContent("");
      setOriginalContent("");
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setMedia(null);
    const byName = fileTileKindByName(path);
    if (byName === "video" || byName === "audio" || byName === "pdf") {
      window.tacit.fileTiles
        .inspect(path)
        .then((info) => {
          if (cancelled) return;
          if (info.ok) setMedia(info);
          else setLoadError(info.error === "missing" ? t.file_tile_missing_title : t.file_tile_cant_show(path.split("/").pop() ?? path));
          setContent("");
          setOriginalContent("");
          setFileKind("binary");
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    window.tacit.fs
      .readFile(path)
      .then((result: FileReadResult) => {
        if (cancelled) return;
        if (isReadSuccess(result)) {
          // The backend may also return a success-shaped result with
          // no `content` for binary files (e.g. `{ type: "binary" }`);
          // guard that so we don't crash the reducer with undefined.
          const payload = result.content ?? "";
          setContent(payload);
          setOriginalContent(payload);
          if (result.type === "image") setFileKind("image");
          else if (result.type === "binary") {
            setFileKind("binary");
            void window.tacit.fileTiles.inspect(path).then((info) => {
              if (!cancelled && info.ok) setMedia(info);
            });
          } else setFileKind("text");
        } else {
          setContent("");
          setOriginalContent("");
          setFileKind("text");
          // "too-large" carries a size hint — fold it into the user-
          // visible message so the UI can say "File too large (12 MB)".
          const sizeHint =
            result.error === "too-large" && result.size
              ? ` (${result.size})`
              : "";
          setLoadError((result.error || "read failed") + sizeHint);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setContent("");
        setOriginalContent("");
        setFileKind("text");
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (!path || !dirty || saving) return;
    setSaving(true);
    try {
      await window.tacit.fs.writeFile(path, content);
      setOriginalContent(content);
    } finally {
      setSaving(false);
    }
  }, [path, content, dirty, saving]);

  const handleClose = useCallback(async () => {
    if (dirty) {
      const ok = await confirmAsync({
        title: t.file_editor_discard_confirm,
        body: t.file_editor_discard_body,
        confirmLabel: t.file_editor_discard_action,
        confirmTone: "danger",
        focusCancel: true,
      });
      if (!ok) return;
    }
    close();
  }, [dirty, close, t]);

  // Cmd/Ctrl+S to save, Esc to close — bound at window level while
  // the drawer is open. Capture phase so Monaco's internal shortcut
  // binding doesn't eat Cmd+S first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
      } else if (e.key === "Escape" && !embedded) {
        // Don't swallow Esc if Monaco has a dialog open (find/replace
        // widget). Cheap heuristic: only close when the focused
        // element is the editor itself or outside.
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, handleSave, handleClose, embedded]);

  if (!open || !path) return null;

  const leftInset = chromeLeft;
  const rightInset = getRightPanelInset(rightPanelCollapsed, rightPanelWidth);
  // The drawer hinges on whatever is open on the left (the docked chat,
  // the Files / Diff / Git / Memory panel, the Hub), so it follows that
  // edge as any of them opens, closes or is dragged wider.
  //
  // Level-1 width: 55% of viewport width, but never wider than the
  // actual canvas gap (leftInset + rightInset subtracted). On tight
  // layouts this naturally shrinks.
  // Level-2 width: fills the entire gap between the two panels.
  const gapMax = `calc(100vw - ${leftInset}px - ${rightInset}px)`;
  const widthStyle = expanded ? gapMax : `min(55vw, ${gapMax})`;

  const fileName = path.split("/").pop() ?? path;
  const relPath = path;

  return (
    <div
      className={embedded ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "tc-enter-fade-up tc-float fixed z-50 flex flex-col overflow-hidden"}
      style={
        embedded
          ? undefined
          : {
              top: CHROME_TOP,
              left: leftInset,
              height: CHROME_HEIGHT,
              width: widthStyle,
              // Its left edge follows the chrome beside it; its width animates on maximize.
              transition: animateLayout || leftShift
                ? `width ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}, left ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}`
                : undefined,
            }
      }
      role="dialog"
      aria-modal="false"
      aria-label={fileName}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span
            className="tc-ui tc-mono text-[var(--text-primary)] truncate"
            title={relPath}
          >
            {fileName}
          </span>
          {dirty && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0"
              title={t.file_editor_dirty ?? "Unsaved changes"}
            />
          )}
          <span className="tc-caption tc-mono truncate" title={relPath}>
            {relPath}
          </span>
        </div>

        <button
          className="tc-meta tc-mono flex items-center gap-1 px-2 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors disabled:opacity-50"
          onClick={() => void handleSave()}
          // Save is only meaningful for text — image / binary modes
          // have no editable buffer, so we hide the button outright
          // instead of leaving it as a disabled stub that suggests
          // "save would do something if only…".
          disabled={!dirty || saving || fileKind !== "text"}
          style={{
            display: fileKind === "text" ? undefined : "none",
          }}
          title={t.file_editor_save ?? "Save (⌘S)"}
        >
          {saving
            ? (t.file_editor_saving ?? "saving…")
            : (t.file_editor_save ?? "Save")}
        </button>

        <button
          className="tc-meta flex items-center gap-1 px-2 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          onClick={() => showFileOnCanvasFromAnywhere(path)}
          title={t.file_tile_show_on_canvas_hint}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <path d="M8 5.5v5M5.5 8h5" />
          </svg>
          {t.file_tile_canvas}
        </button>

        <button
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          style={{ display: embedded ? "none" : undefined }}
          onClick={toggleExpanded}
          title={
            expanded
              ? (t.file_editor_restore ?? "Restore")
              : (t.file_editor_maximize ?? "Maximize")
          }
        >
          {expanded ? (
            // "Restore" glyph — two offset rectangles
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect
                x="3.5"
                y="1.5"
                width="6"
                height="6"
                rx="0.5"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <rect
                x="1.5"
                y="4.5"
                width="6"
                height="6"
                rx="0.5"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="var(--surface)"
              />
            </svg>
          ) : (
            // "Maximize" glyph — single rectangle
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect
                x="1.5"
                y="1.5"
                width="9"
                height="9"
                rx="0.5"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          )}
        </button>

        <button
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          onClick={handleClose}
          title={t.file_editor_close ?? "Close (Esc)"}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div
            className="tc-meta absolute inset-0 flex items-center justify-center"
            role="status"
            aria-live="polite"
          >
            {t.loading}
          </div>
        )}
        {loadError && !loading && (
          <div className="tc-meta absolute inset-0 flex items-center justify-center text-[var(--red)]">
            {loadError}
          </div>
        )}
        {!loadError && !loading && fileKind === "image" && (
          // Image preview — centred, bounded to the drawer's content
          // area so huge screenshots don't blow out the layout. The
          // checkerboard backdrop makes PNG / WebP transparency
          // visible. Zoom level is a fixed fit-to-box; no pan/zoom
          // yet (keep the drawer simple — Monaco is the star).
          <div
            className="absolute inset-0 flex items-center justify-center overflow-auto"
            style={{
              backgroundImage:
                "linear-gradient(45deg, var(--border) 25%, transparent 25%), " +
                "linear-gradient(-45deg, var(--border) 25%, transparent 25%), " +
                "linear-gradient(45deg, transparent 75%, var(--border) 75%), " +
                "linear-gradient(-45deg, transparent 75%, var(--border) 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
            }}
          >
            <img
              src={content}
              alt={path.split("/").pop() ?? "image"}
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: "auto" }}
              draggable={false}
            />
          </div>
        )}
        {!loadError && !loading && media?.ok && media.kind === "video" && (
          <div className="absolute inset-0"><HoverVideo info={media} /></div>
        )}
        {!loadError && !loading && media?.ok && media.kind === "audio" && (
          <div className="absolute inset-0 mx-auto max-w-[560px]"><AudioPreview info={media} path={path} /></div>
        )}
        {!loadError && !loading && media?.ok && media.kind === "pdf" && (
          <div className="absolute inset-0"><PdfPreview info={media} path={path} /></div>
        )}
        {!loadError && !loading && fileKind === "binary" && media?.ok && media.kind === "other" && (
          <div className="absolute inset-0"><CantPreview path={path} info={media} /></div>
        )}
        {!loadError && !loading && fileKind === "binary" && !media && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <div className="tc-ui tc-mono text-[var(--text-muted)]">
              {t.file_editor_binary_title ?? "Binary file"}
            </div>
            <div className="tc-caption max-w-sm leading-relaxed">
              {t.file_editor_binary_hint ??
                "This file isn't text or a supported image format, so the editor can't render it."}
            </div>
          </div>
        )}
        {!loadError && !loading && fileKind === "text" && (
          <Suspense
            fallback={
              <div className="tc-meta absolute inset-0 flex items-center justify-center">
                {t.loading}
              </div>
            }
          >
            <MonacoEditor
              path={path}
              value={content}
              language={guessLanguage(path)}
              theme={theme === "dark" ? "tacit-dark" : "tacit-light"}
              onChange={(v) => setContent(v ?? "")}
              onMount={(editor, monaco) => {
                editorRef.current = editor;
                // Re-register Cmd+S inside Monaco so the editor's
                // default "show keybindings" shortcut (Cmd+K-chain)
                // doesn't intercept save-style chords.
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                  () => void handleSave(),
                );
              }}
              options={{
                fontFamily: '"Geist Mono", monospace',
                fontSize: 13,
                lineHeight: 20,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: "gutter",
                automaticLayout: true,
                tabSize: 2,
                wordWrap: "off",
                smoothScrolling: true,
                cursorSmoothCaretAnimation: "on",
                padding: { top: 12, bottom: 12 },
                bracketPairColorization: { enabled: true },
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
