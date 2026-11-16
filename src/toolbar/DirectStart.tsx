import { useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { useProjectStore } from "../stores/projectStore";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
import type { TerminalType } from "../types";
import { Dropdown } from "../components/ui/parts";

const AGENTS: { type: TerminalType; name: string }[] = [
  { type: "claude", name: "Claude Code" },
  { type: "codex", name: "Codex" },
  { type: "opencode", name: "OpenCode" },
  { type: "antigravity", name: "Antigravity" },
];

/**
 * With nobody in the seat, the panel's input still works: your first message
 * makes the chosen agent this workdesk's manager, in the chosen folder, and
 * the conversation carries on right here.
 */
export function DirectStart({
  onSend,
}: {
  onSend: (type: TerminalType, projectId: string, worktreeId: string, text: string) => void;
}) {
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
    onSend(chosen.type, project.id, worktree.id, prompt);
    setText("");
  };

  return (
    <div className="mx-3 mb-3 mt-auto flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] p-2.5 focus-within:border-[var(--border-hover)]">
      <div className="text-[11px] text-[var(--text-secondary)]">{t.direct_hint(chosen?.name ?? "")}</div>
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
        <Dropdown
          label={t.direct_folder}
          value={project?.id ?? ""}
          options={projects.map((p) => ({ value: p.id, label: p.name, detail: p.path }))}
          onChange={setProjectId}
        />
        {installed.length > 0 ? (
          <Dropdown
            label={t.direct_agent}
            value={(chosen?.type ?? "") as TerminalType}
            options={installed.map((a) => ({ value: a.type, label: t.direct_as_manager(a.name) }))}
            onChange={(next) => setAgent(next)}
          />
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
