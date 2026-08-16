import type { CanvasFlowNode } from "./nodeProjection";
import type { BrowserCardData } from "../stores/browserCardStore";

export type FocusableNodeKind = "terminal" | "pin" | "browser";

export interface FocusableNode {
  kind: FocusableNodeKind;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const FALLBACK_TERMINAL_WIDTH = 300;
const FALLBACK_TERMINAL_HEIGHT = 200;
const FALLBACK_PIN_WIDTH = 280;
const FALLBACK_PIN_HEIGHT = 220;

export function focusableNodeKey(kind: FocusableNodeKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Every node focus view can fly the camera to, sorted left-to-right by
 * canvas x position — that ordering is derived fresh each time, never
 * stored, so rearranging the canvas naturally reorders focus view with no
 * migration needed. Mirrors ConnectionLayer.tsx's collectEndpointRects
 * (terminal positions from React Flow's own live `useNodes()` state, not
 * projectStore, so a card mid-drag isn't stale) but also includes pins,
 * which collectEndpointRects doesn't need to since ConnectionEndpointKind
 * has no "pin" variant.
 */
export function collectFocusableNodes(
  terminalAndPinNodes: CanvasFlowNode[],
  browserCards: Record<string, BrowserCardData>,
): FocusableNode[] {
  const nodes: FocusableNode[] = [];

  for (const node of terminalAndPinNodes) {
    if (node.type === "terminal") {
      nodes.push({
        kind: "terminal",
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        w: (node.style?.width as number | undefined) ?? FALLBACK_TERMINAL_WIDTH,
        h: (node.style?.height as number | undefined) ?? FALLBACK_TERMINAL_HEIGHT,
      });
    } else if (node.type === "pin") {
      nodes.push({
        kind: "pin",
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        w: (node.style?.width as number | undefined) ?? FALLBACK_PIN_WIDTH,
        h: (node.style?.height as number | undefined) ?? FALLBACK_PIN_HEIGHT,
      });
    }
  }

  for (const card of Object.values(browserCards)) {
    nodes.push({ kind: "browser", id: card.id, x: card.x, y: card.y, w: card.w, h: card.h });
  }

  nodes.sort((a, b) => a.x - b.x);
  return nodes;
}

/** Whichever node's center is geometrically closest to a given world-space
 * point — used to pick a sensible starting node when entering focus view
 * (whatever you were already looking at), not always the leftmost node. */
export function closestFocusableNode(
  nodes: FocusableNode[],
  point: { x: number; y: number },
): FocusableNode | null {
  let best: FocusableNode | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const dist = (cx - point.x) ** 2 + (cy - point.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = node;
    }
  }
  return best;
}
