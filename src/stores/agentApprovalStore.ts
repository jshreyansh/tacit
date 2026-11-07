import { create } from "zustand";
import type { AgentApprovalChoice } from "../terminal/agentApprovals";

/**
 * Projects whose agents are waiting to start until the person says whether
 * they may run without approvals (T15.1). Each waiting launch holds a
 * promise; one answer releases every launch for that project.
 */

export interface PendingApproval {
  projectPath: string;
  projectName: string;
  /** Launches waiting on this answer. */
  waiting: number;
}

interface AgentApprovalStore {
  /** Oldest first: the dialog shows the first. */
  pending: PendingApproval[];
}

export const useAgentApprovalStore = create<AgentApprovalStore>(() => ({ pending: [] }));

const waiters = new Map<string, Array<(choice: AgentApprovalChoice) => void>>();

/** Waits for the person's answer for this project. */
export function requestAgentApproval(projectPath: string, projectName: string): Promise<AgentApprovalChoice> {
  return new Promise((resolve) => {
    waiters.set(projectPath, [...(waiters.get(projectPath) ?? []), resolve]);
    useAgentApprovalStore.setState(({ pending }) => {
      const existing = pending.find((p) => p.projectPath === projectPath);
      return {
        pending: existing
          ? pending.map((p) => (p === existing ? { ...p, waiting: p.waiting + 1 } : p))
          : [...pending, { projectPath, projectName, waiting: 1 }],
      };
    });
  });
}

/** Releases every launch waiting on this project with the answer. */
export function answerAgentApproval(projectPath: string, choice: AgentApprovalChoice): void {
  const resolvers = waiters.get(projectPath) ?? [];
  waiters.delete(projectPath);
  useAgentApprovalStore.setState(({ pending }) => ({ pending: pending.filter((p) => p.projectPath !== projectPath) }));
  for (const resolve of resolvers) resolve(choice);
}
