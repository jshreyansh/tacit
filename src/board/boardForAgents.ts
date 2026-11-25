/** The open workdesk's canvas, for the main process to answer an agent with. Only reads. */
import { useBoardStore } from "../stores/boardStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useFileTileStore } from "../stores/fileTileStore";
import { useProjectStore } from "../stores/projectStore";
import { columnOf } from "../../shared/task";
import { fileTileKindByName } from "../../shared/file-tiles";
import { agentNames, agentsIn } from "../tasks/agentNames";
import { placedTasks } from "../canvas/noteEnds";
import { BOARD_COLORS } from "./boardModel";
import { CARD_PREFIX, boardTargetLookup } from "./boardTargets";
import { partOf, pictureOf, readPart, type CanvasPart, type CanvasTile } from "./boardRead";
import { PICTURE_MAX, partSvg, type PicturePalette } from "./boardPicture";

/** Where every tile is, from the stores: the grid shows no canvas, but the canvas is still there. */
export function canvasTiles(): CanvasTile[] {
  const projects = useProjectStore.getState().projects;
  const names = agentNames(agentsIn(projects));
  const terminals = projects.flatMap((p) => p.worktrees.flatMap((w) => w.terminals)).filter((t) => !t.stashed);
  return [
    ...terminals.map((t): CanvasTile => ({ id: t.id, kind: "terminal", name: t.customTitle?.trim() || names.get(t.id) || t.title, x: t.x, y: t.y, w: t.width, h: t.height, about: t.type })),
    ...Object.values(useBrowserCardStore.getState().cards).map((c): CanvasTile => ({ id: `${CARD_PREFIX}${c.id}`, kind: "browser", name: c.title || c.url, url: c.url, x: c.x, y: c.y, w: c.w, h: c.h })),
    ...placedTasks().map(({ task, rect }): CanvasTile => ({ id: task.id, kind: "task", name: `T-${task.n} ${task.title}`.trim(), about: columnOf(task), ...rect })),
    ...Object.values(useFileTileStore.getState().tiles).map((f): CanvasTile => ({ id: f.id, kind: "file", name: f.path.split(/[\\/]/).pop() || f.path, path: f.path, x: f.x, y: f.y, w: f.w, h: f.h })),
  ];
}

function lookupOver(tiles: readonly CanvasTile[]) {
  const board = boardTargetLookup();
  const byId = new Map(tiles.map((t) => [t.id, t]));
  return (id: string) => {
    const t = byId.get(id);
    return t ? { rect: t } : board(id);
  };
}

function part(id: string | null): { part: CanvasPart; lookup: ReturnType<typeof lookupOver> } | null {
  const tiles = canvasTiles();
  const lookup = lookupOver(tiles);
  const found = partOf(id, useBoardStore.getState().elements, tiles, lookup);
  return found && { part: found, lookup };
}

/** The canvas in words, and which of its tiles are pictures, for main to open. Null when there's no such thing. */
export function readCanvas(me: string, id: string | null) {
  const found = part(id);
  if (!found) return null;
  const pictures = pictureOf(found.part, found.lookup).tiles.filter((t) => t.path && fileTileKindByName(t.path) === "image").map((t) => ({ id: t.id, path: t.path! }));
  return { canvas: readPart(found.part, useBoardStore.getState().elements, me, found.lookup), pictures };
}

function palette(): PicturePalette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, or: string) => css.getPropertyValue(name).trim() || or;
  return {
    bg: v("--bg", "#1a1918"),
    surface: v("--surface", "#222120"),
    border: v("--border", "#333231"),
    ink: v("--text-primary", "#e4e2df"),
    muted: v("--text-secondary", "#918e89"),
    paper: v("--board-sticky-paper", "#f3eee4"),
    stickyInk: v("--board-sticky-ink", "#1f1d1a"),
    colors: Object.fromEntries(BOARD_COLORS.map((c) => [c, v(`--board-${c}`, "#888888")])),
  };
}

/** A PNG of it, as a data URL. `pictures` are the picture files main opened, by tile id. Null when it's empty. */
export async function pictureOfCanvas(me: string, id: string | null, pictures: Record<string, string>): Promise<{ png: string; scale: number } | null> {
  const found = part(id);
  const drawn = found && partSvg(pictureOf(found.part, found.lookup), { palette: palette(), lookup: found.lookup, me, pictures });
  if (!drawn) return null;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(drawn.width, PICTURE_MAX);
  canvas.height = Math.min(drawn.height, PICTURE_MAX);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The canvas couldn't be drawn.");
  context.drawImage(image, 0, 0);
  return { png: canvas.toDataURL("image/png"), scale: drawn.scale };
}
