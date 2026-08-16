import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStateStore } from "../stores/terminalRuntimeStateStore";

/**
 * Shared by sceneConnectionActions.ts's wire-up notice and App.tsx's
 * getConnectionsForNode bridge — both need to resolve a terminal's
 * worktree/type plus its *live* ptyId, not duplicate the lookup.
 */
export function findTerminal(terminalId: string) {
  const { projects } = useProjectStore.getState();
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((t) => t.id === terminalId);
      if (terminal) return { terminal, worktree, project };
    }
  }
  return null;
}

/**
 * The live ptyId is NOT reliably readable off `useProjectStore` — that's a
 * one-shot copy taken from whatever `terminal.ptyId` happened to be when
 * the terminal object was last built (usually still `null`, its initial
 * value). The real, continuously-updated value lives in
 * `useTerminalRuntimeStateStore` (see `setPtyId` in
 * `src/terminal/terminalRuntimeStore.ts`).
 */
export function getLivePtyId(terminalId: string): number | null {
  const patch = useTerminalRuntimeStateStore.getState().terminals[terminalId];
  return patch && "ptyId" in patch ? (patch.ptyId ?? null) : null;
}
