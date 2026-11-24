import { findTerminal } from "../actions/terminalLookup";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { newTask } from "./taskActions";
import { slugName } from "./taskWords";
import { agentNames, agentsIn } from "./agentNames";

/** What an agent is already doing, written down as a task for it: yours to check before it's made. */
export function trackChat(terminalId: string): void {
  const found = findTerminal(terminalId);
  if (!found) return;
  const { terminal, worktree, project } = found;
  const prompt = useTerminalRuntimeStore.getState().terminals[terminalId]?.telemetry?.first_user_prompt?.trim() ?? "";
  const name = agentNames(agentsIn(useProjectStore.getState().projects)).get(terminalId) ?? terminal.title;
  const first = prompt.split("\n")[0].slice(0, 120).trim();
  newTask({
    title: `${first} @${slugName(name)}`.trim(),
    body: prompt.length > first.length ? prompt.slice(0, 4000) : "",
    folder: useProjectStore.getState().projects.some((p) => p.id === project.id) ? worktree.path : null,
    startFrom: [{ kind: "chat", label: name, target: terminalId }],
    madeFrom: { kind: "chat", label: name, target: terminalId },
  });
}
