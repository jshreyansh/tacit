import type { ProjectData, WorktreeData } from "../../types";

/**
 * What the side panel (Files, Diff, Git, Memory) shows on the active
 * workdesk: one project's folder, a list to choose from, or nothing to show.
 */
export type PanelProject =
  | { kind: "project"; project: ProjectData; worktree: WorktreeData }
  | { kind: "choose"; projects: ProjectData[] }
  | { kind: "none" };

/** The folder a project is shown from when it's picked as a whole. */
export function projectMainWorktree(project: ProjectData): WorktreeData | null {
  return (
    project.worktrees.find((worktree) => worktree.isPrimary) ??
    project.worktrees.find((worktree) => worktree.path === project.path) ??
    project.worktrees[0] ??
    null
  );
}

function findWorktree(
  projects: ProjectData[],
  worktreeId: string,
): { project: ProjectData; worktree: WorktreeData } | null {
  for (const project of projects) {
    const worktree = project.worktrees.find((w) => w.id === worktreeId);
    if (worktree) return { project, worktree };
  }
  return null;
}

/**
 * Only projects on this workdesk are ever shown. The panel's own choice
 * comes first (it was picked, or set by the last terminal focused here),
 * then the focused worktree. With neither, a workdesk with one project
 * shows it, and one with several asks rather than guessing.
 */
export function resolvePanelProject(
  projects: ProjectData[],
  panelWorktreeId: string | null,
  focusedWorktreeId: string | null,
): PanelProject {
  for (const worktreeId of [panelWorktreeId, focusedWorktreeId]) {
    if (!worktreeId) continue;
    const found = findWorktree(projects, worktreeId);
    if (found) return { kind: "project", ...found };
  }

  const withFolders = projects.filter((project) => projectMainWorktree(project));
  if (withFolders.length === 0) return { kind: "none" };
  if (withFolders.length === 1) {
    const project = withFolders[0];
    return { kind: "project", project, worktree: projectMainWorktree(project)! };
  }
  return { kind: "choose", projects: withFolders };
}

/** A folder path as people read it: the home folder as `~`. */
export function displayFolderPath(folderPath: string, homePath: string): string {
  if (!homePath) return folderPath;
  if (folderPath === homePath) return "~";
  if (folderPath.startsWith(`${homePath}/`)) return `~${folderPath.slice(homePath.length)}`;
  return folderPath;
}
