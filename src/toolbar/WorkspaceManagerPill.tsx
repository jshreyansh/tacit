import { useCallback, useMemo, useRef, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { waitForTerminalReady } from "../actions/sceneConnectionActions";
import { getLivePtyId } from "../actions/terminalLookup";
import { useNotificationStore } from "../stores/notificationStore";
import { flyToBounds } from "../utils/panToTerminal";
import {
  PILL_GLASS,
  useCloseOnOutsideClick,
  useComposerBottomOffset,
  usePopoverKeyboardNav,
} from "./BottomToolbar";
import { ADD_NODE_DOCK_HEIGHT_PX } from "./AddNodeDock";
import { useT } from "../i18n/useT";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";

// Gap above AddNodeDock, matching the visual spacing between October's
// "Project chat" pill and its dock beneath it.
const PILL_GAP_ABOVE_DOCK_PX = 10;

// Sized larger than BottomToolbar's own buttonBase/iconButton (h-8) —
// deliberately local, not shared, since this pill is the one prominent
// "where do I talk to my workspace manager" affordance and reads better
// bigger, while the zoom/Fit/Focus pill stays compact utility chrome.
const labelButtonCls =
  "inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium text-[var(--text-secondary)] transition-[color,background-color,transform] duration-quick hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] active:scale-[0.98] focus-visible:outline-none motion-reduce:transition-none disabled:opacity-60 disabled:pointer-events-none";
const triggerButtonCls =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-[color,background-color,transform] duration-quick hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] active:scale-[0.94] focus-visible:outline-none motion-reduce:transition-none";

// Agent types that can actually hold a Hydra role, per
// hydra/src/roles/builtin/lead.md and docs/workspace_project_manager.md —
// Lazygit/Shell terminals aren't agent loops, so they're not eligible for
// the workspace manager role.
const WORKSPACE_MANAGER_AGENT_TYPES = ["claude", "codex", "gemini"] as const;
type WorkspaceManagerAgentType = (typeof WORKSPACE_MANAGER_AGENT_TYPES)[number];
const AGENT_DISPLAY_NAME: Record<WorkspaceManagerAgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};
// Same icon assets AddNodeDock.tsx already uses — reused here, not
// duplicated, so the two places you pick an agent stay visually consistent.
const AGENT_ICON: Record<WorkspaceManagerAgentType, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
};

// One-time briefing injected into a terminal the moment it's assigned the
// workspace-manager role — this is what makes "swap the underlying agent,
// it picks up context" real: the new holder is told to read the
// continuity journal via get_workspace_summary rather than starting cold.
// Deliberately doesn't state a raw memory directory path — the MCP tools
// resolve that internally, so the agent never needs to know it.
const WORKSPACE_MANAGER_BRIEFING = [
  "You've been assigned the workspace manager role for this canvas.",
  "You now have access to termcanvas-bridge's workspace-manager tools: list_nodes, get_node_state, query_memory, get_workspace_summary, spawn_terminal, spawn_browser, spawn_note, connect_nodes, and log_activity.",
  "Start by calling get_workspace_summary — it returns what's already on this canvas plus the most recent entries from the workspace's continuity journal, written by anyone who held this role before you (including a past version of you, if you're being reassigned back after being swapped out).",
  "Call log_activity after spawning/wiring nodes or making a real decision, so a future agent who picks up this role — even a different underlying CLI — can actually pick up where you left off instead of starting cold.",
].join(" ");

/**
 * "Project chat" pill — pinned, always-locatable affordance for the
 * workspace-manager role (see docs/workspace_project_manager.md's Form
 * Factor section). A sibling to BottomToolbar and AddNodeDock, not merged
 * into either — same reasoning AddNodeDock's own file already documents:
 * independent pills are lower risk than reworking a tested file's layout,
 * and this one specifically needs to float centered *above* AddNodeDock
 * (October's own layout), not share either pill's row.
 *
 * Phase 1: no inline typing here, clicking the label flies to the assigned
 * terminal's real card instead — see the design doc for why.
 */
export function WorkspaceManagerPill() {
  const t = useT();
  const bottomOffset = useComposerBottomOffset();

  const projects = useProjectStore((s) => s.projects);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const activeCanvas =
    canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  const workspaceManagerTerminalId =
    activeCanvas?.workspaceManagerTerminalId ?? null;

  const managerTerminal = useMemo(() => {
    if (!workspaceManagerTerminalId) return null;
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const terminal = worktree.terminals.find(
          (term) => term.id === workspaceManagerTerminalId,
        );
        if (terminal) return terminal;
      }
    }
    return null;
  }, [projects, workspaceManagerTerminalId]);

  const eligibleManagerTerminals = useMemo(() => {
    const list: Array<{ id: string; type: WorkspaceManagerAgentType; label: string }> = [];
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        for (const terminal of worktree.terminals) {
          if (terminal.stashed) continue;
          if (terminal.id === workspaceManagerTerminalId) continue;
          if (
            !(WORKSPACE_MANAGER_AGENT_TYPES as readonly string[]).includes(
              terminal.type,
            )
          )
            continue;
          list.push({
            id: terminal.id,
            type: terminal.type as WorkspaceManagerAgentType,
            label: terminal.customTitle || terminal.title || terminal.type,
          });
        }
      }
    }
    return list;
  }, [projects, workspaceManagerTerminalId]);

  const [managerMenuOpen, setManagerMenuOpen] = useState(false);
  const managerWrapperRef = useRef<HTMLDivElement>(null);
  const managerPopoverRef = useRef<HTMLDivElement>(null);
  const managerTriggerRef = useRef<HTMLButtonElement>(null);
  const closeManagerMenu = useCallback(() => setManagerMenuOpen(false), []);
  const toggleManagerMenu = useCallback(
    () => setManagerMenuOpen((prev) => !prev),
    [],
  );
  useCloseOnOutsideClick(managerMenuOpen, managerWrapperRef, closeManagerMenu);
  usePopoverKeyboardNav({
    open: managerMenuOpen,
    popoverRef: managerPopoverRef,
    triggerRef: managerTriggerRef,
    itemCount:
      eligibleManagerTerminals.length +
      WORKSPACE_MANAGER_AGENT_TYPES.length +
      (workspaceManagerTerminalId ? 1 : 0),
    close: closeManagerMenu,
  });

  const sendWorkspaceManagerBriefing = useCallback(
    async (terminalId: string) => {
      const found = await waitForTerminalReady(terminalId);
      const ptyId = found ? getLivePtyId(terminalId) : null;
      if (!found || ptyId == null) {
        useNotificationStore
          .getState()
          .notify(
            "warn",
            "Couldn't brief the new workspace manager — its shell process isn't ready yet. It still has the role; just ask it to call get_workspace_summary directly.",
          );
        return;
      }
      const result = await window.termcanvas.browser.notifyWired(
        {
          terminalId,
          ptyId,
          terminalType: found.terminal.type,
          worktreePath: found.worktree.path,
        },
        WORKSPACE_MANAGER_BRIEFING,
      );
      if (!result.ok) {
        useNotificationStore
          .getState()
          .notify(
            "warn",
            `Couldn't brief the new workspace manager: ${result.detail ?? result.error}. It still has the role; just ask it to call get_workspace_summary directly.`,
          );
      }
    },
    [],
  );

  const assignWorkspaceManager = useCallback(
    (terminalId: string | null) => {
      if (!activeCanvas) return;
      useCanvasRegistryStore
        .getState()
        .setWorkspaceManager(activeCanvas.id, terminalId);
      closeManagerMenu();
      if (terminalId) {
        void sendWorkspaceManagerBriefing(terminalId);
      }
    },
    [activeCanvas, closeManagerMenu, sendWorkspaceManagerBriefing],
  );

  const spawnAndAssignManager = useCallback(
    (type: WorkspaceManagerAgentType) => {
      const {
        focusedProjectId,
        focusedWorktreeId,
        projects: currentProjects,
      } = useProjectStore.getState();
      let projectId = focusedProjectId;
      let worktreeId = focusedWorktreeId;
      if (!projectId || !worktreeId) {
        // No terminal has been focused this session (common right after
        // launch, before you've clicked into anything) — currentProjects[0]
        // is raw array/insertion order, not a meaningful signal, and can
        // land on a stale scratch project that happens to sit first in the
        // list. Prefer the worktree with the most real (non-stashed)
        // terminal activity instead — the best available proxy for "where
        // the user is actually working" when nothing is explicitly focused.
        let best: { projectId: string; worktreeId: string; count: number } | null =
          null;
        for (const project of currentProjects) {
          for (const worktree of project.worktrees) {
            const count = worktree.terminals.filter((t) => !t.stashed).length;
            if (!best || count > best.count) {
              best = { projectId: project.id, worktreeId: worktree.id, count };
            }
          }
        }
        if (!best) return;
        projectId = best.projectId;
        worktreeId = best.worktreeId;
      }
      const terminal = createTerminalInScene({ projectId, worktreeId, type });
      assignWorkspaceManager(terminal.id);
    },
    [assignWorkspaceManager],
  );

  const flyToManager = useCallback(() => {
    if (!managerTerminal) return;
    flyToBounds(
      managerTerminal.x,
      managerTerminal.y,
      managerTerminal.width,
      managerTerminal.height,
    );
  }, [managerTerminal]);

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[95] pointer-events-none"
      style={{
        bottom: `calc(${bottomOffset} + ${ADD_NODE_DOCK_HEIGHT_PX + PILL_GAP_ABOVE_DOCK_PX}px)`,
      }}
    >
      <div
        className={`pointer-events-auto relative inline-flex items-center gap-1 rounded-xl px-1.5 py-1.5 ${PILL_GLASS}`}
        ref={managerWrapperRef}
      >
        <button
          className={labelButtonCls}
          onClick={flyToManager}
          disabled={!managerTerminal}
          title={
            managerTerminal ? t.project_chat_go_to : t.project_chat_unassigned
          }
        >
          {managerTerminal && (
            <img
              src={
                AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]
              }
              alt=""
              className="h-5 w-5 rounded object-cover"
            />
          )}
          <span>
            {managerTerminal
              ? `${t.project_chat_label} · ${
                  AGENT_DISPLAY_NAME[
                    managerTerminal.type as WorkspaceManagerAgentType
                  ] ?? managerTerminal.type
                }`
              : t.project_chat_unassigned}
          </span>
        </button>
        <button
          ref={managerTriggerRef}
          className={triggerButtonCls}
          onClick={toggleManagerMenu}
          aria-haspopup="menu"
          aria-expanded={managerMenuOpen}
          title={t.project_chat_assign}
          aria-label={t.project_chat_assign}
        >
          {managerTerminal ? (
            // Assigned: a real choice to make (reassign to another agent,
            // or unassign) — the dropdown chevron is the right affordance.
            <span className="text-[11px] leading-none">▾</span>
          ) : (
            // Unassigned: there's nothing to "drop down" to yet — a plus
            // reads as "create/assign one" far more intuitively than an
            // empty-feeling chevron.
            <span className="text-[18px] leading-none font-normal">+</span>
          )}
        </button>
        {managerMenuOpen && (
          <div
            ref={managerPopoverRef}
            role="menu"
            aria-label={t.project_chat_assign}
            className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 min-w-[200px] rounded-md py-1 ${PILL_GLASS}`}
          >
            {eligibleManagerTerminals.map((term) => (
              <button
                key={term.id}
                data-popover-item
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                onClick={() => assignWorkspaceManager(term.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <img
                    src={AGENT_ICON[term.type]}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded object-cover"
                  />
                  <span className="truncate">{term.label}</span>
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {AGENT_DISPLAY_NAME[term.type]}
                </span>
              </button>
            ))}
            {eligibleManagerTerminals.length > 0 && (
              <div className="my-1 h-px bg-[var(--border)] opacity-60" />
            )}
            {WORKSPACE_MANAGER_AGENT_TYPES.map((type) => (
              <button
                key={type}
                data-popover-item
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                onClick={() => spawnAndAssignManager(type)}
              >
                <img
                  src={AGENT_ICON[type]}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded object-cover"
                />
                <span>+ New {AGENT_DISPLAY_NAME[type]}</span>
              </button>
            ))}
            {workspaceManagerTerminalId && (
              <>
                <div className="my-1 h-px bg-[var(--border)] opacity-60" />
                <button
                  data-popover-item
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                  onClick={() => assignWorkspaceManager(null)}
                >
                  {t.project_chat_remove}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
