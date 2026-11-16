import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/useT";
import { useProjectStore } from "../stores/projectStore";
import { useNotificationStore } from "../stores/notificationStore";
import { activateWorktreeInScene, promptAndAddProjectToScene } from "../canvas/sceneCommands";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { useEditorItems } from "../editors/useEditorItems";
import { ContextMenu } from "../components/ContextMenu";
import { confirmAsync } from "../components/ui/confirmAsync";

/**
 * Every folder on this workdesk in one strip, with + to add another. A
 * folder's chip shows it; its menu opens a terminal there, opens it in an
 * editor, or removes it from the workdesk (the files stay). The Sessions
 * tree keeps the fuller actions (worktrees, delete from disk).
 */
export function FolderBar() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const editorItems = useEditorItems();
  const [menu, setMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  if (projects.length === 0) return null;
  const menuProject = menu ? projects.find((p) => p.id === menu.projectId) : undefined;

  const show = (projectId: string) => {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    const worktree = project?.worktrees[0];
    if (project && worktree) activateWorktreeInScene(project.id, worktree.id);
  };

  const remove = async (projectId: string) => {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    const terminals = project.worktrees.reduce((n, w) => n + w.terminals.length, 0);
    const ok = await confirmAsync({
      title: t.folder_remove_title(project.name),
      body:
        terminals > 0
          ? t.panel_project_remove_confirm_with_terminals(project.name, terminals)
          : t.panel_project_remove_confirm(project.name),
      confirmLabel: t.folder_remove_action,
      confirmTone: "danger",
      focusCancel: true,
    });
    if (!ok) return;
    useProjectStore.getState().removeProject(project.id);
    useNotificationStore.getState().notify("info", t.panel_project_removed(project.name));
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-3.5 pt-3" aria-label={t.folder_bar_label}>
      <span className="tc-eyebrow mr-1 shrink-0">{t.folder_bar_label}</span>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          title={project.path}
          onClick={() => show(project.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, projectId: project.id });
          }}
          className="group inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] pl-3 pr-1 text-[12px] text-[var(--text-primary)] hover:border-[var(--border-hover)]"
        >
          {project.name}
          <span
            role="button"
            tabIndex={0}
            aria-label={t.folder_menu(project.name)}
            title={t.folder_menu(project.name)}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4, projectId: project.id });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4, projectId: project.id });
            }}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => void promptAndAddProjectToScene(t)}
        aria-label={t.canvas_empty_action}
        title={t.canvas_empty_action}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {menu &&
        menuProject &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={[
              { label: t.folder_show, onClick: () => show(menuProject.id) },
              {
                label: t.panel_new_terminal,
                onClick: () => {
                  const worktree = menuProject.worktrees[0];
                  if (worktree) createTerminalInScene({ projectId: menuProject.id, worktreeId: worktree.id, type: "shell" });
                },
              },
              ...editorItems({ path: menuProject.path }),
              { type: "separator" as const },
              { label: t.folder_remove, danger: true, onClick: () => void remove(menuProject.id) },
            ]}
            onClose={() => setMenu(null)}
          />,
          document.body,
        )}
    </div>
  );
}
