import { useMemo } from "react";
import { listAgentAdapters } from "../../shared/agent-adapters";
import { managerCandidates, seatManager, startManager } from "../actions/managerSeat";
import { useT } from "../i18n/useT";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
import { useProjectStore } from "../stores/projectStore";
import type { TerminalType } from "../types";
import { agentIcon } from "./agentIcons";

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
  const missing = useMissingAgents();

  return (
    <div role="menu" aria-label={t.project_chat_assign}>
      {running.length > 0 && (
        <>
          <div className="tc-eyebrow px-2.5 pb-1 pt-2">{t.assign_running}</div>
          {running.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="tc-menu-option"
              onClick={() => {
                seatManager(c.id);
                onPicked?.();
              }}
            >
              <img src={agentIcon(c.type)} alt="" className="h-4 w-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate">{MANAGER_AGENTS.find((a) => a.id === c.type)?.displayName ?? c.type}</span>
              <span className="tc-menu-option-detail shrink-0 truncate">
                {c.where} · {t.assign_keeps_chat}
              </span>
            </button>
          ))}
        </>
      )}
      <div className="tc-eyebrow px-2.5 pb-1 pt-2">{t.assign_new}</div>
      {MANAGER_AGENTS.map(({ id, displayName }) => {
        const reason = missing(id);
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            className={`tc-menu-option${reason !== null ? " opacity-50" : ""}`}
            aria-disabled={reason !== null || undefined}
            title={reason || undefined}
            onClick={() => {
              if (reason !== null) return;
              if (startManager(id as TerminalType)) onPicked?.();
            }}
          >
            <img src={agentIcon(id)} alt="" className="h-4 w-4 shrink-0 object-contain" />
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
            {reason !== null && <span className="tc-menu-option-detail shrink-0">{t.agent_not_installed}</span>}
          </button>
        );
      })}
    </div>
  );
}
