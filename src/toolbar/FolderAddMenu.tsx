import { useRef, useState } from "react";
import { useT } from "../i18n/useT";
import type { ProjectData } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useNotificationStore } from "../stores/notificationStore";
import { NewAgentTiles, PickerHeading, PickerPopover } from "../agents/AgentPicker";
import { DockIcon, dockEntry, startWorker, type WorkerFolder } from "./dockEntries";

/**
 * A folder's +: start things where they belong. A new chat with one of the
 * agents, a terminal, or a worktree (for a git folder); whatever
 * starts opens in that folder, on the canvas and in the navigator.
 */
export function FolderAddMenu({ project, git }: { project: ProjectData; git: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const primary = project.worktrees.find((w) => w.isPrimary) ?? project.worktrees[0];
  const where: WorkerFolder | null = primary ? { projectId: project.id, worktreeId: primary.id, label: project.name } : null;

  const close = () => {
    setOpen(false);
    setNaming(false);
    setBranch("");
  };

  const run = (fn: () => void) => {
    close();
    fn();
  };
  const createWorktree = async () => {
    const name = branch.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const result = await window.tacit.project.createWorktree(project.path, name);
      if (result.ok) {
        useProjectStore.getState().syncWorktrees(project.path, result.worktrees);
        useNotificationStore.getState().notify("info", t.panel_worktree_created(name));
        close();
      } else {
        useNotificationStore.getState().notify("error", t.panel_worktree_create_failed(result.error));
      }
    } catch (error) {
      useNotificationStore.getState().notify("error", t.panel_worktree_create_failed(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`tc-sq-sm absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center text-[var(--text-muted)] transition-opacity duration-quick hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 ${open ? "bg-[var(--surface-hover)] opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t.nav_folder_add(project.name)}
        aria-label={t.nav_folder_add(project.name)}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {open && where && buttonRef.current && (
        <PickerPopover
          anchor={buttonRef.current}
          role={naming ? "dialog" : "menu"}
          label={t.nav_folder_add(project.name)}
          width={336}
          onClose={(refocus) => {
            close();
            if (refocus) buttonRef.current?.focus();
          }}
          onEscape={() => {
            if (naming) setNaming(false);
            return naming;
          }}
        >
            {naming ? (
              <div className="flex flex-col gap-2 p-1.5">
                <label className="flex flex-col gap-1.5 px-1">
                  <span className="text-[11.5px] text-[var(--text-muted)]">{t.nav_new_worktree_branch(project.name)}</span>
                  <input
                    autoFocus
                    value={branch}
                    disabled={busy}
                    placeholder={t.panel_branch_name_placeholder}
                    onChange={(e) => setBranch(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void createWorktree();
                      } else if (e.key === "Escape") setNaming(false);
                    }}
                    className="tc-sq-ctl h-9 bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 text-[13px] text-[var(--text-primary)] outline-none"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-hover)" }}
                  />
                </label>
                <div className="flex items-center gap-1.5 px-1 pb-0.5">
                  <button type="button" className="tc-sq-ctl h-8 px-2.5 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setNaming(false)}>
                    {t.cancel}
                  </button>
                  <span className="flex-1" />
                  <button
                    type="button"
                    disabled={!branch.trim() || busy}
                    className="tc-sq-ctl h-8 px-3 text-[12.5px] font-medium disabled:opacity-50"
                    style={{ background: "var(--text-primary)", color: "var(--bg)" }}
                    onClick={() => void createWorktree()}
                  >
                    {busy ? "…" : t.nav_create}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <PickerHeading>{t.nav_start_in(project.name)}</PickerHeading>
                <NewAgentTiles role="menuitem" actionLabel={t.nav_new_chat_with} onPick={(entry) => run(() => startWorker(entry, where))} />
                <div className="tc-ap-rule" />
                <button type="button" role="menuitem" data-pick="" className="tc-ap-row" onClick={() => run(() => startWorker(dockEntry("shell"), where))}>
                  <span className="tc-ap-mark">
                    <DockIcon art={dockEntry("shell").art} scale={0.62} />
                  </span>
                  <span className="flex-1">{t.nav_new_terminal}</span>
                </button>
                {git && (
                  <button type="button" role="menuitem" data-pick="" className="tc-ap-row" onClick={() => setNaming(true)}>
                    <span className="tc-ap-mark text-[var(--text-secondary)]">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                        <circle cx="5" cy="3.5" r="1.5" />
                        <circle cx="5" cy="12.5" r="1.5" />
                        <circle cx="11" cy="5.5" r="1.5" />
                        <path d="M5 5v6M11 7c0 2.5-6 2-6 4" />
                      </svg>
                    </span>
                    <span className="flex-1">{t.nav_new_worktree}</span>
                  </button>
                )}
              </>
            )}
        </PickerPopover>
      )}
    </>
  );
}
