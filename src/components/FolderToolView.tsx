import { parseFolderToolId, WORKDESK_MEMORY_PREFIX, type FolderTool } from "../actions/folderTools";
import { useT } from "../i18n/useT";
import { useProjectStore } from "../stores/projectStore";
import { DiffContent } from "./RightPanel/DiffContent";
import { GitContent } from "./RightPanel/GitContent";
import { MemoryView } from "./MemoryView";
import { ActivityView } from "./ActivityView";

/** A folder view's name: "Changes · tacit", "History · tacit", "Memory · tacit". */
export function folderToolTitle(tool: FolderTool | null, t: ReturnType<typeof useT>): string {
  if (!tool) return "";
  if (tool.kind === "activity") return t.nav_activity;
  if (tool.kind === "memory" && tool.path.startsWith(WORKDESK_MEMORY_PREFIX)) return t.mem_title;
  const folder = tool.path.split(/[\\/]/).filter(Boolean).pop() ?? tool.path;
  const what = tool.kind === "changes" ? t.nav_changes : tool.kind === "history" ? t.nav_history : t.nav_memory;
  return `${what} · ${folder}`;
}

/** A folder's changes, history or memory: in the pane on the canvas, or a grid tab. */
export function FolderToolView({ toolId }: { toolId: string }) {
  const t = useT();
  const tool = parseFolderToolId(toolId);
  if (!tool) return <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text-muted)]">{t.no_worktree_selected}</div>;
  if (tool.kind === "changes") return <DiffContent key={toolId} worktreePath={tool.path} isGitRepo focusFile={tool.focus} />;
  if (tool.kind === "history") return <GitContent key={toolId} worktreePath={tool.path} />;
  if (tool.kind === "activity") return <ActivityView key={toolId} workdeskId={tool.path.slice(WORKDESK_MEMORY_PREFIX.length)} />;
  return <FolderMemoryTool key={toolId} path={tool.path} />;
}

/** A folder's memory with its worktrees', or (for the workdesk path) the workdesk's own. */
function FolderMemoryTool({ path }: { path: string }) {
  const worktrees = useProjectStore((s) => {
    const project = s.projects.find((p) => p.path === path || p.worktrees.some((w) => w.path === path));
    return project ? project.worktrees.map((w) => w.path).join("\n") : "";
  });
  if (path.startsWith(WORKDESK_MEMORY_PREFIX)) {
    return <MemoryView target={{ mode: "workdesk", workdeskId: path.slice(WORKDESK_MEMORY_PREFIX.length) }} />;
  }
  return <MemoryView target={{ mode: "folder", folder: path, worktrees: worktrees ? worktrees.split("\n") : [] }} />;
}
