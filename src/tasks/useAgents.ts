import { useMemo } from "react";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { isActive } from "../../shared/task";
import { findTerminal } from "../actions/terminalLookup";
import { deriveTerminalState, isCanvasTerminal } from "../components/sessionPanelModel";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useProjectStore, createTerminal } from "../stores/projectStore";
import { agentNames, agentsIn } from "./agentNames";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { useNotificationStore } from "../stores/notificationStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import type { DockEntry, WorkerFolder } from "../toolbar/dockEntries";
import type { Task } from "../types";
import { useTaskStore } from "./taskStore";
import { useTasks } from "./taskStore";

export interface AgentChoice {
  id: string;
  name: string;
  type: string;
  folder: string;
  worktree: string;
  manager: boolean;
  busy: boolean;
  /** What it's on, and how many wait for it. */
  task: Task | null;
  queued: number;
}

/** What an agent's tile calls it. */
export function useAgentName(id: string): string | null {
  const projects = useProjectStore((s) => s.projects);
  return useMemo(() => agentNames(agentsIn(projects)).get(id) ?? null, [projects, id]);
}

/** The agents on this workdesk, the manager first: whom a task can go to. */
export function useAgents(): AgentChoice[] {
  const projects = useProjectStore((s) => s.projects);
  const runtimes = useTerminalRuntimeStore((s) => s.terminals);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const active = useCanvasRegistryStore((s) => s.activeCanvasId);
  const tasks = useTasks();
  return useMemo(() => {
    const manager = canvases.find((c) => c.id === active)?.workspaceManagerTerminalId ?? null;
    const on = new Map<string, Task>();
    const queued = new Map<string, number>();
    for (const task of tasks) {
      if (task.closed) continue;
      for (const t of task.tries) {
        if (!isActive(t.state)) continue;
        if (t.state === "queued") queued.set(t.terminal, (queued.get(t.terminal) ?? 0) + 1);
        else on.set(t.terminal, task);
      }
    }
    const names = agentNames(agentsIn(projects));
    const out: AgentChoice[] = [];
    for (const project of projects)
      for (const worktree of project.worktrees)
        for (const terminal of worktree.terminals) {
          if (!isCanvasTerminal(terminal) || !findAgentAdapter(terminal.type)) continue;
          const state = deriveTerminalState(terminal, runtimes[terminal.id]?.telemetry ?? null, undefined).state;
          out.push({
            id: terminal.id,
            name: names.get(terminal.id) ?? terminal.title,
            type: terminal.type,
            folder: project.name,
            worktree: worktree.path,
            manager: terminal.id === manager,
            busy: state === "active" || state === "attention" || on.has(terminal.id),
            task: on.get(terminal.id) ?? null,
            queued: queued.get(terminal.id) ?? 0,
          });
        }
    return out.sort((a, b) => Number(b.manager) - Number(a.manager) || Number(a.busy) - Number(b.busy) || a.name.localeCompare(b.name));
  }, [projects, runtimes, canvases, active, tasks]);
}

/**
 * A new agent, started with the brief as its first prompt. The task is handed
 * over first, so the agent's tile starts with what the main process wrote.
 */
export async function startAgentOn(task: Task, entry: DockEntry, name: string, where: WorkerFolder, options: { part?: string | null; allowed?: string; note?: string } = {}): Promise<boolean> {
  if (!entry.terminalType) return false;
  const project = useProjectStore.getState().projects.find((p) => p.id === where.projectId);
  const worktree = project?.worktrees.find((w) => w.id === where.worktreeId);
  if (!project || !worktree) return false;
  const terminal = createTerminal(entry.terminalType);
  // What it will be called once it's there, beside the others.
  name = agentNames([...agentsIn(useProjectStore.getState().projects), terminal]).get(terminal.id) ?? name;
  const result = await window.tacit.tasks
    .handOver({ workdesk: task.workdesk, id: task.id, terminal: terminal.id, how: "launch", as: { name, worktree: worktree.path }, ...options })
    .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!result.ok) {
    useNotificationStore.getState().notify("warn", result.error);
    return false;
  }
  createTerminalInScene({ projectId: where.projectId, worktreeId: where.worktreeId, terminal: { ...terminal, initialPrompt: result.value.brief } });
  useTaskStore.getState().put(result.value.task);
  return findTerminal(terminal.id) !== null;
}
