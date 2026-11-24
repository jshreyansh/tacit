import { useCallback } from "react";
import {
  activateCardInScene,
  activateAnnotationInScene,
  activatePinInScene,
  activateTerminalInScene,
  activateWorktreeInScene,
  clearSceneFocus,
  setSceneSelection,
  setSceneSelectionRect,
} from "../actions/sceneSelectionActions";
import { drawingAt, isInGroup, itemsInBox, pressOn, toggleItem, unionItems } from "../canvas/canvasSelection";
import { sameSelectedItems } from "../canvas/sceneState";
import { useBoardStore } from "../stores/boardStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { useDrawingStore } from "../stores/drawingStore";
import { useSelectionStore, type SelectedItem } from "../stores/selectionStore";
import { screenPointToCanvasPoint } from "../canvas/viewportBounds";
import { hasPrimaryModifier } from "./shortcutTarget";

/** How far the pointer goes (on screen) before a press is a drag. */
const DRAG_FROM = 4;

function screenToCanvas(clientX: number, clientY: number) {
  return screenPointToCanvasPoint(clientX, clientY, useCanvasStore.getState().viewport);
}

export function activateSingleBoxSelectionItem(item: SelectedItem): void {
  if (item.type === "terminal") {
    activateTerminalInScene(item.projectId, item.worktreeId, item.terminalId, {
      focusComposer: false,
    });
  } else if (item.type === "worktree") {
    activateWorktreeInScene(item.projectId, item.worktreeId);
  } else if (item.type === "card") {
    activateCardInScene(item.cardId);
  } else if (item.type === "annotation") {
    activateAnnotationInScene(item.annotationId);
  } else if (item.type === "pin") {
    activatePinInScene(item.pinId);
  } else {
    setSceneSelection([item]);
  }
}

function select(items: SelectedItem[]): void {
  if (!sameSelectedItems(useSelectionStore.getState().selectedItems, items)) setSceneSelection(items);
}

/** Several things selected: nothing is typed into, so ⌫ and Escape are the canvas's. */
function leaveTyping(): void {
  clearSceneFocus();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** The click that ends this press isn't a click on what's under it. */
function swallowNextClick(): void {
  const swallow = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * Selecting on the canvas, as in tldraw and Excalidraw
 * (docs/architecture/workdesk-board.md, "Selecting several"):
 * - in Select, a drag on empty canvas draws a box; what it touches is
 *   selected as it goes;
 * - ⌘ or Shift with a drag adds to what's selected, from anywhere, Hand
 *   included; with a click it adds one thing, or takes it out;
 * - a plain click on one of several selected leaves just that one.
 */
export function useBoxSelect() {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || e.altKey) return;
    if (!(e.target instanceof Element)) return;
    // Canvas-navigation gestures (including marquee select) are inert while
    // focus view is active — the camera only moves via swipe/Cmd+Arrow.
    if (useCanvasStore.getState().focusMode.active) return;

    // Don't activate in drawing mode
    if (useDrawingStore.getState().tool !== "select") return;
    if (useBoardStore.getState().tool || useBoardStore.getState().editingId) return;
    if (useCanvasToolStore.getState().spaceHeld) return;

    const press = pressOn(e.target);
    if (!press) return;
    const hand = useCanvasToolStore.getState().tool === "hand";
    const adding = e.shiftKey || hasPrimaryModifier(e.nativeEvent);
    const sx = e.clientX;
    const sy = e.clientY;

    if (!adding) {
      if (hand) return;
      if (press.on === "item") {
        if (isInGroup(press.item)) {
          // Its own drag moves the group; a click without one leaves just it.
          const item = press.item;
          const up = (ev: MouseEvent) => {
            window.removeEventListener("mouseup", up, true);
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_FROM) activateSingleBoxSelectionItem(item);
          };
          window.addEventListener("mouseup", up, true);
        } else if (press.item.type === "file") {
          select([press.item]);
        }
        return;
      }
    } else if (press.on === "item" && !press.handle) {
      // Inside it: ⌘ and Shift are the terminal's, the page's or the text's.
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const start = screenToCanvas(sx, sy);
    const base = adding ? useSelectionStore.getState().selectedItems.filter((i) => i.type !== "project" && i.type !== "worktree") : [];
    let dragging = false;
    let frame = 0;
    let last = { x: sx, y: sy };

    const update = () => {
      frame = 0;
      const to = screenToCanvas(last.x, last.y);
      const rect = { x: start.x, y: start.y, w: to.x - start.x, h: to.y - start.y };
      setSceneSelectionRect(rect);
      const box = { x: Math.min(start.x, to.x), y: Math.min(start.y, to.y), w: Math.abs(rect.w), h: Math.abs(rect.h) };
      select(unionItems(base, itemsInBox(box)));
    };

    const handleMove = (ev: MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(last.x - sx, last.y - sy) < DRAG_FROM) return;
        dragging = true;
      }
      if (!frame) frame = requestAnimationFrame(update);
    };

    const handleUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (frame) cancelAnimationFrame(frame);
      if (dragging) {
        last = { x: ev.clientX, y: ev.clientY };
        update();
        setSceneSelectionRect(null);
      } else if (adding) {
        const item = press.on === "item" ? press.item : hand ? drawingAt(start) : null;
        if (item) select(toggleItem(base, item));
      } else {
        // A click on empty canvas: the canvas clears the selection itself.
        return;
      }
      swallowNextClick();

      const items = useSelectionStore.getState().selectedItems;
      if (items.length === 1) activateSingleBoxSelectionItem(items[0]);
      else if (items.length > 1) leaveTyping();
      // Selected in Hand: over to Select, so it can be moved.
      if (hand && items.length > 0) useCanvasToolStore.getState().setTool("select");
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, []);

  return { handleMouseDown };
}
