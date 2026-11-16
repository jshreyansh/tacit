import { useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { useProjectStore } from "../stores/projectStore";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
import { useNotificationStore } from "../stores/notificationStore";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import type { TerminalType } from "../types";

const AGENTS: { type: TerminalType; name: string }[] = [
  { type: "claude", name: "Claude Code" },
  { type: "codex", name: "Codex" },
  { type: "opencode", name: "OpenCode" },
  { type: "antigravity", name: "Antigravity" },
];

/**
 * With no manager, a message starts an agent directly: pick the folder and
 * which agent, type the task, Enter. The agent opens in that folder with the
 * task as its first prompt; its conversation is in its own tab or tile.
 */
export function DirectStart() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const availability = useAgentAvailabilityStore((s) => s.byId);
  const installed = useMemo(() => AGENTS.filter((a) => availability[a.type]?.installed !== false), [availability]);
  const [projectId, setProjectId] = useState<string>("");
  const [agent, setAgent] = useState<TerminalType | "">("");
  const [text, setText] = useState("");
  if (projects.length === 0) return null;
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const chosen = installed.find((a) => a.type === agent) ?? installed[0];

  const start = () => {
    const prompt = text.trim();
    const worktree = project?.worktrees[0];
    if (!prompt || !project || !worktree || !chosen) return;
    createTerminalInScene({ projectId: project.id, worktreeId: worktree.id, type: chosen.type, initialPrompt: prompt });
    setText("");
    useNotificationStore.getState().notify("info", t.direct_started(chosen.name, project.name));
  };

  const select =
    "h-7 max-w-[45%] truncate rounded-full border border-[var(--border)] bg-transparent px-2.5 text-[11px] text-[var(--text-primary)] outline-none hover:border-[var(--border-hover)]";
  return (
    <div className="mx-3 mb-3 mt-auto flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] p-2.5 focus-within:border-[var(--border-hover)]">
      <div className="text-[11px] text-[var(--text-secondary)]">{t.direct_hint}</div>
      <label className="flex">
        <span className="sr-only">{t.direct_placeholder}</span>
        <textarea
          rows={2}
          value={text}
          placeholder={t.direct_placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              start();
            }
          }}
          className="min-h-[40px] w-full resize-none bg-transparent text-[13px] leading-snug text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </label>
      <div className="flex items-center gap-1.5">
        <select aria-label={t.direct_folder} className={select} value={project?.id ?? ""} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {installed.length > 0 ? (
          <select aria-label={t.direct_agent} className={select} value={chosen?.type ?? ""} onChange={(e) => setAgent(e.target.value as TerminalType)}>
            {installed.map((a) => (
              <option key={a.type} value={a.type}>
                {a.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-[var(--text-secondary)]">{t.direct_no_agents}</span>
        )}
        <button
          type="button"
          onClick={start}
          disabled={!text.trim() || !chosen}
          aria-label={t.direct_start}
          title={t.direct_start}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg)] disabled:bg-[var(--surface-hover)] disabled:text-[var(--text-muted)]"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
