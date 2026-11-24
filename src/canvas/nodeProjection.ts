import type { Node } from "@xyflow/react";
import type { ProjectData, Task } from "../types";
import type { BoardRect } from "../types/board";
import type { FileTileData } from "../stores/fileTileStore";

export interface TerminalNodeData {
  terminalId: string;
  projectId: string;
  worktreeId: string;
  projectName: string;
  [key: string]: unknown;
}

export interface TaskNodeData {
  taskId: string;
  [key: string]: unknown;
}

export interface FileNodeData {
  tileId: string;
  path: string;
  [key: string]: unknown;
}

export type TerminalFlowNode = Node<TerminalNodeData, "terminal">;
export type TaskFlowNode = Node<TaskNodeData, "task">;
export type FileFlowNode = Node<FileNodeData, "file">;
export type CanvasFlowNode = TerminalFlowNode | TaskFlowNode | FileFlowNode;

/** Files shown on the canvas (FileTileNode.tsx): plain DOM, like notes. */
export function buildFileFlowNodes(tiles: readonly FileTileData[]): FileFlowNode[] {
  return tiles.map((tile) => ({
    id: tile.id,
    type: "file",
    position: { x: tile.x, y: tile.y },
    data: { tileId: tile.id, path: tile.path },
    style: { width: tile.w, height: tile.h },
    draggable: true,
    selectable: true,
  }));
}

/** Tasks put on this canvas (TaskNode.tsx), where the workdesk says they are. */
export function buildTaskFlowNodes(placed: ReadonlyArray<{ task: Pick<Task, "id">; rect: BoardRect }>): TaskFlowNode[] {
  return placed.map(({ task, rect }) => ({
    id: task.id,
    type: "task",
    position: { x: rect.x, y: rect.y },
    data: { taskId: task.id },
    style: { width: rect.w, height: rect.h },
    draggable: true,
    selectable: true,
  }));
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
