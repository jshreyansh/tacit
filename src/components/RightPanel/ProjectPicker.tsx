import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import type { ProjectData, WorktreeData } from "../../types";
import { displayFolderPath, projectMainWorktree } from "./panelProject";

function homePath(): string {
  return window.tacit?.app.homePath ?? "";
}

/**
 * Names the project the side panel is showing, so its files are never a
 * guess, with a switcher when the workdesk has more than one project.
 */
export function PanelProjectHeader({
  project,
  worktree,
  projects,
  onPick,
}: {
  project: ProjectData;
  worktree: WorktreeData;
  projects: ProjectData[];
  onPick: (worktreeId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMain = projectMainWorktree(project)?.id === worktree.id;
  const canSwitch = projects.length > 1;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = (
    <>
      <span className="shrink-0 truncate text-[12px] font-semibold text-[var(--text-primary)]">
        {project.name}
        {!isMain && <span className="font-medium text-[var(--text-muted)]"> · {worktree.name}</span>}
      </span>
      <span className="tc-mono min-w-0 flex-1 truncate text-left text-[11px] text-[var(--text-muted)]">
        {displayFolderPath(worktree.path, homePath())}
      </span>
    </>
  );

  return (
    <div className="relative shrink-0 px-2 pb-1.5" ref={menuRef} data-testid="panel-project">
      {canSwitch ? (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--surface-hover)]"
          onClick={() => setOpen((value) => !value)}
          aria-label={t.panel_project_switch}
          aria-haspopup="menu"
          aria-expanded={open}
          title={worktree.path}
        >
          {label}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0 text-[var(--text-faint)]">
            <path d="M2.2 3.5L5 6.3L7.8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-2 py-1" title={worktree.path}>
          {label}
        </div>
      )}
      {open && (
        <div
          role="menu"
          className="absolute left-2 right-2 top-full z-20 mt-0.5 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)] shadow-lg"
        >
          {projects.map((candidate) => {
            const main = projectMainWorktree(candidate);
            if (!main) return null;
            const current = candidate.id === project.id;
            return (
              <button
                key={candidate.id}
                type="button"
                role="menuitem"
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                onClick={() => {
                  onPick(main.id);
                  setOpen(false);
                }}
              >
                <span className={`shrink-0 truncate text-[12px] ${current ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                  {candidate.name}
                </span>
                <span className="tc-mono min-w-0 flex-1 truncate text-[11px] text-[var(--text-faint)]">
                  {displayFolderPath(main.path, homePath())}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Several projects and none chosen yet: ask, rather than guess. */
export function PanelProjectChooser({
  projects,
  onPick,
}: {
  projects: ProjectData[];
  onPick: (worktreeId: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4" data-testid="panel-project-chooser">
      <span className="text-center text-[12px] text-[var(--text-secondary)]">{t.panel_choose_title}</span>
      <div className="flex w-full max-w-[260px] flex-col gap-1.5">
        {projects.map((project) => {
          const main = projectMainWorktree(project);
          if (!main) return null;
          return (
            <button
              key={project.id}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-left hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
              onClick={() => onPick(main.id)}
            >
              <span className="shrink-0 truncate text-[12px] font-medium text-[var(--text-primary)]">{project.name}</span>
              <span className="tc-mono min-w-0 flex-1 truncate text-[11px] text-[var(--text-faint)]">
                {displayFolderPath(main.path, homePath())}
              </span>
            </button>
          );
        })}
      </div>
      <span className="text-[11px] text-[var(--text-muted)]">{t.panel_choose_hint}</span>
    </div>
  );
}

/** A workdesk with no folders: say so, and offer to add one. */
export function PanelNoProjects({ onAddFolder }: { onAddFolder: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4" data-testid="panel-no-projects">
      <span className="text-center text-[12px] text-[var(--text-secondary)]">{t.panel_empty_title}</span>
      <button
        type="button"
        className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
        onClick={onAddFolder}
      >
        {t.panel_add_folder}
      </button>
    </div>
  );
}
