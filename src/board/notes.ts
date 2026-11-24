/**
 * Notes are the board's stickies (docs/architecture/task-board.md, "Notes"): a
 * sticky on the canvas, a page when opened. The first line is its name. Any
 * agent wired to one can read and add to it.
 */
import { useBoardStore, boardId } from "../stores/boardStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useSelectionStore } from "../stores/selectionStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import type { BoardAuthor } from "../types/board";
import { flyToBounds } from "../utils/panToTerminal";
import { STICKY_SIZE, freeSpot, type Point } from "./boardModel";
import { tileRects } from "./boardTargets";
import { inSection } from "./boardActions";
import { NOTE_MAX, noteById, notes } from "./noteStore";

export { NOTE_MAX, noteById, notes, setNoteText, useNote, useNotes, type Note } from "./noteStore";

/** A new note near a point; its id. */
export function addNote(text: string, at: Point, author: BoardAuthor = { kind: "you" }, color?: string): string {
  const id = boardId("k");
  const board = useBoardStore.getState();
  board.checkpoint();
  board.add(inSection({ id, type: "sticky", author, color: color ?? board.style.sticky, text: text.slice(0, NOTE_MAX), label: board.style.label, align: "left", ...freeSpot({ x: at.x - STICKY_SIZE.w / 2, y: at.y - STICKY_SIZE.h / 2, ...STICKY_SIZE }, [...notes(), ...tileRects()]), ...STICKY_SIZE }));
  return id;
}

/** Opens it: a page in the pane on the canvas, a tab in the grid. */
export function openNote(id: string): void {
  const grid = useWorkdeskViewStore.getState();
  if (grid.mode === "grid") grid.setOpenNode({ kind: "note", id });
  else useCanvasPageStore.getState().openNote(id);
}
/** Takes you to the sticky, or opens it in the grid. */
export function goToNote(id: string): void {
  const note = noteById(id);
  if (!note) return;
  if (useWorkdeskViewStore.getState().mode === "grid") return openNote(id);
  useCanvasPageStore.getState().close();
  useSelectionStore.setState({ selectedItems: [{ type: "annotation", annotationId: id }] });
  flyToBounds(note.x, note.y, note.w, note.h);
}
