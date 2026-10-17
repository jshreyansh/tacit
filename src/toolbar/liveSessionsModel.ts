import type { CanvasTerminalItem, ProjectGroup } from "../components/sessionPanelModel";

/**
 * The live half of the docked chat's Sessions view: what is on this
 * workdesk now. Pure, so the search is tested without a DOM.
 */

/** Every terminal in the tree, in tree order. */
export function treeTerminals(projects: readonly ProjectGroup[]): CanvasTerminalItem[] {
  return projects.flatMap((project) => project.worktrees.flatMap((worktree) => worktree.terminals));
}

/** Terminals whose title, project or worktree contains every word of the query, any case. */
export function filterLiveTerminals(items: readonly CanvasTerminalItem[], query: string): CanvasTerminalItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = [item.title, item.projectName, item.worktreeName, item.locationLabel].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
