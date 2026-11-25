import { findTerminal } from "../actions/terminalLookup";
import { useT } from "../i18n/useT";
import { TERMINAL_TYPE_CONFIG } from "../terminal/terminalTypeConfig";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { AgentAsk } from "./TaskAsks";

/**
 * An agent on no task, waiting on you: a card in Needs you, as a task's
 * permission is. A chat's question or permission is answered here; a
 * terminal's in its terminal, which the card takes you to.
 */
export function AgentWaitCard({ terminalId }: { terminalId: string }) {
  const t = useT();
  const tool = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.telemetry?.foreground_tool ?? null);
  const found = findTerminal(terminalId);
  const name = found ? found.terminal.customTitle?.trim() || TERMINAL_TYPE_CONFIG[found.terminal.type]?.label || found.terminal.title : terminalId;
  const text = tool === "AskUserQuestion" ? t.needs_agent_question : tool ? t.needs_agent_tool(tool) : t.needs_agent_waiting;
  return (
    <div className="tc-tk-card tc-tk-asks">
      <AgentAsk terminal={terminalId} byName={name} text={text} meta={found ? (found.project.name ?? "") : ""} />
    </div>
  );
}
