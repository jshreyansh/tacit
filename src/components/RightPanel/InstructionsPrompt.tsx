import { useEffect, useState } from "react";
import { create } from "zustand";
import { useT } from "../../i18n/useT";
import { useNotificationStore } from "../../stores/notificationStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import type { ProjectInstructionFile, ProjectInstructionsStatus } from "../../../shared/project-instructions";

/**
 * This session's answers that aren't kept: Not now (asks again next launch),
 * and projects where the Git tab's Hydra button asked to see the prompt even
 * after Don't ask here.
 */
interface InstructionsPromptSession {
  later: string[];
  requested: string[];
  /** Bumped to re-read a project's status after something changed it. */
  revision: number;
  answerLater: (projectPath: string) => void;
  request: (projectPath: string) => void;
  settle: (projectPath: string) => void;
}

export const useInstructionsPromptStore = create<InstructionsPromptSession>((set) => ({
  later: [],
  requested: [],
  revision: 0,
  answerLater: (projectPath) =>
    set((state) => ({
      later: [...state.later, projectPath],
      requested: state.requested.filter((p) => p !== projectPath),
    })),
  request: (projectPath) =>
    set((state) => ({
      later: state.later.filter((p) => p !== projectPath),
      requested: state.requested.includes(projectPath) ? state.requested : [...state.requested, projectPath],
      revision: state.revision + 1,
    })),
  settle: (projectPath) =>
    set((state) => ({
      requested: state.requested.filter((p) => p !== projectPath),
      revision: state.revision + 1,
    })),
}));

function GitTag({ file }: { file: ProjectInstructionFile }) {
  const t = useT();
  if (file.git === null) return null;
  const label =
    file.git === "tracked"
      ? t.instructions_git_tracked
      : file.git === "ignored"
        ? t.instructions_git_ignored
        : t.instructions_git_untracked;
  return (
    <span
      className="shrink-0 rounded px-1 text-[10px]"
      style={{
        background: file.git === "tracked" ? "color-mix(in srgb, var(--amber) 14%, transparent)" : "var(--surface-hover)",
        color: file.git === "tracked" ? "var(--amber)" : "var(--text-muted)",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Asks whether agents in the panel's project should get Tacit's
 * instructions, saying exactly which files change and whether git tracks
 * them. Answers are per project. Never shown for the home folder.
 */
export function InstructionsPrompt({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const t = useT();
  const notify = useNotificationStore((s) => s.notify);
  const declined = usePreferencesStore((s) => s.instructionsDeclined.includes(projectPath));
  const declineInstructions = usePreferencesStore((s) => s.declineInstructions);
  const later = useInstructionsPromptStore((s) => s.later.includes(projectPath));
  const requested = useInstructionsPromptStore((s) => s.requested.includes(projectPath));
  const revision = useInstructionsPromptStore((s) => s.revision);
  const [status, setStatus] = useState<{ path: string; value: ProjectInstructionsStatus } | null>(null);
  const [busy, setBusy] = useState(false);

  const wanted = requested || (!declined && !later);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    window.tacit.project
      .instructionsStatus(projectPath)
      .then((value) => {
        if (!cancelled) setStatus({ path: projectPath, value });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(`[instructions] can't check ${projectPath}:`, error);
        setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, wanted, revision]);

  // The Git tab's button asked about a project that's already set up, or the home folder.
  useEffect(() => {
    if (!requested || !status || status.path !== projectPath) return;
    if (!status.value.offered) {
      notify("warn", t.instructions_home);
      useInstructionsPromptStore.getState().settle(projectPath);
    } else if (status.value.status === "current") {
      notify("info", t.instructions_current(projectName));
      useInstructionsPromptStore.getState().settle(projectPath);
    }
  }, [requested, status, projectPath, projectName, notify, t]);

  if (!wanted || !status || status.path !== projectPath) return null;
  const value = status.value;
  if (!value.offered || value.status === "current") return null;

  const outdated = value.status === "outdated";
  const title = outdated
    ? t.instructions_title_outdated(projectName)
    : value.workflows
      ? t.instructions_title_missing_workflows(projectName)
      : t.instructions_title_missing(projectName);
  const note = value.removesWorkflows
    ? t.instructions_removes_workflows
    : outdated
      ? t.instructions_outdated_body
      : value.workflows
        ? null
        : t.instructions_no_git;
  const tracked = value.files.some((file) => file.git === "tracked");

  const setUp = () => {
    setBusy(true);
    window.tacit.project
      .setUpInstructions(projectPath)
      .then((result) => {
        if (!result.ok) {
          notify("error", t.instructions_failed(result.error));
          return;
        }
        notify("info", result.changed ? t.instructions_done(projectName) : t.instructions_current(projectName));
        useInstructionsPromptStore.getState().settle(projectPath);
      })
      .catch((error: unknown) => {
        notify("error", t.instructions_failed(error instanceof Error ? error.message : String(error)));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="shrink-0 px-2 pb-2" data-testid="instructions-prompt">
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2.5">
        <span className="text-[12px] font-semibold leading-snug text-[var(--text-primary)]">{title}</span>
        {note && <span className="text-[11.5px] leading-snug text-[var(--text-secondary)]">{note}</span>}
        <div className="flex flex-col gap-1">
          {value.files.map((file) => (
            <div key={file.name} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="tc-mono shrink-0 text-[var(--text-primary)]">{file.name}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
                {file.name === "AGENTS.md" ? t.instructions_agents_file : t.instructions_claude_file}
              </span>
              <GitTag file={file} />
            </div>
          ))}
        </div>
        {tracked && (
          <span className="text-[11px] leading-snug" style={{ color: "var(--amber)" }}>
            {t.instructions_tracked_warning}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={setUp}
            className="rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--bg)" }}
          >
            {outdated ? t.instructions_update : t.instructions_enable}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => useInstructionsPromptStore.getState().answerLater(projectPath)}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            {t.instructions_later}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              declineInstructions(projectPath);
              useInstructionsPromptStore.getState().settle(projectPath);
            }}
            className="rounded-md px-2 py-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          >
            {t.instructions_never}
          </button>
        </div>
      </div>
    </div>
  );
}
