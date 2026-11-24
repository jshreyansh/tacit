import { useMemo } from "react";
import { listAgentAdapters } from "../../shared/agent-adapters";
import { managerCandidates, seatManager, startManager } from "../actions/managerSeat";
import { useT } from "../i18n/useT";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
import { useProjectStore } from "../stores/projectStore";
import { AgentOption, NewAgentTiles, PickerHeading, arrowKeys } from "../agents/AgentPicker";
import { agentNames, agentsIn } from "../tasks/agentNames";

export const MANAGER_AGENTS = listAgentAdapters().filter((adapter) => !adapter.retired);

/** Whether an agent's CLI was looked for and not found. Unknown counts as available. */
export function useMissingAgents(): (type: string) => string | null {
  const detections = useAgentAvailabilityStore((s) => s.byId);
  return (type) => {
    const detection = detections[type];
    return detection !== undefined && !detection.installed ? (detection.reason ?? "") : null;
  };
}

/**
 * Who could run this workdesk: agents already on it (they keep their chat),
 * then a new one of each installed kind. The one list, wherever a manager is
 * chosen: the Assign control, the Manager panel, handing the seat on.
 */
export function AssignMenu({ managerId, onPicked }: { managerId: string | null; onPicked?: () => void }) {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const running = useMemo(() => managerCandidates(projects, managerId), [projects, managerId]);
  const names = useMemo(() => agentNames(agentsIn(projects)), [projects]);

  return (
    <div role="menu" aria-label={t.project_chat_assign} onKeyDown={arrowKeys}>
      {running.length > 0 && (
        <>
          <PickerHeading>{t.assign_running}</PickerHeading>
          {running.map((c) => (
            <AgentOption
              key={c.id}
              role="menuitem"
              type={c.type}
              name={names.get(c.id) ?? MANAGER_AGENTS.find((a) => a.id === c.type)?.displayName ?? c.type}
              detail={`${c.where} · ${t.assign_keeps_chat}`}
              onPick={() => {
                seatManager(c.id);
                onPicked?.();
              }}
            />
          ))}
          <div className="tc-ap-rule" />
        </>
      )}
      <PickerHeading>{t.assign_new}</PickerHeading>
      <NewAgentTiles
        role="menuitem"
        actionLabel={t.tb.newAgent}
        onPick={(entry) => {
          if (entry.terminalType && startManager(entry.terminalType)) onPicked?.();
        }}
      />
    </div>
  );
}
