import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import {
  ConversationBody,
  PeekLine,
  useManagerConversation,
} from "./ProjectChatPanel";
import type { ManagerSessionRow } from "../../shared/manager-role";
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

/** Time for today's rows, date for older ones — a history list reads as "when". */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

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
  "You now have access to Tacit's workspace-manager tools: list_nodes, get_node_state, query_memory, get_workspace_summary, spawn_terminal, spawn_browser, spawn_note, connect_nodes, and log_activity.",
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
            // Qualified below via labelFor — kept raw here only as a fallback
            // for a terminal that has since disappeared from the store.
            label: terminal.customTitle || terminal.title || terminal.type,
          });
        }
      }
    }
    return list;
  }, [projects, workspaceManagerTerminalId]);

  /**
   * The pill sits directly above the dock, in the path the pointer takes all
   * day, so opening on a bare hover would flicker constantly. The delay is what
   * makes hover usable at all. Closing is immediate — a control that lingers
   * after you've left is worse than one that is slow to arrive.
   */
  const HOVER_OPEN_DELAY_MS = 220;

  const [managerMenuOpen, setManagerMenuOpen] = useState(false);
  const [height, setHeight] = useState<"rest" | "composer" | "full">("rest");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [history, setHistory] = useState<ManagerSessionRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<ManagerSessionRow | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Read from telemetry rather than the terminal record: the transcript path is
  // discovered after the agent starts, and telemetry is where that lands. Null
  // until then, which reads as "nothing said yet".
  const managerSessionFile = useTerminalRuntimeStore(
    (s) =>
      (managerTerminal
        ? s.terminals[managerTerminal.id]?.telemetry?.session_file
        : null) ?? null,
  );

  const isLive = viewing === null;
  const conversation = useManagerConversation(
    managerTerminal?.id ?? "",
    isLive ? managerSessionFile : (viewing?.sessionFile ?? null),
    isLive,
  );

  /**
   * Terminal label that means something. `title` is the CLI name, so two
   * claude terminals both read "claude" — the ambiguity that made the assign
   * menu unreadable. A renamed terminal uses its own name; an unrenamed one is
   * qualified by its worktree, exactly as connectionLabels does for the
   * disconnect dialog.
   */
  const labelFor = useCallback(
    (terminalId: string) => {
      for (const project of projects) {
        for (const worktree of project.worktrees) {
          const terminal = worktree.terminals.find((x) => x.id === terminalId);
          if (!terminal) continue;
          if (terminal.customTitle) return terminal.customTitle;
          const base = terminal.title || terminal.type;
          return worktree.name ? `${base} · ${worktree.name}` : base;
        }
      }
      return "";
    },
    [projects],
  );

  const managerLabel = managerTerminal ? labelFor(managerTerminal.id) : "";

  const openOnHover = useCallback(() => {
    if (!managerTerminal) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setHeight((h) => (h === "rest" ? "composer" : h));
    }, HOVER_OPEN_DELAY_MS);
  }, [managerTerminal]);

  const closeOnLeave = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    // Never collapse out from under work in progress: a half-typed message, a
    // focused input, an open menu, or the deliberately-opened full height all
    // mean the control is still in use.
    setHeight((h) => {
      if (h !== "composer") return h;
      if (draft.trim() || inputFocused || managerMenuOpen) return h;
      return "rest";
    });
  }, [draft, inputFocused, managerMenuOpen]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  // A role that no longer exists shouldn't leave a conversation on screen.
  useEffect(() => {
    if (!managerTerminal) setHeight("rest");
  }, [managerTerminal]);

  // Focus the input as soon as the control opens, so hovering and typing works
  // without an extra click.
  useEffect(() => {
    if (height !== "rest") inputRef.current?.focus();
  }, [height]);

  /**
   * Report whoever currently holds the role, not just changes to it.
   *
   * The tenure log only ever learned about handovers, so a manager assigned
   * before the log existed had no tenure and never appeared in history — and it
   * never would have, because no SessionStart fires for an agent that is
   * already running. Sending the session we already know closes that gap.
   * `setRole` dedupes by terminal, so this is a no-op once a tenure is open.
   */
  useEffect(() => {
    if (!managerTerminal) return;
    window.termcanvas.managerRole?.set({
      terminalId: managerTerminal.id,
      cli: managerTerminal.type,
      canvasId: activeCanvas?.id ?? null,
      sessionId: managerTerminal.sessionId ?? null,
      sessionFile: managerSessionFile,
    });
  }, [
    managerTerminal?.id,
    managerTerminal?.type,
    managerTerminal?.sessionId,
    managerSessionFile,
    activeCanvas?.id,
  ]);

  useEffect(() => {
    let cancelled = false;
    void window.termcanvas.managerRole
      .listSessions()
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        // An unreadable history is an empty menu, not a broken control.
      });
    return () => {
      cancelled = true;
    };
  }, [managerTerminal?.id, managerTerminal?.sessionId, managerSessionFile]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !managerTerminal) return;
    const ptyId = getLivePtyId(managerTerminal.id);
    const found = await waitForTerminalReady(managerTerminal.id);
    if (!found || ptyId == null) {
      useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
      return;
    }
    setSending(true);
    try {
      const result = await window.termcanvas.managerChat.send(
        {
          terminalId: managerTerminal.id,
          ptyId,
          terminalType: found.terminal.type,
          worktreePath: found.worktree.path,
        },
        text,
      );
      if (result.ok) setDraft("");
      else {
        useNotificationStore
          .getState()
          .notify("warn", result.detail ?? result.error ?? t.project_chat_send_failed);
      }
    } finally {
      setSending(false);
    }
  }, [draft, sending, managerTerminal, t]);

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

  /** Terminal record by id, across every project — used for the handover notice. */
  const findTerminalById = useCallback(
    (terminalId: string) => {
      for (const project of projects) {
        for (const worktree of project.worktrees) {
          const terminal = worktree.terminals.find((x) => x.id === terminalId);
          if (terminal) return terminal;
        }
      }
      return null;
    },
    [projects],
  );

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
      const outgoing = managerTerminal;
      useCanvasRegistryStore
        .getState()
        .setWorkspaceManager(activeCanvas.id, terminalId);
      closeManagerMenu();
      if (terminalId) {
        // Say plainly whether the conversation survives the handover. Two
        // agents of the same CLI read the same transcript format, so it does;
        // across CLIs it cannot, and the new holder picks up from the journal
        // instead. Silence here would leave the user to discover which of the
        // two they got by noticing the new agent knows nothing.
        const incoming = findTerminalById(terminalId);
        if (outgoing && incoming && outgoing.id !== incoming.id) {
          const carries = outgoing.type === incoming.type;
          useNotificationStore
            .getState()
            .notify(
              "info",
              carries
                ? t.project_chat_handover_keeps
                : t.project_chat_handover_drops(
                    AGENT_DISPLAY_NAME[outgoing.type as WorkspaceManagerAgentType] ??
                      outgoing.type,
                    AGENT_DISPLAY_NAME[incoming.type as WorkspaceManagerAgentType] ??
                      incoming.type,
                  ),
            );
        }
        void sendWorkspaceManagerBriefing(terminalId);
      }
    },
    [activeCanvas, closeManagerMenu, sendWorkspaceManagerBriefing, managerTerminal, t],
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
  /**
   * One control, three heights — see docs and the redesign proposal.
   *
   * Before this, the conversation was a detached box floating above a separate
   * pill: two objects for one thing, with two identical-looking chevrons where
   * one reassigned the agent and the other opened the conversation. Now the
   * pill IS the control and only ever grows upward from the same spot, so it
   * reads as the thing you were already looking at, opening.
   */
  const showChat = managerTerminal !== null && height !== "rest";
  const isFull = showChat && height === "full";

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[95] pointer-events-none"
      style={{
        bottom: `calc(${bottomOffset} + ${ADD_NODE_DOCK_HEIGHT_PX + PILL_GAP_ABOVE_DOCK_PX}px)`,
      }}
    >
      <div
        ref={managerWrapperRef}
        // No overflow-hidden: the assign and history menus are absolutely
        // positioned children, and clipping them to the control's rounded box
        // made them vanish entirely rather than merely crop. The scrolling
        // conversation does its own clipping, which is the only child that
        // needed it.
        className={`pointer-events-auto relative mx-auto flex flex-col rounded-xl ${PILL_GLASS}`}
        style={{
          width: showChat ? "min(34rem, calc(100vw - 2rem))" : undefined,
          maxHeight: isFull ? "min(30rem, 55vh)" : undefined,
        }}
        onMouseEnter={openOnHover}
        onMouseLeave={closeOnLeave}
        onKeyDown={(e) => {
          if (e.key === "Escape" && height !== "rest") {
            e.stopPropagation();
            setHeight("rest");
          }
          // ⌘↑ / ⌘↓ walk the ladder, so one shortcut covers the whole range.
          if (e.metaKey && e.key === "ArrowUp") {
            e.preventDefault();
            setHeight(height === "full" ? "full" : "full");
          }
          if (e.metaKey && e.key === "ArrowDown") {
            e.preventDefault();
            setHeight(height === "full" ? "composer" : "rest");
          }
        }}
      >
        {/* Config row — only at full height. The agent picker lives here now
            rather than as a second chevron beside the label, where it was
            indistinguishable from the one that opened the conversation. */}
        {isFull && managerTerminal && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
            <img
              src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
              alt=""
              className="h-4 w-4 shrink-0 rounded object-cover"
            />
            <button
              className="tc-mono truncate text-left text-[var(--text-primary)] hover:underline"
              style={{ fontSize: "var(--text-xs)" }}
              onClick={flyToManager}
              title={t.project_chat_go_to}
            >
              {managerLabel}
            </button>
            <button
              ref={managerTriggerRef}
              className="tc-mono shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              style={{ fontSize: "var(--text-xs)" }}
              onClick={toggleManagerMenu}
              aria-haspopup="menu"
              aria-expanded={managerMenuOpen}
            >
              {t.project_chat_change} ▾
            </button>
            <span className="flex-1" />
            {history.length > 0 && (
              <button
                className="tc-mono shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                style={{ fontSize: "var(--text-xs)" }}
                onClick={() => setHistoryOpen((v) => !v)}
                aria-expanded={historyOpen}
              >
                {t.project_chat_history} ▾
              </button>
            )}
            <button
              className="shrink-0 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
              onClick={() => setHeight("rest")}
              aria-label={t.close}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {isFull && conversation && (
          <ConversationBody conversation={conversation} isLive={viewing === null} />
        )}

        {/* Peek — the one line that makes the composer height usable alone.
            Hidden at full height, where the conversation says the same thing
            with more room. */}
        {showChat && !isFull && conversation && (
          <PeekLine conversation={conversation} />
        )}

        {/* The resting pill. Its own row so the label keeps its position as the
            control grows — nothing jumps when a height changes. */}
        {!showChat && (
          <div className="flex items-center">
            <button
              className={labelButtonCls}
              onClick={() => (managerTerminal ? setHeight("composer") : toggleManagerMenu())}
              title={managerTerminal ? t.project_chat_show : t.project_chat_unassigned}
            >
              {managerTerminal && (
                <img
                  src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
                  alt=""
                  className="h-5 w-5 rounded object-cover"
                />
              )}
              <span>
                {managerTerminal
                  ? `${t.project_chat_label} · ${managerLabel}`
                  : t.project_chat_unassigned}
              </span>
            </button>
            {!managerTerminal && (
              <button
                ref={managerTriggerRef}
                className={triggerButtonCls}
                onClick={toggleManagerMenu}
                aria-haspopup="menu"
                aria-expanded={managerMenuOpen}
                title={t.project_chat_assign}
                aria-label={t.project_chat_assign}
              >
                <span className="text-[18px] leading-none font-normal">+</span>
              </button>
            )}
          </div>
        )}

        {/* Input — rendered in the same slot at both heights so switching
            between them never unmounts it and loses a half-typed message. */}
        {showChat && (
          <div className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] px-3 py-2">
            <span
              className="tc-mono shrink-0 pb-1"
              style={{ fontSize: "var(--text-xs)", color: "var(--cyan)" }}
            >
              ›
            </span>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                // The canvas listens globally for single-key shortcuts.
                e.stopPropagation();
              }}
              placeholder={t.project_chat_placeholder}
              className="max-h-24 min-h-[1.5rem] flex-1 resize-none bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
              style={{ fontSize: "var(--text-sm)" }}
            />
            <button
              className="tc-mono shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              style={{ fontSize: "var(--text-xs)" }}
              onClick={() => setHeight(isFull ? "composer" : "full")}
              title={isFull ? t.project_chat_collapse : t.project_chat_expand}
              aria-label={isFull ? t.project_chat_collapse : t.project_chat_expand}
            >
              {isFull ? "⌘↓" : "⌘↑"}
            </button>
          </div>
        )}

        {/* History — only conversations that held the role, which is what the
            tenure log exists to make knowable. */}
        {historyOpen && isFull && (
          <div className="absolute right-2 top-10 z-10 max-h-64 w-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
            {history.map((row) => (
              <button
                key={row.sessionId}
                type="button"
                disabled={!row.sessionFile}
                onClick={() => {
                  setViewing(row.isCurrent ? null : row);
                  setHistoryOpen(false);
                }}
                className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
                style={{ fontSize: "var(--text-xs)" }}
              >
                <span className="tc-mono truncate text-[var(--text-secondary)]">
                  {row.cli ?? "agent"}
                  {row.isCurrent && (
                    <span style={{ color: "var(--cyan)" }}> · {t.project_chat_now}</span>
                  )}
                </span>
                <span className="tc-mono shrink-0 tabular-nums text-[var(--text-faint)]">
                  {formatWhen(row.startedAt)}
                </span>
              </button>
            ))}
          </div>
        )}

        {managerMenuOpen && (
          <div
            ref={managerPopoverRef}
            role="menu"
            aria-label={t.project_chat_assign}
            // Anchored to whichever trigger opened it. At rest that is the
            // pill, so the menu rises above it; at full height the trigger sits
            // in the config row at the TOP of a tall panel, where rising would
            // put the menu off the top of the screen.
            className={`absolute z-20 min-w-[220px] rounded-md py-1 ${
              isFull
                ? "left-2 top-11"
                : "bottom-full left-1/2 -translate-x-1/2 mb-2"
            } ${PILL_GLASS}`}
          >
            {(managerTerminal || eligibleManagerTerminals.length > 0) && (
              <div className="tc-eyebrow tc-mono px-3 pb-1 pt-1.5">
                {t.project_chat_running_now}
              </div>
            )}
            {/* The current holder, listed but not selectable — picking it would
                be a no-op, and leaving it out of the list made the menu read as
                if it were offering the only options that exist. */}
            {managerTerminal && (
              <div className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)]">
                <span className="flex min-w-0 items-center gap-2">
                  <img
                    src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded object-cover"
                  />
                  <span className="truncate">{managerLabel}</span>
                </span>
                <span className="tc-mono shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                  {t.project_chat_holding}
                </span>
              </div>
            )}
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
                  <img src={AGENT_ICON[term.type]} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
                  <span className="truncate">{labelFor(term.id) || term.label}</span>
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {AGENT_DISPLAY_NAME[term.type]}
                </span>
              </button>
            ))}
            {eligibleManagerTerminals.length > 0 && (
              <div className="my-1 h-px bg-[var(--border)] opacity-60" />
            )}
            <div className="tc-eyebrow tc-mono px-3 pb-1">
              {t.project_chat_start_new}
            </div>
            {WORKSPACE_MANAGER_AGENT_TYPES.map((type) => (
              <button
                key={type}
                data-popover-item
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                onClick={() => spawnAndAssignManager(type)}
              >
                <img src={AGENT_ICON[type]} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
                <span>{AGENT_DISPLAY_NAME[type]}</span>
              </button>
            ))}
            {managerTerminal && (
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
