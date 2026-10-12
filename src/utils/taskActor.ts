import { useProjectStore } from "../stores/projectStore";

/**
 * Who did something to a task, in words: "you", or the agent's name for a
 * terminal ref ("terminal:<id>"). The record keeps refs; people read names.
 */
export function taskActorName(ref: string, fallback: string): string {
  if (!ref.startsWith("terminal:")) return fallback;
  const id = ref.slice("terminal:".length);
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((t) => t.id === id);
      if (terminal) {
        const name = terminal.customTitle || terminal.type;
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  }
  return fallback;
}
