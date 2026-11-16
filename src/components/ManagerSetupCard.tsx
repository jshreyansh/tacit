import { useEffect, useMemo, useState } from "react";
import { promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { skipManager, startManager, useManagerSetupStore } from "../actions/managerSeat";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { CHROME_INSET, LEFT_RAIL_WIDTH } from "../stores/canvasStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useProjectStore } from "../stores/projectStore";
import { MANAGER_AGENTS, useMissingAgents } from "../toolbar/AssignMenu";
import { agentIcon } from "../toolbar/agentIcons";
import type { TerminalType } from "../types";

/**
 * "Who runs this workdesk?", asked once, right after its first folder. Sits
 * in the middle of the workdesk in either view; choosing seats a manager and
 * opens the Manager panel ready to type, Skip leaves you to start agents
 * yourself. The Assign control at the bottom is the way back to it later.
 */
export function ManagerSetupCard() {
  const t = useT();
  const activeId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const hasManager = useCanvasRegistryStore(
    (s) => !!s.canvases.find((c) => c.id === s.activeCanvasId)?.workspaceManagerTerminalId,
  );
  const asking = useManagerSetupStore((s) => (activeId ? !!s.asking[activeId] : false));
  const projects = useProjectStore((s) => s.projects);
  const lastUsed = usePreferencesStore((s) => s.lastManagerAgent);
  const missing = useMissingAgents();

  const available = useMemo(() => MANAGER_AGENTS.filter((a) => missing(a.id) === null), [missing]);
  const preferred = available.find((a) => a.id === lastUsed)?.id ?? available[0]?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked && missing(picked) === null ? picked : preferred;
  useEffect(() => setPicked(null), [activeId]);

  if (!asking || hasManager || projects.length === 0) return null;
  const choiceName = MANAGER_AGENTS.find((a) => a.id === choice)?.displayName ?? "";

  return (
    <div
      className="pointer-events-none fixed inset-y-0 right-0 z-[60] flex items-center justify-center"
      style={{ left: LEFT_RAIL_WIDTH + CHROME_INSET * 2 }}
    >
      <div
        role="dialog"
        aria-label={t.setup_who_title}
        className="tc-enter-fade-up pointer-events-auto rounded-2xl border border-[var(--border)] p-5"
        style={{
          width: "min(460px, 86vw)",
          background: "color-mix(in srgb, var(--surface) 92%, transparent)",
          backdropFilter: "var(--glass-filter, blur(24px))",
          WebkitBackdropFilter: "var(--glass-filter, blur(24px))",
          boxShadow: "0 18px 46px color-mix(in srgb, var(--shadow-color) 55%, transparent)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") skipManager();
        }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {projects.map((p) => (
            <span key={p.id} className="tc-chip" title={p.path}>
              {p.name}
            </span>
          ))}
          <button
            type="button"
            className="ml-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => void promptAndAddProjectToScene(t)}
          >
            + {t.setup_add_another}
          </button>
        </div>

        <div className="mt-4 text-[16px] font-semibold text-[var(--text-primary)]">{t.setup_who_title}</div>
        <div className="mt-1 text-[13px] leading-snug text-[var(--text-secondary)]">{t.setup_who_body}</div>

        {available.length === 0 ? (
          <div className="mt-4 text-[13px] leading-snug text-[var(--text-secondary)]">{t.setup_no_agents}</div>
        ) : (
          <div role="radiogroup" aria-label={t.setup_who_title} className="mt-4 grid grid-cols-4 gap-2">
            {MANAGER_AGENTS.map(({ id, displayName }) => {
              const reason = missing(id);
              const selected = id === choice;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={reason !== null || undefined}
                  title={reason || undefined}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 py-3 text-[12px] transition-colors duration-instant ${
                    reason !== null ? "opacity-40" : "hover:bg-[var(--surface-hover)]"
                  }`}
                  style={{
                    borderColor: selected ? "var(--text-secondary)" : "var(--border)",
                    background: selected ? "var(--surface-hover)" : undefined,
                    color: "var(--text-primary)",
                  }}
                  onClick={() => reason === null && setPicked(id)}
                  onDoubleClick={() => reason === null && startManager(id as TerminalType)}
                >
                  <img src={agentIcon(id)} alt="" className="h-7 w-7 object-contain" />
                  <span className="max-w-full truncate px-1">{displayName}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {reason !== null ? t.agent_not_installed : id === lastUsed ? t.setup_last_used : " "}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {choice && (
            <button
              type="button"
              autoFocus
              className="inline-flex h-8 items-center rounded-lg bg-[var(--text-primary)] px-3.5 text-[13px] font-medium text-[var(--bg)] hover:opacity-90"
              onClick={() => startManager(choice as TerminalType)}
            >
              {t.setup_use(choiceName)}
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
            onClick={skipManager}
          >
            {t.setup_skip}
          </button>
        </div>
      </div>
    </div>
  );
}
