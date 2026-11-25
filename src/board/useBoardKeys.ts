import { useEffect } from "react";
import { useBoardStore, selectedBoardElements } from "../stores/boardStore";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useSelectionStore } from "../stores/selectionStore";
import { isEditableTarget, isTerminalShortcutTarget, hasPrimaryModifier } from "../hooks/shortcutTarget";
import { canQuickConnect, type Direction } from "./boardModel";
import { duplicate, finishEditing, pickTool, quickAdd, startEditing, toggleToolLock } from "./boardActions";
import { mediaFiles, placeMediaFiles } from "./boardMedia";
import { RAIL_TOOLS } from "./BoardChrome";
import type { BoardElement } from "../types/board";

/**
 * The board's keys (docs/architecture/workdesk-board.md). They run before
 * the app's own shortcuts, and only when nothing that types has the focus:
 * a terminal, the composer or a text being edited keep every key.
 *
 * - V H T N S R O D A P, or 1–8: pick a tool (R box, O ellipse, D diamond)
 * - F or 9: add files (they open the file picker at once)
 * - Q: keep the tool after drawing (off unless asked for; marked on the tool)
 * - Escape: back to Select, then let go of the selection
 * - Enter: type into the selected shape, sticky, text or section
 * - ⌘ + arrow: a linked shape in that direction
 * - ⌘Z / ⇧⌘Z: undo and redo your own board changes
 * - ⌘C / ⌘V: copy and paste drawings; files on the clipboard become file tiles
 *
 * ⌘D stays the app's (close the focused tile); duplicate is Option-drag.
 */

const DIRS: Record<string, Direction> = { ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up" };
const LETTERS: Record<string, Parameters<typeof pickTool>[0]> = { v: "select", h: "hand", t: "text", n: "sticky", s: "section", r: "shape", a: "arrow", p: "pen", f: "file" };
const SHAPES: Record<string, "rect" | "ellipse" | "diamond"> = { r: "rect", o: "ellipse", d: "diamond" };

const OWN_KEYS = "[role=form],[role=dialog],[role=alertdialog],[role=menu],[role=listbox]";

let clipboard: BoardElement[] = [];

export function useBoardKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The board is the canvas's: not in the grid, and not in Focus view, where ⌘ + arrow pages through tiles.
      if (useWorkdeskViewStore.getState().mode === "grid" || useCanvasStore.getState().focusMode.active) return;
      if (e.defaultPrevented || isEditableTarget(e.target) || isTerminalShortcutTarget(e.target)) return;
      const mod = hasPrimaryModifier(e);
      // Answering something, or in a menu: its own keys (1 to 9 pick an answer) come first.
      if (!mod && e.target instanceof Element && e.target.closest(OWN_KEYS)) return;
      const board = useBoardStore.getState();
      const consume = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };

      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        const did = e.shiftKey ? board.redo() : board.undo();
        if (did) consume();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && DIRS[e.key]) {
        const sel = selectedBoardElements();
        if (sel.length === 1 && canQuickConnect(sel[0])) {
          consume();
          quickAdd(sel[0].id, DIRS[e.key]);
        }
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
        const sel = selectedBoardElements();
        if (sel.length) {
          clipboard = JSON.parse(JSON.stringify(sel));
          consume();
        }
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "v" && clipboard.length) {
        // Paste puts copies back on the board, a step down and right of the originals.
        const ids = clipboard.map((c) => c.id).filter((id) => useBoardStore.getState().elements.some((x) => x.id === id));
        if (ids.length) {
          consume();
          duplicate(ids, 32);
        }
        return;
      }
      if (mod || e.altKey || e.repeat) return;

      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (board.editingId) {
          finishEditing();
          consume();
          return;
        }
        if (board.tool) {
          pickTool("select");
          consume();
          return;
        }
        if (selectedBoardElements().length || useSelectionStore.getState().selectedItems.length > 1) {
          useSelectionStore.getState().clearSelection();
          consume();
        }
        return;
      }
      if (e.key === "Enter") {
        const sel = selectedBoardElements();
        if (sel.length === 1 && ["text", "shape", "sticky", "section", "frame"].includes(sel[0].type)) {
          consume();
          startEditing(sel[0].id);
        }
        return;
      }
      if (e.shiftKey) return;
      if (key === "q") {
        consume();
        toggleToolLock();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const tool = RAIL_TOOLS.find((x) => String(x.num) === e.key);
        if (tool) {
          consume();
          pickTool(tool.id);
        }
        return;
      }
      if (SHAPES[key]) {
        consume();
        board.setStyle({ shape: SHAPES[key] });
        pickTool("shape");
        return;
      }
      if (LETTERS[key]) {
        consume();
        pickTool(LETTERS[key]);
        // Space-to-pan and the app's V/H stay in step with the rail.
        if (key === "v" || key === "h") useCanvasToolStore.getState().setTool(key === "v" ? "select" : "hand");
      }
    };

    // A picture (or video, sound, PDF) on the clipboard, pasted onto the
    // canvas, is saved in the workdesk and shown as a file tile mid-view.
    const onPaste = (e: ClipboardEvent) => {
      if (useWorkdeskViewStore.getState().mode === "grid") return;
      if (isEditableTarget(e.target) || isTerminalShortcutTarget(e.target)) return;
      const files = mediaFiles(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      void placeMediaFiles(files, null);
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("paste", onPaste);
    };
  }, []);
}
