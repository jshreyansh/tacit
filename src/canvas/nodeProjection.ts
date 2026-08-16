import type { Node } from "@xyflow/react";
import type { ProjectData, Pin } from "../types";

export interface TerminalNodeData {
  terminalId: string;
  projectId: string;
  worktreeId: string;
  projectName: string;
  [key: string]: unknown;
}

export interface PinNodeData {
  pinId: string;
  /** Same value as Pin.repo — the project path pins are keyed by in usePinStore. */
  projectPath: string;
  [key: string]: unknown;
}

export type TerminalFlowNode = Node<TerminalNodeData, "terminal">;
export type PinFlowNode = Node<PinNodeData, "pin">;
export type CanvasFlowNode = TerminalFlowNode | PinFlowNode;

const DEFAULT_PIN_WIDTH = 280;
const DEFAULT_PIN_HEIGHT = 220;

/**
 * Notes are plain markdown/DOM (see PinNode.tsx) with no native surface to
 * protect, unlike browser tiles' <webview> — so unlike those (kept in the
 * parallel CanvasCardLayer), they live directly inside React Flow's own
 * node tree, same as terminals. Only pins with x/y set render here; a pin
 * with no spatial data stays list/drawer-only (see shared/pin.ts).
 */
export function buildPinFlowNodes(pins: Pin[]): PinFlowNode[] {
  const nodes: PinFlowNode[] = [];
  for (const pin of pins) {
    if (pin.x == null || pin.y == null) continue;
    nodes.push({
      id: pin.id,
      type: "pin",
      position: { x: pin.x, y: pin.y },
      data: { pinId: pin.id, projectPath: pin.repo },
      style: {
        width: pin.w ?? DEFAULT_PIN_WIDTH,
        height: pin.h ?? DEFAULT_PIN_HEIGHT,
      },
      draggable: true,
      selectable: true,
    });
  }
  return nodes;
}

export function buildCanvasFlowNodes(
  projects: ProjectData[],
  positionOverrides?: Map<string, { x: number; y: number }>,
): TerminalFlowNode[] {
  const nodes: TerminalFlowNode[] = [];
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (terminal.stashed) continue;
        const position = positionOverrides?.get(terminal.id);
        nodes.push({
          id: terminal.id,
          type: "terminal",
          position: position
            ? { x: position.x, y: position.y }
            : { x: terminal.x, y: terminal.y },
          data: {
            terminalId: terminal.id,
            projectId: project.id,
            worktreeId: worktree.id,
            projectName: project.name,
          },
          style: {
            width: terminal.width,
            height: terminal.minimized ? undefined : terminal.height,
          },
          draggable: true,
          selectable: true,
        });
      }
    }
  }
  return nodes;
}
