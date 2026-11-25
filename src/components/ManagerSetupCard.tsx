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
import folderIcon from "../assets/dock-icons/folder.png";

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
        className="tc-enter-fade-up tc-squircle pointer-events-auto border border-[var(--border)] p-6"
        style={{
          width: "min(520px, 86vw)",
          background: "color-mix(in srgb, var(--bg) 94%, transparent)",
          backdropFilter: "var(--glass-filter, blur(24px))",
          WebkitBackdropFilter: "var(--glass-filter, blur(24px))",
          boxShadow: "0 18px 46px color-mix(in srgb, var(--shadow-color) 55%, transparent)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") skipManager();
        }}
      >
        <div className="text-[18px] font-semibold tracking-[-0.015em] text-[var(--text-primary)]">{t.setup_who_title}</div>
        <div className="mt-1.5 text-[13.5px] leading-snug text-[var(--text-metadata)]">{t.setup_who_body}</div>

        <div className="mt-4 flex max-h-[68px] flex-wrap items-center gap-1.5 overflow-y-auto">
          {projects.map((p) => (
            <span key={p.id} className="tc-setup-folder" title={p.path}>
              <img src={folderIcon} alt="" />
              <span>{p.name}</span>
            </span>
          ))}
          <button type="button" className="tc-setup-folder is-add" onClick={() => void promptAndAddProjectToScene(t)}>
            + {t.setup_add_another}
          </button>
        </div>

        {available.length === 0 ? (
          <div className="mt-4 text-[13px] leading-snug text-[var(--text-metadata)]">{t.setup_no_agents}</div>
        ) : (
          <div role="radiogroup" aria-label={t.setup_who_title} className="tc-onboarding-agents">
            {MANAGER_AGENTS.map(({ id, displayName }) => {
              const reason = missing(id);
              const selected = id === choice;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  disabled={reason !== null}
                  title={reason || undefined}
                  className="tc-onboarding-agent"
                  onClick={() => setPicked(id)}
                  onDoubleClick={() => startManager(id as TerminalType)}
                >
                  <img src={agentIcon(id)} alt="" />
                  <span className="info">
                    <span className="t">{displayName}</span>
                    {(reason !== null || id === lastUsed) && <span className="d">{reason !== null ? t.agent_not_installed : t.setup_last_used}</span>}
                  </span>
                  {reason === null && (
                    <span className="check">
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.5 6.4 L4.8 8.7 L9.5 3.6" />
                      </svg>
                    </span>
                  )}
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
              className="tc-onboarding-btn"
              data-primary=""
              onClick={() => startManager(choice as TerminalType)}
            >
              {t.setup_use(choiceName)}
            </button>
          )}
          <button
            type="button"
            className="tc-onboarding-btn"
            onClick={skipManager}
          >
            {t.setup_skip}
          </button>
        </div>
      </div>
    </div>
  );
}
