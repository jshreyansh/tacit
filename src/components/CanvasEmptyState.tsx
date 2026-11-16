import { useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { addProjectFromDirectoryPath, promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { useT } from "../i18n/useT";
import { formatShortcut, useShortcutStore } from "../stores/shortcutStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { Kbd } from "./ui/parts";
import { recentFolders } from "./canvasEmptyModel";

const platform = window.tacit?.app.platform ?? "darwin";
const isMac = platform === "darwin";

const STAGGER_STYLE: CSSProperties = {
  ["--tc-stagger-step" as string]: "60ms",
};

/** A folder's last path segment, for its chip. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface CanvasEmptyStateProps {
  isDragOver?: boolean;
}

/**
 * An empty workdesk: its name, and everything needed to start around one
 * spot. Add a folder, pick a recent one, or drop one in. Once a folder is
 * on it, the Manager panel asks who runs it.
 */
export function CanvasEmptyState({ isDragOver = false }: CanvasEmptyStateProps) {
  const t = useT();
  const shortcut = useShortcutStore((s) => s.shortcuts.addProject);
  const shortcutLabel = formatShortcut(shortcut, isMac);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const name = canvases.find((c) => c.id === activeId)?.name ?? "";
  const recent = useMemo(() => recentFolders(canvases, activeId), [canvases, activeId]);

  const handleOpen = useCallback(() => {
    void promptAndAddProjectToScene(t);
  }, [t]);

  return (
    <div className="absolute inset-0 flex justify-center pointer-events-none select-none" style={{ paddingTop: "26vh" }}>
      <div className="tc-stagger pointer-events-auto" style={{ ...STAGGER_STYLE, width: "min(420px, 82vw)" }}>
        <div className="tc-enter-fade-up tc-eyebrow" style={{ marginBottom: 8 }}>
          {t.canvas_empty_eyebrow}
        </div>
        <div className="tc-enter-fade-up tc-display" style={{ marginBottom: 20 }}>
          {name || t.canvas_empty_line_lead}
        </div>
        <div
          className="tc-enter-fade-up rounded-xl border p-4"
          style={{
            borderColor: isDragOver ? "var(--accent)" : "var(--border)",
            background: "color-mix(in srgb, var(--surface) 70%, transparent)",
          }}
        >
          <div className="text-[13px] text-[var(--text-primary)]">{t.canvas_empty_line_call}</div>
          <div className="mt-1 text-[12px] leading-snug text-[var(--text-secondary)]">{t.canvas_empty_next}</div>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpen}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3 text-[12px] font-medium text-[var(--bg)] hover:opacity-90"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              {t.canvas_empty_action}
            </button>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <span className="tc-canvas-empty-drag-hint" data-dragover={isDragOver ? "true" : "false"}>
                {t.canvas_empty_drag_hint}
              </span>
              <Kbd>{shortcutLabel}</Kbd>
            </span>
          </div>
        </div>
        {recent.length > 0 && (
          <div className="tc-enter-fade-up mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] text-[var(--text-secondary)]">{t.canvas_empty_recent}</span>
            {recent.map((path) => (
              <button
                key={path}
                type="button"
                title={path}
                onClick={() => void addProjectFromDirectoryPath(path, t)}
                className="inline-flex h-6 items-center rounded-full border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-primary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
              >
                {folderName(path)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
