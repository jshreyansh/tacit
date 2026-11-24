import type { FileTileKind } from "../../shared/file-tiles";
import { getVisibleCanvasWorldRect } from "../canvas/viewportBounds";
import { getTranslations } from "../i18n/useT";
import { useCanvasStore } from "../stores/canvasStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { placedTasks } from "../canvas/noteEnds";
import { useProjectStore } from "../stores/projectStore";
import { tileDropped, tileGone } from "../board/boardMembership";
import { placeRow, type Rect } from "./fileTilePlacement";
import { useFileTileStore } from "../stores/fileTileStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { flyToBounds } from "../utils/panToTerminal";

/** A new tile's size, by what it shows. */
const SIZE: Record<FileTileKind, { w: number; h: number }> = {
  image: { w: 420, h: 320 },
  video: { w: 480, h: 320 },
  audio: { w: 360, h: 150 },
  pdf: { w: 440, h: 560 },
  text: { w: 520, h: 420 },
  other: { w: 300, h: 210 },
};

export const FILE_TILE_MIN = { w: 220, h: 130 };

/**
 * Show files on the canvas: each one checked by main (a file inside one of
 * this workdesk's folders), placed at `at` (canvas coordinates, from a
 * drop) or in the middle of what's on screen, and flown to. A file already
 * on the canvas is flown to instead of added twice. Returns how many were
 * shown.
 */
export async function showFilesOnCanvas(paths: readonly string[], at?: { x: number; y: number }): Promise<number> {
  const t = getTranslations();
  const store = useFileTileStore.getState();
  let last: Rect | null = null;
  let shown = 0;
  const fresh: { path: string; size: { w: number; h: number } }[] = [];
  for (const path of paths) {
    const existing = Object.values(useFileTileStore.getState().tiles).find((tile) => tile.path === path);
    if (existing) {
      last = existing;
      shown += 1;
      continue;
    }
    // This workdesk's folders: main checks every workdesk's, as saved.
    if (!insideThisWorkdesk(path)) {
      useNotificationStore.getState().notify("warn", t.file_tile_outside(path.split("/").pop() ?? path));
      continue;
    }
    const info = await window.tacit.fileTiles.inspect(path).catch(() => null);
    if (!info?.ok) {
      const name = path.split("/").pop() ?? path;
      useNotificationStore
        .getState()
        .notify("warn", info && info.error === "outside-folders" ? t.file_tile_outside(name) : t.file_tile_cant_show(name));
      continue;
    }
    fresh.push({ path, size: SIZE[info.kind] });
  }
  if (fresh.length > 0) {
    // Side by side, from the drop point or the middle of the view, clear of
    // everything already on the canvas.
    const rowWidth = fresh.reduce((sum, f) => sum + f.size.w, 0);
    const rowHeight = Math.max(...fresh.map((f) => f.size.h));
    const start = at ?? centerOfView({ w: rowWidth, h: rowHeight });
    const rects = placeRow(fresh.map((f) => f.size), start, takenRects());
    fresh.forEach((f, i) => tileDropped(store.add(f.path, rects[i]), rects[i]));
    last = rects[rects.length - 1];
    shown += fresh.length;
  }
  // Placed under the pointer, it's already in view.
  if (last && !at) flyToBounds(last.x, last.y, last.w, last.h, { preserveScale: true });
  return shown;
}

/** Whether a path is inside one of this workdesk's folders or their worktrees. */
export function insideThisWorkdesk(path: string): boolean {
  return useProjectStore
    .getState()
    .projects.some((project) => [project.path, ...project.worktrees.map((w) => w.path)].some((dir) => path.startsWith(dir.replace(/\/$/, "") + "/")));
}

/** Everything on this workdesk's canvas a new tile shouldn't cover. */
function takenRects(): Rect[] {
  const rects: Rect[] = [];
  const { projects } = useProjectStore.getState();
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (!terminal.stashed) rects.push({ x: terminal.x, y: terminal.y, w: terminal.width, h: terminal.height });
      }
    }
  }
  for (const card of Object.values(useBrowserCardStore.getState().cards)) rects.push({ x: card.x, y: card.y, w: card.w, h: card.h });
  for (const { rect } of placedTasks()) rects.push(rect);
  for (const tile of Object.values(useFileTileStore.getState().tiles)) rects.push(tile);
  return rects;
}

/** From the viewer, a panel or the grid: shows it, switching to the canvas if need be. */
export function showFileOnCanvasFromAnywhere(path: string): void {
  const view = useWorkdeskViewStore.getState();
  if (view.mode !== "canvas") view.setMode("canvas");
  useCanvasStore.getState().closeFileEditor();
  void showFilesOnCanvas([path]);
}

export function removeFileTile(id: string): void {
  useFileTileStore.getState().remove(id);
  tileGone(id);
}

function centerOfView(size: { w: number; h: number }): { x: number; y: number } {
  const { viewport, rightPanelCollapsed, rightPanelWidth } = useCanvasStore.getState();
  const visible = getVisibleCanvasWorldRect(viewport, rightPanelCollapsed, rightPanelWidth);
  return { x: visible.x + visible.w / 2 - size.w / 2, y: visible.y + visible.h / 2 - size.h / 2 };
}
