import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useProjectStore } from "../stores/projectStore";
import { useChatDockStore } from "../stores/chatDockStore";

/**
 * A folder's own views that you read: its changes (one file's diff
 * opened first, or all of them), its git history, and its memory. On the
 * canvas they open in the pane; in the grid, as a tab.
 */
export type FolderToolKind = "changes" | "history" | "memory" | "activity";

export interface FolderTool {
  kind: FolderToolKind;
  /** The folder (or worktree) path. */
  path: string;
  /** For changes: the file (relative to the folder) to open first. */
  focus?: string;
}

const KINDS: readonly FolderToolKind[] = ["changes", "history", "memory", "activity"];

export function folderToolId(tool: FolderTool): string {
  return `${tool.kind}:${tool.path}${tool.focus ? `#${tool.focus}` : ""}`;
}

export function parseFolderToolId(id: string): FolderTool | null {
  const colon = id.indexOf(":");
  if (colon < 0) return null;
  const kind = id.slice(0, colon) as FolderToolKind;
  if (!KINDS.includes(kind)) return null;
  const rest = id.slice(colon + 1);
  const hash = rest.indexOf("#");
  const path = hash < 0 ? rest : rest.slice(0, hash);
  if (!path) return null;
  return hash < 0 ? { kind, path } : { kind, path, focus: rest.slice(hash + 1) };
}

/** The workdesk's own memory (about you, its handover, what waits for review) opens as a memory tool on this path. */
export const WORKDESK_MEMORY_PREFIX = "workdesk:";

export function workdeskMemoryTool(workdeskId: string): FolderTool {
  return { kind: "memory", path: `${WORKDESK_MEMORY_PREFIX}${workdeskId}` };
}

/** The workdesk's Activity (what happened, by recorded task) opens as a tool on the same path. */
export function workdeskActivityTool(workdeskId: string): FolderTool {
  return { kind: "activity", path: `${WORKDESK_MEMORY_PREFIX}${workdeskId}` };
}

export function openFolderTool(tool: FolderTool): void {
  const id = folderToolId(tool);
  const view = useWorkdeskViewStore.getState();
  if (view.mode === "grid") view.openTool(id);
  else useCanvasPageStore.getState().openTool(id);
}

/**
 * The folder you're working in: the focused terminal's, else the last one a
 * panel was opened on, else the workdesk's first folder.
 */
export function currentFolderPath(): string | null {
  const { projects, panelWorktreeId } = useProjectStore.getState();
  for (const p of projects) for (const w of p.worktrees) if (w.terminals.some((t) => t.focused)) return w.path;
  for (const p of projects) for (const w of p.worktrees) if (w.id === panelWorktreeId) return w.path;
  const first = projects[0];
  return (first?.worktrees.find((w) => w.isPrimary) ?? first?.worktrees[0])?.path ?? first?.path ?? null;
}

/** A folder's files, unfolded in the navigator (shown, or opened over the rest). */
export function revealFolderFiles(path: string | null = currentFolderPath()): void {
  if (!path) return;
  const dock = useChatDockStore.getState();
  dock.showList();
  dock.requestNavSection({ path, kind: "files" });
}

/**
 * Where the old Files / Diff / Git / Memory panel's entry points (the command
 * palette, search, a tile's folder label) go now: files unfold in the
 * navigator; the folder's changes, history and memory open in the pane (a
 * tab in the grid).
 */
export function openFolderPlace(place: "files" | "diff" | "git" | "memory", path: string | null = currentFolderPath()): void {
  if (!path) return;
  if (place === "files") return revealFolderFiles(path);
  openFolderTool({ kind: place === "diff" ? "changes" : place === "git" ? "history" : "memory", path });
}
