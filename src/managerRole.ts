import { recordDecision } from "./capture";
import { useProjectStore } from "./stores/projectStore";

/**
 * Everything that has to happen when the workspace-manager role moves, in one
 * place so the pill and the MCP surface can't diverge.
 *
 * Two separate records, deliberately:
 *  - the decision record gets "the role moved", as one more choice among the
 *    spawns and wires around it;
 *  - the tenure log in main gets the durable (terminal, session) pairing that
 *    the Project Chat history list reads back. Main owns that one because the
 *    session id only ever arrives there, on the hook socket.
 */
export function recordManagerRoleChange(
  canvasId: string,
  terminalId: string | null,
): void {
  recordDecision({
    kind: "manager",
    node: terminalId ? `terminal:${terminalId}` : null,
    by: "user",
  });

  try {
    window.tacit?.managerRole?.set(
      terminalId
        ? { terminalId, cli: findTerminalCli(terminalId), canvasId }
        : null,
    );
  } catch {
    // Losing a history row must never break assigning the role.
  }
}

/** Which CLI is in that terminal, so a history row can be labelled. */
function findTerminalCli(terminalId: string): string | null {
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((t) => t.id === terminalId);
      if (terminal) return terminal.type;
    }
  }
  return null;
}
