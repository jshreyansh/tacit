import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import {
  ConversationBody,
  PeekLine,
  useManagerConversation,
} from "./ProjectChatPanel";
import {
  WORKSPACE_MANAGER_BRIEFING,
  type ManagerSessionRow,
} from "../../shared/manager-role";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { waitForTerminalReady } from "../actions/sceneConnectionActions";
import { getLivePtyId } from "../actions/terminalLookup";
import { useNotificationStore } from "../stores/notificationStore";
import { flyToBounds } from "../utils/panToTerminal";
import { PILL_GLASS, useComposerBottomOffset } from "./pillChrome";
import { useT } from "../i18n/useT";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";

/**
 * How long a tenure ran. The log records start and end, and "held it for 6h" is
 * what a reader actually wants from that pair — a bare pair of timestamps makes
 * them do the subtraction.
 */
function formatHeld(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const minutes = Math.max(1, Math.round((end - start) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

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
// Same icon assets the left rail already uses — reused here, not duplicated,
// so the two places you pick an agent stay visually consistent.
const AGENT_ICON: Record<WorkspaceManagerAgentType, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
};
/**
 * The lit edge along the top of the expanded seat is mixed with whoever holds
 * it. Hues are sampled from each agent's own mark rather than assigned, so a
 * handover is visible without anything announcing it.
 */
const AGENT_HUE: Record<WorkspaceManagerAgentType, string> = {
  claude: "#d98b6f",
  codex: "#7b7ce8",
  gemini: "#6ea6f5",
};


/**
 * "Project chat" pill — pinned, always-locatable affordance for the
 * workspace-manager role (see docs/workspace_project_manager.md's Form
 * Factor section). A sibling to BottomToolbar, not merged into it:
 * independent pills are lower risk than reworking a tested file's layout,
 * and this one specifically needs to float centered above the composer, not
 * share the zoom pill's row.
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

  /**
   * Which face the seat is showing.
   *
   * Roster and history used to be popovers anchored inside the panel, which
   * put them off the bottom of the window — the panel is anchored to the
   * bottom of the screen, so anything hanging below it is clipped by
   * construction. They are faces now: one shell, contents swapped, a back
   * button to return. Nothing can be positioned off-screen because nothing is
   * positioned at all.
   */
  const [view, setView] = useState<"chat" | "roster" | "history">("chat");
  const [height, setHeight] = useState<"rest" | "composer" | "full">("rest");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [history, setHistory] = useState<ManagerSessionRow[]>([]);

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

  /** Drives the breathing ring on the avatar. A collapsed control that only
   *  sits there is wasted; this is the cheapest way to make it report. */
  const managerWorking = useTerminalRuntimeStore((s) => {
    if (!managerTerminal) return false;
    const turn = s.terminals[managerTerminal.id]?.telemetry?.turn_state;
    return (
      turn === "in_turn" ||
      turn === "thinking" ||
      turn === "tool_running" ||
      turn === "tool_pending"
    );
  });

  const isLive = viewing === null;

  /**
   * When the conversation on screen took the seat.
   *
   * Read from the tenure log rather than the transcript, so it is there the
   * moment a role is assigned — the transcript has nothing in it until the
   * agent takes its first turn, which is exactly the window where the panel
   * used to claim nothing had been said.
   */
  const handoverRow = viewing ?? history.find((row) => row.isCurrent) ?? null;

  /**
   * Whose conversation is on screen — the current holder, or the predecessor
   * whose session you opened from History.
   */
  const speakingCli = viewing
    ? viewing.cli
    : (managerTerminal?.type ?? null);
  const speakingHue =
    speakingCli && speakingCli in AGENT_HUE
      ? AGENT_HUE[speakingCli as WorkspaceManagerAgentType]
      : undefined;
  const speakingIcon =
    speakingCli && speakingCli in AGENT_ICON
      ? AGENT_ICON[speakingCli as WorkspaceManagerAgentType]
      : null;
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
      if (draft.trim() || inputFocused || view !== "chat") return h;
      return "rest";
    });
  }, [draft, inputFocused, view]);

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
    window.tacit.managerRole?.set({
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
    void window.tacit.managerRole
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
    // Never while reading an archive. The composer is replaced in that state,
    // but the guard belongs here too: `send` targets whoever holds the seat
    // now, so a stray Enter would deliver your message to an agent that has
    // never seen the conversation on screen — and put its reply in a thread you
    // are not looking at.
    if (viewing) return;
    const ptyId = getLivePtyId(managerTerminal.id);
    const found = await waitForTerminalReady(managerTerminal.id);
    if (!found || ptyId == null) {
      useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
      return;
    }
    setSending(true);
    try {
      const result = await window.tacit.managerChat.send(
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
  }, [draft, sending, managerTerminal, viewing, t]);

  /** Picking someone returns you to the conversation with them. */
  const returnToChat = useCallback(() => {
    setView("chat");
    // A handover ends any archive you were reading: the seat just changed
    // hands, and the conversation you land in should be the new holder's.
    setViewing(null);
  }, []);

  /**
   * The occupant is the control, so this is what clicking it does: the seat
   * expands into the roster. From the collapsed pill that means growing to
   * panel size and showing a face, which is the same gesture whether the seat
   * is currently filled or empty.
   */
  const openRoster = useCallback(() => {
    setHeight((h) => (h === "rest" ? "full" : h));
    setView((v) => (v === "roster" ? "chat" : "roster"));
  }, []);

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
      const result = await window.tacit.browser.notifyWired(
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
      returnToChat();
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
    [activeCanvas, returnToChat, sendWorkspaceManagerBriefing, managerTerminal, t],
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
  /**
   * A face fills the seat at panel size regardless of the chat ladder, so the
   * roster is reachable from the collapsed pill and from an empty seat.
   */
  const faceOpen = view !== "chat";
  const chatOpen = managerTerminal !== null && height !== "rest";
  const expanded = faceOpen || chatOpen;
  const showChat = chatOpen && !faceOpen;
  const isFull = faceOpen || (chatOpen && height === "full");

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[95] pointer-events-none"
      // Sits directly above the composer. It used to clear the node dock as
      // well, which moved to the left rail — leaving that offset behind would
      // have parked the pill over a gap.
      style={{ bottom: bottomOffset }}
    >
      <div
        // overflow-hidden, now that nothing escapes the shell. It used to be
        // omitted because the assign and history menus were absolutely
        // positioned children that clipping would have erased — they are faces
        // inside the shell now, so clipping is what keeps content inside the
        // rounded corner while the box is mid-deform.
        className={`tc-seat tc-pill pointer-events-auto relative mx-auto flex flex-col overflow-hidden ${PILL_GLASS}`}
        // Collapsed it is glass, so the canvas belongs behind it. Expanded it
        // is a reading surface and goes black — see `.tc-seat[data-open]`.
        // Opening is therefore not merely the box growing: the surface changes
        // state on the same curve, which is the moment worth having.
        data-open={expanded ? "" : undefined}
        style={
          {
            width: expanded ? "min(34rem, calc(100vw - 2rem))" : undefined,
            maxHeight: isFull ? "min(30rem, 55vh)" : undefined,
            // Reading a predecessor shows their colour. The room belongs to
            // whoever is speaking in it, which answers "live or archive?"
            // before you have read the banner.
            "--seat-hue": speakingHue,
          } as React.CSSProperties
        }
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
        {isFull && (
          <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-2.5 py-2">
            {faceOpen ? (
              /* A face is showing, so the header's job is to get you back. */
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
                style={{ fontSize: "var(--text-xs)" }}
                onClick={() => {
                  setView("chat");
                  // Nothing to go back to when the seat is empty.
                  if (!managerTerminal) setHeight("rest");
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 12L6 8l4-4" />
                </svg>
                {t.back}
              </button>
            ) : (
              <>
                {/* Same control as the collapsed pill: the occupant, clickable. */}
                <button
                  className="tc-seat-avatar"
                  onClick={openRoster}
                  aria-haspopup="true"
                  aria-expanded={false}
                  title={t.project_chat_assign}
                  aria-label={t.project_chat_assign}
                >
                  {managerWorking && <span className="tc-seat-pulse" aria-hidden="true" />}
                  {managerTerminal && (
                    <img
                      src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
                      alt=""
                    />
                  )}
                </button>
                <button
                  className="tc-mono truncate text-left text-[var(--text-primary)] hover:underline"
                  style={{ fontSize: "var(--text-xs)" }}
                  onClick={flyToManager}
                  title={t.project_chat_go_to}
                >
                  {managerLabel}
                </button>
              </>
            )}
            <span className="tc-mono flex-1 truncate text-[var(--text-faint)]" style={{ fontSize: "var(--text-xs)" }}>
              {view === "roster"
                ? t.project_chat_assign
                : view === "history"
                  ? t.project_chat_history
                  : ""}
            </span>
            {!faceOpen && history.length > 0 && (
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
                style={{ fontSize: "var(--text-xs)" }}
                onClick={() => setView("history")}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3a5 5 0 1 1-4.2 2.3" />
                  <path d="M3.2 3.5v2.2h2.2" />
                  <path d="M8 5.5V8l1.8 1.2" />
                </svg>
                {t.project_chat_history}
              </button>
            )}
            <button
              className="shrink-0 rounded-md p-1 text-[var(--text-faint)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
              onClick={() => {
                setView("chat");
                setViewing(null);
                setHeight("rest");
              }}
              aria-label={t.close}
            >
              {/* Points UP — collapsing shrinks the seat back down to a pill. */}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}

        {/* You are reading someone else's tenure. Said before the transcript
            rather than after it, because the first line you read should not be
            mistaken for something the current manager told you. */}
        {showChat && viewing && (
          <div className="tc-seat-archive tc-seat-face">
            {speakingIcon && <img src={speakingIcon} alt="" />}
            <span className="min-w-0 flex-1 truncate">
              {t.project_chat_reading_past}
              <b className="tc-mono"> {viewing.cli ?? "agent"}</b>
              <span className="tc-mono"> · {formatWhen(viewing.startedAt)}</span>
            </span>
            <button type="button" onClick={() => setViewing(null)}>
              {t.project_chat_back_to_live}
            </button>
          </div>
        )}

        {showChat && height === "full" && conversation && (
          <div className="tc-seat-face flex min-h-0 flex-1 flex-col">
            <ConversationBody
              conversation={conversation}
              isLive={viewing === null}
              handover={
                handoverRow
                  ? {
                      cli: handoverRow.cli,
                      at: handoverRow.startedAt,
                      icon:
                        handoverRow.cli && handoverRow.cli in AGENT_ICON
                          ? AGENT_ICON[handoverRow.cli as WorkspaceManagerAgentType]
                          : null,
                    }
                  : null
              }
            />
          </div>
        )}

        {/* Peek — the one line that makes the composer height usable alone.
            Hidden at full height, where the conversation says the same thing
            with more room. */}
        {showChat && height !== "full" && conversation && (
          <div className="tc-seat-face">
            <PeekLine conversation={conversation} />
          </div>
        )}

        {/* The resting pill. Its own row so the label keeps its position as the
            control grows — nothing jumps when a height changes. */}
        {!expanded && (
          <div className="tc-seat-face flex items-center gap-1.5 py-1.5 pl-2 pr-2">
            {/* The occupant is the control: clicking who holds the seat is how
                you change who holds it. That retires both the separate "+" and
                the "change ▾" trigger, and leaves one affordance that matches
                the mental model exactly. Vacant, the same button is a dashed
                chair rather than a settings sentence. */}
            <button
              className="tc-seat-avatar"
              data-empty={managerTerminal ? undefined : ""}
              onClick={openRoster}
              aria-haspopup="true"
              aria-expanded={false}
              title={t.project_chat_assign}
              aria-label={t.project_chat_assign}
            >
              {managerWorking && <span className="tc-seat-pulse" aria-hidden="true" />}
              {managerTerminal && (
                <img
                  src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
                  alt=""
                />
              )}
            </button>
            <button
              className={labelButtonCls}
              onClick={() => (managerTerminal ? setHeight("composer") : openRoster())}
              title={managerTerminal ? t.project_chat_show : t.project_chat_unassigned}
            >
              <span className={managerTerminal ? "tc-mono" : undefined}>
                {managerTerminal ? managerLabel : t.project_chat_unassigned}
              </span>
            </button>
          </div>
        )}

        {/* A past holder cannot be messaged, so the composer is replaced rather
            than disabled. A greyed-out input still invites a click, and this
            one used to be fully live: typing here while reading an archive sent
            the message to whoever holds the seat *now* — an agent that has
            never seen the conversation on screen — and put the reply in a
            thread you were not looking at, so it read as vanishing. */}
        {showChat && viewing && (
          <div className="tc-seat-face flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2.5">
            <span
              className="tc-mono truncate text-[var(--text-faint)]"
              style={{ fontSize: "var(--text-xs)" }}
            >
              {t.project_chat_archive_readonly}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)]"
              style={{ fontSize: "var(--text-xs)" }}
              onClick={() => setViewing(null)}
            >
              {t.project_chat_back_to_live}
            </button>
          </div>
        )}

        {/* Input — rendered in the same slot at both heights so switching
            between them never unmounts it and loses a half-typed message. */}
        {showChat && !viewing && (
          <div className="tc-seat-face flex shrink-0 items-end gap-2 border-t border-[var(--border)] px-3 py-2">
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
        {/* Past sessions, newest first. Tiles rather than the timestamp list it
            used to be: you scan history asking "which one was that", and a row
            carrying the agent's own mark and how long it ran answers that,
            where a bare clock time does not. It spans the panel rather than
            hanging off one corner, so it reads as a sheet over the
            conversation instead of a dropdown clipped to an edge. */}
        {view === "history" && (
          <div className="tc-seat-face min-h-0 flex-1 overflow-y-auto p-1.5">
            {history.map((row) => {
              const cli = row.cli ?? "agent";
              const icon =
                cli in AGENT_ICON
                  ? AGENT_ICON[cli as WorkspaceManagerAgentType]
                  : null;
              return (
                <button
                  key={row.sessionId}
                  type="button"
                  disabled={!row.sessionFile}
                  onClick={() => {
                    setViewing(row.isCurrent ? null : row);
                    setView("chat");
                  }}
                  className="tc-seat-session"
                >
                  <span className="mark">
                    {icon && <img src={icon} alt="" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className="tc-mono truncate text-[var(--text-primary)]"
                        style={{ fontSize: "var(--text-xs)" }}
                      >
                        {cli}
                      </span>
                      {row.isCurrent && (
                        <span
                          className="tc-mono shrink-0 uppercase tracking-wider"
                          style={{ fontSize: "10px", color: "var(--green)" }}
                        >
                          {t.project_chat_now}
                        </span>
                      )}
                    </span>
                    <span
                      className="tc-mono mt-0.5 block text-[var(--text-faint)]"
                      style={{ fontSize: "10.5px" }}
                    >
                      {formatHeld(row.startedAt, row.endedAt)}
                    </span>
                  </span>
                  <span
                    className="tc-mono shrink-0 tabular-nums text-[var(--text-faint)]"
                    style={{ fontSize: "10.5px" }}
                  >
                    {formatWhen(row.startedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {view === "roster" && (
          <div
            role="menu"
            aria-label={t.project_chat_assign}
            className="tc-seat-face min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {(managerTerminal || eligibleManagerTerminals.length > 0) && (
              <div className="tc-seat-group">{t.project_chat_running_now}</div>
            )}
            {/* The current holder, listed but not selectable — picking it would
                be a no-op, and leaving it out of the list made the menu read as
                if it were offering the only options that exist. */}
            {managerTerminal && (
              <div className="tc-seat-option pointer-events-none justify-between text-[var(--text-primary)]">
                <img
                  src={AGENT_ICON[managerTerminal.type as WorkspaceManagerAgentType]}
                  alt=""
                />
                <span className="min-w-0 flex-1 truncate">{managerLabel}</span>
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
                className="tc-seat-option"
                onClick={() => assignWorkspaceManager(term.id)}
              >
                <img src={AGENT_ICON[term.type]} alt="" />
                <span className="min-w-0 flex-1 truncate">
                  {labelFor(term.id) || term.label}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {AGENT_DISPLAY_NAME[term.type]}
                </span>
              </button>
            ))}
            <div className="tc-seat-group">{t.project_chat_start_new}</div>
            {WORKSPACE_MANAGER_AGENT_TYPES.map((type) => (
              <button
                key={type}
                data-popover-item
                role="menuitem"
                tabIndex={-1}
                className="tc-seat-option"
                onClick={() => spawnAndAssignManager(type)}
              >
                <img src={AGENT_ICON[type]} alt="" />
                <span>{AGENT_DISPLAY_NAME[type]}</span>
              </button>
            ))}
            {/* Emptying the seat. It was the last item of a menu that ran off
                the bottom of the window, so the one option you open this to
                find was the one you could not reach. In a face it is simply
                the last row, and the face scrolls. */}
            {managerTerminal && (
              <>
                <div className="mx-2 my-1.5 h-px bg-[var(--border)] opacity-60" />
                <button
                  data-popover-item
                  role="menuitem"
                  tabIndex={-1}
                  className="tc-seat-option"
                  data-danger=""
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
