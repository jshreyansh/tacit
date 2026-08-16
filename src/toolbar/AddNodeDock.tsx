import { useCanvasStore } from "../stores/canvasStore";
import { usePinStore } from "../stores/pinStore";
import { useProjectStore } from "../stores/projectStore";
import { getVisibleCanvasWorldRect } from "../canvas/viewportBounds";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { addBrowserCardToScene } from "../actions/sceneCardActions";
import { createNoteInScene } from "../actions/scenePinActions";
import { PILL_GLASS, useComposerBottomOffset } from "./BottomToolbar";
import { useT } from "../i18n/useT";
import type { TerminalType } from "../types";
import shellIcon from "../assets/dock-icons/terminal-shell.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";
import browserIcon from "../assets/dock-icons/browser.png";
import noteIcon from "../assets/dock-icons/note.png";

const buttonCls =
  "inline-flex h-11 w-11 items-center justify-center rounded-xl transition-[background-color,transform] duration-quick hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] active:scale-[0.94] focus-visible:outline-none motion-reduce:transition-none";

/** Total rendered height of the dock pill (button + vertical padding) —
 * exported so WorkspaceManagerPill.tsx can position itself a fixed gap
 * above it without hard-coding a duplicate magic number. */
export const ADD_NODE_DOCK_HEIGHT_PX = 56;

/** Center of the currently visible canvas area, in flow coordinates — same
 * viewport/panel bookkeeping createTerminalInScene already uses for its own
 * auto-placement, just reduced to a single point rather than full
 * collision-aware placement (each create action still resolves its own
 * final spot from there). */
function visibleCenterPoint(): { x: number; y: number } {
  const canvasState = useCanvasStore.getState();
  const rect = getVisibleCanvasWorldRect(
    canvasState.viewport,
    canvasState.rightPanelCollapsed,
    canvasState.leftPanelCollapsed,
    canvasState.leftPanelWidth,
    canvasState.rightPanelWidth,
    usePinStore.getState().openProjectPath !== null,
  );
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function addTerminal(type: TerminalType) {
  const { focusedProjectId, focusedWorktreeId, projects } =
    useProjectStore.getState();
  let projectId = focusedProjectId;
  let worktreeId = focusedWorktreeId;
  if (!projectId || !worktreeId) {
    const fallbackProject = projects[0];
    const fallbackWorktree = fallbackProject?.worktrees[0];
    if (!fallbackProject || !fallbackWorktree) return;
    projectId = fallbackProject.id;
    worktreeId = fallbackWorktree.id;
  }
  createTerminalInScene({
    projectId,
    worktreeId,
    type,
    position: visibleCenterPoint(),
  });
}

function addBrowser() {
  addBrowserCardToScene(visibleCenterPoint());
}

function addNote() {
  const { focusedProjectId, projects } = useProjectStore.getState();
  const project =
    projects.find((p) => p.id === focusedProjectId) ?? projects[0];
  if (!project) return;
  void createNoteInScene(project.path, visibleCenterPoint());
}

// Most of these icons (macOS-style app icons, the Claude/Codex logos) have
// their own transparent padding baked into the source image, so they read
// at a consistent visual size even though every <img> renders at the same
// box size. Gemini's sparkle fills its canvas edge-to-edge with no
// padding, so at the same box size it reads noticeably bigger than its
// neighbors — this per-entry size override compensates for that, rather
// than shrinking every icon to accommodate the one outlier.
const ENTRIES = [
  { id: "shell", label: "Shell", icon: shellIcon, create: () => addTerminal("shell") },
  { id: "claude", label: "Claude", icon: claudeIcon, create: () => addTerminal("claude") },
  { id: "codex", label: "Codex", icon: codexIcon, create: () => addTerminal("codex") },
  {
    id: "gemini",
    label: "Gemini",
    icon: geminiIcon,
    create: () => addTerminal("gemini"),
    iconSizeCls: "h-6 w-6",
  },
] as const;

/**
 * October-style "add a tool to the canvas" dock — a sibling pill to
 * BottomToolbar (not merged into it: two independent pills are lower risk
 * than reworking that file's existing tested layout), bottom-center,
 * sharing BottomToolbar's glass pill styling/positioning. Entries are a
 * plain data array so a future kind (Files/Video/Slides, out of scope for
 * now) is a one-line addition, not a redesign.
 */
export function AddNodeDock() {
  const t = useT();
  const bottomOffset = useComposerBottomOffset();

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[95] pointer-events-none"
      style={{ bottom: bottomOffset }}
    >
      <div className={`pointer-events-auto inline-flex items-center gap-1 rounded-[22px] px-2 py-1.5 ${PILL_GLASS}`}>
        {ENTRIES.map((entry) => (
          <button
            key={entry.id}
            className={buttonCls}
            onClick={entry.create}
            title={entry.label}
            aria-label={entry.label}
          >
            <img
              src={entry.icon}
              alt=""
              className={`${"iconSizeCls" in entry ? entry.iconSizeCls : "h-8 w-8"} rounded-md object-cover`}
            />
          </button>
        ))}

        <div
          aria-hidden="true"
          className="h-6 w-px mx-0.5 bg-[color-mix(in_srgb,var(--border)_60%,transparent)]"
        />

        <button
          className={buttonCls}
          onClick={addBrowser}
          title={t.dock_add_browser}
          aria-label={t.dock_add_browser}
        >
          <img src={browserIcon} alt="" className="h-8 w-8 rounded-md object-cover" />
        </button>
        <button
          className={buttonCls}
          onClick={addNote}
          title={t.dock_add_note}
          aria-label={t.dock_add_note}
        >
          <img src={noteIcon} alt="" className="h-8 w-8 rounded-md object-cover" />
        </button>
      </div>
    </div>
  );
}
