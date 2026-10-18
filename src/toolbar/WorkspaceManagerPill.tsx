import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
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
import { TaskControl } from "./TaskControl";
import { ChatHistory } from "./ChatHistory";
import { LiveSessions, useNeedsYouCount } from "./LiveSessions";
import { TasksView } from "../tasks/TasksView";
import { useTasksNeedingYou } from "../tasks/useTasksNeedingYou";
import { TaskBar } from "../tasks/TaskParts";
import { managerTask } from "../tasks/taskModel";
import { openPinFull } from "../tasks/TasksView";
import { usePinStore } from "../stores/pinStore";
import { LimitCard, PlanCard, QueuedMessages, useQueue, useQueueSender } from "./chat/LongRunning";
import { useManagerChatStore } from "../stores/managerChatStore";
import { ApprovalCards, ChatThread } from "./chat/ChatThread";
import { QuestionForm } from "./chat/QuestionForm";
import { ComposerSettings } from "./chat/ComposerSettings";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { isWorkspaceManagerBriefing } from "../../shared/manager-role";
import {
  answerManagerApproval,
  ensureManagerChat,
  hasChatMode,
  interruptManagerChat,
  cancelManagerMove,
  moveManagerNow,
  moveManagerToTerminal,
  requestManagerMove,
  sendToManagerChat,
  answerChatQuestion,
  configureChat,
} from "../actions/managerChatMode";
import { useCanvasStore } from "../stores/canvasStore";
import { useSessionStore } from "../stores/sessionStore";
import { ManagerMark } from "./ManagerMark";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";
import { CHROME_GAP, CHROME_INSET, LEFT_RAIL_WIDTH } from "../stores/canvasStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useShortcutStore, formatShortcut } from "../stores/shortcutStore";
import { useT } from "../i18n/useT";
import { agentIcon } from "./agentIcons";
import { findAgentAdapter, listAgentAdapters } from "../../shared/agent-adapters";
import type { TerminalType } from "../types";

/** Time for today's rows, date for older ones — a history list reads as "when". */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}


// Any agent Tacit launches with its bridge tools can hold the role: the role
// is those tools plus the briefing, and every adapter in
// shared/agent-adapters.ts gets both. Shell and Lazygit terminals aren't
// agent loops, so they have no adapter and aren't offered.
const MANAGER_AGENTS = listAgentAdapters().filter((adapter) => !adapter.retired);

function agentName(type: string): string {
  return findAgentAdapter(type)?.displayName ?? type;
}

/**
 * The lit edge along the top of the expanded seat is mixed with whoever holds
 * it. Hues are sampled from each agent's own mark rather than assigned, so a
 * handover is visible without anything announcing it.
 */
const AGENT_HUE: Record<string, string> = {
  claude: "#d98b6f",
  codex: "#7b7ce8",
  gemini: "#6ea6f5",
  antigravity: "#3887fe",
  opencode: "#cfc8bd",
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

  const agentDetections = useAgentAvailabilityStore((state) => state.byId);

  const eligibleManagerTerminals = useMemo(() => {
    const list: Array<{ id: string; type: TerminalType; label: string }> = [];
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        for (const terminal of worktree.terminals) {
          if (terminal.stashed) continue;
          if (terminal.id === workspaceManagerTerminalId) continue;
          if (!findAgentAdapter(terminal.type)) continue;
          list.push({
            id: terminal.id,
            type: terminal.type,
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
   * Which face the seat is showing.
   *
   * Roster and history used to be popovers anchored inside the panel, which
   * put them off the bottom of the window — the panel is anchored to the
   * bottom of the screen, so anything hanging below it is clipped by
   * construction. They are faces now: one shell, contents swapped, a back
   * button to return. Nothing can be positioned off-screen because nothing is
   * positioned at all. Held in the dock's store, so a pin badge or a
   * terminal's pin chip can open the chat on Pins.
   */
  const view = useChatDockStore((s) => s.face);
  const setView = useChatDockStore((s) => s.setFace);
  /**
   * Resting, it is the pill at the bottom; opened, it docks full height on
   * the left beside the bar (SHR-127). The old in-between heights grew a
   * box over the middle of the canvas, which is where your work is.
   */
  const dockOpen = useChatDockStore((s) => s.open);
  const dockWidth = useChatDockStore((s) => s.width);
  const setDockOpen = useChatDockStore((s) => s.setOpen);
  const [draft, setDraft] = useState("");
  // Text sent here from elsewhere (a past session to ask about) joins the draft.
  const draftInsert = useChatDockStore((s) => s.draftInsert);
  useEffect(() => {
    if (draftInsert === null) return;
    const text = useChatDockStore.getState().takeDraftInsert();
    if (!text) return;
    setDraft((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${text}` : text));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draftInsert]);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<ManagerSessionRow[]>([]);

  const [viewing, setViewing] = useState<ManagerSessionRow | null>(null);
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
  const speakingHue = speakingCli ? AGENT_HUE[speakingCli] : undefined;
  const speakingIcon = agentIcon(speakingCli) ?? null;
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
          // A title that is only the creation default ("Terminal" for a shell
          // that later started an agent, or the type id) says nothing the
          // row's agent name doesn't; the project does.
          const isDefaultTitle =
            !terminal.title ||
            terminal.title === "Terminal" ||
            terminal.title === terminal.type;
          const base = isDefaultTitle ? project.name : terminal.title;
          return worktree.name ? `${base} · ${worktree.name}` : base;
        }
      }
      return "";
    },
    [projects],
  );

  const managerLabel = managerTerminal ? labelFor(managerTerminal.id) : "";

  // A seat that empties while the chat is open shows who could take it.
  useEffect(() => {
    if (!managerTerminal && dockOpen && view === "chat") setView("roster");
  }, [managerTerminal, dockOpen, view, setView]);

  // Closing the chat leaves it on the conversation, live, for next time.
  useEffect(() => {
    if (!dockOpen) {
      setView("chat");
      setViewing(null);
    }
  }, [dockOpen]);

  // Focus the input as soon as the chat opens, so ⌘J and typing works
  // without an extra click.
  useEffect(() => {
    if (dockOpen && view === "chat") requestAnimationFrame(() => inputRef.current?.focus());
  }, [dockOpen, view]);

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
    if (managerTerminal.chatMode) {
      // Written while it works: queued, to go when the turn ends.
      const busy = useManagerChatStore.getState().transcripts[managerTerminal.id]?.running ?? false;
      if (busy || (useManagerChatStore.getState().queues[managerTerminal.id]?.length ?? 0) > 0) {
        useManagerChatStore.getState().enqueue(managerTerminal.id, text);
        setDraft("");
        return;
      }
      setSending(true);
      try {
        if (await sendToManagerChat(managerTerminal.id, text)) setDraft("");
        else useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
      } finally {
        setSending(false);
      }
      return;
    }
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
    setDockOpen(true);
    setView(view === "roster" && managerTerminal ? "chat" : "roster");
  }, [setDockOpen, setView, view, managerTerminal]);

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
            "Couldn't brief the new manager — its shell process isn't ready yet. It still has the role; just ask it to call get_workspace_summary directly.",
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
            `Couldn't brief the new manager: ${result.detail ?? result.error}. It still has the role; just ask it to call get_workspace_summary directly.`,
          );
      }
    },
    [],
  );

  const assignWorkspaceManager = useCallback(
    (terminalId: string | null, options?: { briefedAtLaunch?: boolean }) => {
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
                    agentName(outgoing.type),
                    agentName(incoming.type),
                  ),
            );
        }
        if (!options?.briefedAtLaunch) void sendWorkspaceManagerBriefing(terminalId);
      }
    },
    [activeCanvas, returnToChat, sendWorkspaceManagerBriefing, managerTerminal, t],
  );

  const spawnAndAssignManager = useCallback(
    (type: TerminalType) => {
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
      // A new agent gets the briefing as its launch prompt. Typed in, it
      // could land before the agent had started: Antigravity then showed it
      // as raw `^[[200~` text, echoed by the terminal while nothing was
      // reading it yet.
      if (hasChatMode(type)) {
        // Claude and Codex managers start in the chat (T6): the tile starts
        // no process, and the briefing is the chat's first message.
        const terminal = createTerminalInScene({ projectId, worktreeId, type });
        useProjectStore.getState().setTerminalChatMode(projectId, worktreeId, terminal.id, true);
        assignWorkspaceManager(terminal.id, { briefedAtLaunch: true });
        void ensureManagerChat(terminal.id).then(() => sendToManagerChat(terminal.id, WORKSPACE_MANAGER_BRIEFING));
        return;
      }
      const terminal = createTerminalInScene({
        projectId,
        worktreeId,
        type,
        initialPrompt: WORKSPACE_MANAGER_BRIEFING,
      });
      assignWorkspaceManager(terminal.id, { briefedAtLaunch: true });
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
  const toggleShortcut = useShortcutStore((s) => s.shortcuts.toggleManagerChat);
  const isMac = (window.tacit?.app.platform ?? "darwin") === "darwin";
  const shortcutLabel = formatShortcut(toggleShortcut, isMac);
  const [dragging, setDragging] = useState(false);

  /** Drag the chat's right edge; the width is kept when you let go. */
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startWidth = useChatDockStore.getState().width;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => useChatDockStore.getState().setWidth(startWidth + ev.clientX - startX);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      useChatDockStore.getState().commitWidth();
      setDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, []);

  /** Esc to the manager's terminal: how Claude and Codex stop a turn. */
  const stopTurn = useCallback(() => {
    if (!managerTerminal) return;
    const ptyId = getLivePtyId(managerTerminal.id);
    if (ptyId != null) window.tacit.terminal.input(ptyId, "\x1b");
  }, [managerTerminal]);

  // History covers every worktree on this canvas, as the History panel did.
  const canvasProjectDirs = useMemo(
    () => projects.flatMap((p) => p.worktrees.map((w) => w.path)),
    [projects],
  );
  const managerSessionIds = useMemo(() => new Set(history.map((row) => row.sessionId)), [history]);
  const currentManagerSessionId =
    managerTerminal?.sessionId ?? history.find((row) => row.isCurrent)?.sessionId ?? null;
  const openSessionsOverlay = useCanvasStore((s) => s.openSessionsOverlay);
  const loadReplay = useSessionStore((s) => s.loadReplay);
  /** The transcript opens in the session view beside the chat, with Resume. */
  const openReplay = useCallback(
    (filePath: string) => {
      openSessionsOverlay();
      void loadReplay(filePath);
    },
    [openSessionsOverlay, loadReplay],
  );

  // Chat mode (T6): the manager's agent runs in the engine, not its tile.
  const chatMode = !!managerTerminal?.chatMode;
  const transcript = useManagerTranscript(chatMode ? managerTerminal!.id : null);
  const chatTerminalId = chatMode ? managerTerminal!.id : null;
  const sendQueued = useCallback(
    async (text: string) => {
      if (!chatTerminalId) return false;
      const ok = await sendToManagerChat(chatTerminalId, text);
      if (!ok) useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
      return ok;
    },
    [chatTerminalId, t],
  );
  useQueueSender(chatTerminalId, transcript, sendQueued);
  const queuedCount = useQueue(chatTerminalId).length;
  useEffect(() => {
    if (chatMode && managerTerminal) void ensureManagerChat(managerTerminal.id);
  }, [chatMode, managerTerminal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const chatMessages = useMemo(
    // The briefing sent on taking the seat shows as a line, not as a message from the person.
    () =>
      transcript.messages.map((m) =>
        m.role === "user" && isWorkspaceManagerBriefing(m.text) ? { role: "note" as const, id: m.id, kind: "briefing" as const, text: m.text } : m,
      ),
    [transcript.messages],
  );
  const lastChatReply = useMemo(() => {
    for (let i = transcript.messages.length - 1; i >= 0; i -= 1) {
      const m = transcript.messages[i];
      if (m.role !== "assistant") continue;
      const text = [...m.parts].reverse().find((p) => p.type === "text" && p.text.trim());
      if (text && text.type === "text") return text.text.replace(/\s+/g, " ").trim().slice(0, 120);
    }
    return null;
  }, [transcript.messages]);

  const faceOpen = view !== "chat";
  const needsYou = useNeedsYouCount();

  // The pin view beside the chat belongs to the Pins face: leaving it, or
  // closing the chat, closes the project's pins too.
  const pinsProject = usePinStore((s) => s.openProjectPath);
  useEffect(() => {
    if (pinsProject && !(dockOpen && view === "pins")) usePinStore.getState().closeDrawer();
  }, [pinsProject, dockOpen, view]);

  const tasksWaiting = useTasksNeedingYou().length;
  // The manager's own task, kept with the project, sits above the message box.
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const activeTask = useMemo(
    () => managerTask(Object.values(pinsByProject).flat(), managerTerminal?.id ?? null),
    [pinsByProject, managerTerminal?.id],
  );
  const running = chatMode ? transcript.running : conversation?.telemetry?.turn_state === "in_turn";
  // A move asked for mid-turn happens when the turn ends. One that no longer
  // applies (the manager already moved) is dropped.
  const pendingMove = usePendingManagerMove(managerTerminal?.id ?? null);
  useEffect(() => {
    if (!managerTerminal || !pendingMove) return;
    if ((pendingMove === "terminal") !== chatMode) cancelManagerMove(managerTerminal.id);
    else if (!running) requestManagerMove(managerTerminal.id, pendingMove, false);
  }, [pendingMove, running, chatMode, managerTerminal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingMoveLine = managerTerminal && pendingMove && (
    <div className="flex items-center gap-2 px-1 py-1.5" style={{ fontSize: "var(--text-xs)" }}>
      <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
      <span className="min-w-0 truncate text-[var(--text-secondary)]">
        {pendingMove === "terminal" ? t.chat_move_pending_terminal : t.chat_move_pending_chat}
      </span>
      <button
        type="button"
        className="tc-rail-btn ml-auto h-6 shrink-0 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={() => moveManagerNow(managerTerminal.id)}
        title={t.chat_move_now_hint}
      >
        {t.chat_move_now}
      </button>
      <button
        type="button"
        className="tc-rail-btn h-6 shrink-0 px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={() => cancelManagerMove(managerTerminal.id)}
      >
        {t.cancel}
      </button>
    </div>
  );
  const agentLabel = managerTerminal ? agentName(managerTerminal.type) : null;

  const iconButton =
    "tc-rail-btn inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";

  // ── Resting: the pill at the bottom, the recording chip beside it ──────
  if (!dockOpen) {
    return (
      <div
        // The context chip and the pill share one row, centred together, so
        // what is being recorded sits beside who you are talking to.
        className="pointer-events-none fixed left-1/2 z-[95] flex -translate-x-1/2 items-end gap-2"
        style={{ bottom: bottomOffset }}
      >
        <TaskControl />
        <div className="pointer-events-auto flex flex-col items-center gap-2">
          {/* One line above the pill: what the manager is doing, or the last
              thing it said. */}
          {/* A request waiting on you is answered right here, chat open or not:
              answering it is what the pill is kept for. */}
          {managerTerminal && chatMode && transcript.questions[0] && (
            <div className={`w-[min(34rem,calc(100vw-2rem))] rounded-[14px] py-2 ${PILL_GLASS}`}>
              <QuestionForm
                key={transcript.questions[0].requestId}
                pending={transcript.questions[0]}
                agentName={agentName(managerTerminal.type)}
                onSubmit={(answers) => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, answers)}
                onSkip={() => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, null)}
              />
            </div>
          )}
          {managerTerminal && chatMode && transcript.approvals.length > 0 && (
            <div className="w-[min(34rem,calc(100vw-2rem))]">
              <ApprovalCards
                floating
                glass={PILL_GLASS}
                approvals={transcript.approvals}
                onAnswer={(requestId, decision) => void answerManagerApproval(managerTerminal.id, requestId, decision)}
                onPlanMode={(mode) => void configureChat(managerTerminal.id, { mode })}
              />
            </div>
          )}
          {managerTerminal && chatMode && transcript.approvals.length === 0 && (running || lastChatReply) && (
            <div
              className={`tc-pill flex max-w-[34rem] items-center gap-1.5 px-3 py-1.5 ${PILL_GLASS}`}
              style={{ fontSize: "var(--text-xs)" }}
            >
              {running ? (
                <>
                  <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
                  <span style={{ color: "var(--cyan)" }}>{t.chat_working}</span>
                </>
              ) : (
                <span className="truncate text-[var(--text-muted)]">{lastChatReply}</span>
              )}
            </div>
          )}
          {managerTerminal && !chatMode && conversation && (running || conversation.lastReply) && (
            <div
              className={`tc-pill max-w-[34rem] px-3 py-1.5 ${PILL_GLASS}`}
              style={{ fontSize: "var(--text-xs)" }}
            >
              <PeekLine conversation={conversation} bare />
            </div>
          )}
          {managerTerminal ? (
            <button
              type="button"
              className={`tc-pill flex h-12 items-center gap-2.5 pl-2.5 pr-2 text-left transition-colors duration-quick ${PILL_GLASS}`}
              style={{
                width: "min(30rem, calc(100vw - 26rem))",
                borderColor: running ? "color-mix(in srgb, var(--cyan) 40%, transparent)" : undefined,
              }}
              onClick={() => setDockOpen(true)}
              title={`${t.project_chat_show} (${shortcutLabel})`}
            >
              <ManagerMark agent={managerTerminal.type} size={24} working={managerWorking} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-muted)]">
                {t.project_chat_placeholder}
              </span>
              <kbd className="tc-mono shrink-0 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                {shortcutLabel}
              </kbd>
            </button>
          ) : (
            <button
              type="button"
              className={`tc-pill flex h-12 items-center gap-2.5 px-4 text-left text-[13px] text-[var(--text-secondary)] ${PILL_GLASS}`}
              style={{ width: "min(30rem, calc(100vw - 26rem))", borderStyle: "dashed" }}
              onClick={openRoster}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              {t.project_chat_choose}
              <span className="ml-auto text-[11.5px] text-[var(--text-muted)]">{t.project_chat_choose_hint}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Open: docked full height on the left, beside the bar ───────────────
  return (
    <aside
      className="tc-float fixed z-[44] flex flex-col overflow-hidden"
      aria-label={t.project_chat_title}
      style={
        {
          top: TITLE_STRIP_HEIGHT + CHROME_INSET,
          bottom: CHROME_INSET,
          left: CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP,
          width: dockWidth,
          borderRadius: 20,
          // Reading a predecessor shows their colour on the lit top edge.
          "--seat-hue": speakingHue,
        } as React.CSSProperties
      }
      onKeyDown={(e) => {
        if (e.key === "Escape" && faceOpen && managerTerminal) {
          e.stopPropagation();
          setView("chat");
        }
      }}
    >
      {/* The lit edge, in the colour of whoever holds the seat. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{ background: `linear-gradient(90deg, transparent, ${speakingHue ?? "var(--accent)"}, transparent)`, opacity: 0.7 }}
      />

      {/* Header: the mark, who runs this workdesk, and the controls. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border)] pl-3 pr-2">
        <ManagerMark agent={speakingCli} size={28} working={managerWorking && isLive} />
        <button
          type="button"
          className="tc-rail-btn flex min-w-0 flex-col items-start px-1.5 py-1 text-left"
          onClick={openRoster}
          title={t.project_chat_assign}
          aria-haspopup="true"
        >
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">{t.project_chat_title}</span>
          <span className="flex max-w-full items-center gap-1 truncate text-[11px] text-[var(--text-muted)]">
            <span className="truncate">{agentLabel ? `${agentLabel} · ${managerLabel}` : t.project_chat_empty_seat}</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </button>
        <div className="flex-1" />
        {/* Sessions and Pins each open in place of the conversation; the lit
            icon takes you back. */}
        <button
          type="button"
          className={`${iconButton} relative`}
          data-on={view === "sessions" ? "" : undefined}
          aria-pressed={view === "sessions"}
          onClick={() => setView(view === "sessions" ? "chat" : "sessions")}
          title={needsYou > 0 ? t.chat_sessions_needs_you(needsYou) : t.chat_sessions}
          aria-label={needsYou > 0 ? t.chat_sessions_needs_you(needsYou) : t.chat_sessions}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3a5 5 0 1 1-4.2 2.3" />
            <path d="M3.2 3.5v2.2h2.2" />
            <path d="M8 5.5V8l1.8 1.2" />
          </svg>
          {needsYou > 0 && view !== "sessions" && (
            <span aria-hidden="true" className="absolute right-[7px] top-[7px] h-[7px] w-[7px] rounded-full bg-[var(--amber)] shadow-[0_0_0_2px_var(--surface)]" />
          )}
        </button>
        <button
          type="button"
          className={`${iconButton} relative`}
          data-on={view === "pins" ? "" : undefined}
          aria-pressed={view === "pins"}
          onClick={() => setView(view === "pins" ? "chat" : "pins")}
          title={tasksWaiting > 0 ? t.tasks_needs_you(tasksWaiting) : t.tasks_title}
          aria-label={tasksWaiting > 0 ? t.tasks_needs_you(tasksWaiting) : t.tasks_title}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4l1.2 1.2L6 3M2.5 8l1.2 1.2L6 7M2.5 12h0.01M8 4h5.5M8 8h5.5M8 12h5.5" />
          </svg>
          {tasksWaiting > 0 && view !== "pins" && (
            <span aria-hidden="true" className="absolute right-[7px] top-[7px] h-[7px] w-[7px] rounded-full bg-[var(--amber)] shadow-[0_0_0_2px_var(--surface)]" />
          )}
        </button>
        {/* The terminal itself: its tile there offers Open in terminal. */}
        {managerTerminal && (
          <button type="button" className={iconButton} onClick={flyToManager} title={t.project_chat_go_to} aria-label={t.project_chat_go_to}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="3.5" width="11" height="9" rx="1.6" />
              <path d="M5 7l1.6 1.2L5 9.4M8 9.5h2.5" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={iconButton}
          onClick={() => setDockOpen(false)}
          title={`${t.project_chat_collapse_dock} (${shortcutLabel})`}
          aria-label={t.project_chat_collapse_dock}
        >
          {/* Down, then left: back into the pill at the bottom left. */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11.5 2.5v6a2 2 0 0 1-2 2H4" />
            <path d="M6.5 8L4 10.5 6.5 13" />
          </svg>
        </button>
      </div>

      {/* What is being recorded, under the header: the same control as the
          chip beside the pill, so there is only ever one. */}
      <TaskControl variant="strip" />

      {/* A face (choosing a manager, or past chats) gets a way back. */}
      {view === "roster" && managerTerminal && (
        <div className="flex shrink-0 items-center gap-2 px-2 pt-2">
          <button
            type="button"
            className="tc-rail-btn flex items-center gap-1.5 py-1 pl-1.5 pr-2.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => setView("chat")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 12L6 8l4-4" />
            </svg>
            {t.back}
          </button>
          <span className="text-[12px] text-[var(--text-faint)]">
            {t.project_chat_assign}
          </span>
        </div>
      )}

      {/* You are reading someone else's tenure. Said before the transcript,
          because the first line you read should not be mistaken for something
          the current manager told you. */}
      {view === "chat" && viewing && (
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

      {view === "chat" && chatMode && managerTerminal && (
        <ChatThread
          transcript={{ ...transcript, messages: chatMessages }}
          agent={managerTerminal.type}
          onSend={async (text) => {
            await sendToManagerChat(managerTerminal.id, text);
          }}
          onCancel={() => interruptManagerChat(managerTerminal.id)}
        />
      )}

      {view === "chat" && chatMode && managerTerminal && transcript.failure && (
        <div className="mx-3 mb-2 rounded-xl border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, transparent)", background: "color-mix(in srgb, var(--red) 6%, transparent)" }}>
          <div className="text-[12.5px]" style={{ color: "var(--red)" }}>{t.chat_failure_title}</div>
          <div className="mt-1 line-clamp-3 text-[11.5px] text-[var(--text-secondary)]">{transcript.failure}</div>
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="tc-rail-btn h-7 border border-[var(--border-hover)] px-2.5 text-[12px] text-[var(--text-primary)]" onClick={() => void ensureManagerChat(managerTerminal.id)}>
              {t.chat_restart}
            </button>
            <button type="button" className="tc-rail-btn h-7 px-2.5 text-[12px] text-[var(--text-muted)]" onClick={() => void moveManagerToTerminal(managerTerminal.id)}>
              {t.chat_mode_back_to_terminal}
            </button>
          </div>
        </div>
      )}

      {view === "chat" && !chatMode && !viewing && managerTerminal && hasChatMode(managerTerminal.type) && (
        <div className="mx-3 mt-2.5 flex items-center gap-2.5 rounded-xl border border-[var(--border)] px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-[var(--text-primary)]">{t.chat_mode_move_title}</span>
            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[var(--text-muted)]">{t.chat_mode_move_body}</span>
          </span>
          <button
            type="button"
            className="shrink-0 rounded-[9px] px-3 py-1.5 text-[12px] font-medium"
            style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
            onClick={() => requestManagerMove(managerTerminal.id, "chat", running)}
            disabled={pendingMove === "chat"}
          >
            {t.chat_mode_move}
          </button>
        </div>
      )}
      {view === "chat" && !chatMode && !viewing && pendingMove === "chat" && <div className="mx-3 mt-1">{pendingMoveLine}</div>}

      {view === "chat" && !chatMode && conversation && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationBody
            conversation={conversation}
            isLive={viewing === null}
            handover={
              handoverRow
                ? { cli: handoverRow.cli, at: handoverRow.startedAt, icon: agentIcon(handoverRow.cli) ?? null }
                : null
            }
          />
        </div>
      )}

      {/* What is on this workdesk now (needs you, then every project's
          terminals), then past sessions with the agent, title, size and when;
          a past row opens its transcript in the session view beside the chat. */}
      {view === "sessions" && (
        <ChatHistory
          projectDirs={canvasProjectDirs}
          managerSessionIds={managerSessionIds}
          currentSessionId={currentManagerSessionId}
          onOpen={openReplay}
          live={(query) => <LiveSessions query={query} />}
        />
      )}

      {/* A project's pins; one opens in the pin view beside the chat. */}
      {view === "pins" && <TasksView />}

      {view === "roster" && (
        <div role="menu" aria-label={t.project_chat_assign} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!managerTerminal && (
            <div className="px-2 pb-2 pt-3">
              <div className="text-[16px] font-semibold text-[var(--text-primary)]">{t.project_chat_choose_title}</div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t.project_chat_choose_body}</div>
            </div>
          )}
          {(managerTerminal || eligibleManagerTerminals.length > 0) && (
            <div className="tc-seat-group">{t.project_chat_running_now}</div>
          )}
          {managerTerminal && (
            <div className="tc-seat-option pointer-events-none justify-between text-[var(--text-primary)]">
              <img src={agentIcon(managerTerminal.type)} alt="" />
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
              <img src={agentIcon(term.type)} alt="" />
              <span className="min-w-0 flex-1 truncate">{labelFor(term.id) || term.label}</span>
              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{agentName(term.type)}</span>
            </button>
          ))}
          <div className="tc-seat-group">{t.project_chat_start_new}</div>
          {MANAGER_AGENTS.map(({ id: type, displayName }) => {
            // An agent whose CLI isn't installed stays listed, dimmed, with
            // the reason, rather than spawning a manager that fails at launch.
            const detection = agentDetections[type];
            const missing = detection !== undefined && !detection.installed;
            return (
              <button
                key={type}
                data-popover-item
                role="menuitem"
                tabIndex={-1}
                className={`tc-seat-option${missing ? " opacity-50" : ""}`}
                aria-disabled={missing || undefined}
                title={missing ? (detection.reason ?? undefined) : undefined}
                onClick={() => {
                  if (missing) return;
                  spawnAndAssignManager(type as TerminalType);
                }}
              >
                <img src={agentIcon(type)} alt="" />
                <span className="min-w-0 flex-1 truncate">{displayName}</span>
                {missing && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{t.agent_not_installed}</span>}
              </button>
            );
          })}
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

      {/* A past holder cannot be messaged, so the composer is replaced rather
          than disabled: typing here used to send to whoever holds the seat
          now, an agent that has never seen the conversation on screen. */}
      {view === "chat" && viewing && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2.5">
          <span className="tc-mono truncate text-[var(--text-faint)]" style={{ fontSize: "var(--text-xs)" }}>
            {t.project_chat_archive_readonly}
          </span>
          <button
            type="button"
            className="tc-rail-btn shrink-0 px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            style={{ fontSize: "var(--text-xs)" }}
            onClick={() => setViewing(null)}
          >
            {t.project_chat_back_to_live}
          </button>
        </div>
      )}

      {/* The agent's questions, then approvals, then the status line and the composer. */}
      {view === "chat" && chatMode && managerTerminal && transcript.questions[0] && (
        <QuestionForm
          key={transcript.questions[0].requestId}
          pending={transcript.questions[0]}
          agentName={agentName(managerTerminal.type)}
          onSubmit={(answers) => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, answers)}
          onSkip={() => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, null)}
        />
      )}
      {view === "chat" && chatMode && managerTerminal && (
        <ApprovalCards
          approvals={transcript.approvals}
          onAnswer={(requestId, decision) => void answerManagerApproval(managerTerminal.id, requestId, decision)}
          onPlanMode={(mode) => void configureChat(managerTerminal.id, { mode })}
        />
      )}

      {view === "chat" && !viewing && chatMode && managerTerminal && (
        <div className="shrink-0 pt-1">
          {activeTask ? (
            <TaskBar task={activeTask} onOpen={() => openPinFull(activeTask)} />
          ) : (
            <PlanCard transcript={transcript} />
          )}
          <LimitCard
            terminalId={managerTerminal.id}
            transcript={transcript}
            agentName={agentName(managerTerminal.type)}
            handOver={
              managerTerminal.type === "claude" || managerTerminal.type === "codex"
                ? (() => {
                    const other = managerTerminal.type === "claude" ? "codex" : "claude";
                    return { label: t.chat_limit_hand_to(agentName(other)), run: () => spawnAndAssignManager(other as TerminalType) };
                  })()
                : undefined
            }
          />
          <QueuedMessages terminalId={managerTerminal.id} onSendNow={(text) => void sendQueued(text)} />
        </div>
      )}

      {view === "chat" && !viewing && managerTerminal && (
        <div className="shrink-0 px-3 pb-3">
          {running && chatMode && pendingMove === "terminal" && pendingMoveLine}
          {running && chatMode && pendingMove !== "terminal" && (
            <div className="flex items-center gap-2 px-1 py-1.5" style={{ fontSize: "var(--text-xs)" }}>
              <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
              <span style={{ color: "var(--cyan)" }}>{t.chat_working}</span>
              <button
                type="button"
                className="tc-rail-btn ml-auto flex h-6 items-center gap-1.5 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => void interruptManagerChat(managerTerminal.id)}
                title={t.project_chat_stop}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                  <rect width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                {t.project_chat_stop}
              </button>
            </div>
          )}
          {running && !chatMode && conversation && (
            <div className="flex items-center gap-2 px-1 py-1.5" style={{ fontSize: "var(--text-xs)" }}>
              <PeekLine conversation={conversation} bare />
              <button
                type="button"
                className="tc-rail-btn ml-auto flex h-6 items-center gap-1.5 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={stopTurn}
                title={t.project_chat_stop_hint}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                  <rect width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                {t.project_chat_stop}
              </button>
            </div>
          )}
          <div
            className="flex flex-col gap-2 border px-3 pb-2 pt-2.5"
            style={{
              borderRadius: 14,
              cornerShape: "squircle",
              borderColor: "var(--border-hover)",
              background: "color-mix(in srgb, var(--bg) 70%, transparent)",
            } as React.CSSProperties}
          >
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              disabled={sending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                // The canvas listens globally for single-key shortcuts.
                e.stopPropagation();
              }}
              placeholder={running || queuedCount > 0 ? (chatMode ? t.chat_placeholder_queued : t.project_chat_placeholder_running) : t.project_chat_placeholder}
              className="max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none"
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="tc-rail-btn flex h-7 items-center gap-1 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => {
                  // Claude and Codex both read "@path" in a prompt as a file
                  // to attach; this starts one where the cursor is.
                  const el = inputRef.current;
                  const at = el?.selectionStart ?? draft.length;
                  const next = `${draft.slice(0, at)}@${draft.slice(at)}`;
                  setDraft(next);
                  requestAnimationFrame(() => {
                    el?.focus();
                    el?.setSelectionRange(at + 1, at + 1);
                  });
                }}
                title={t.project_chat_mention_file_hint}
              >
                {t.project_chat_mention_file}
              </button>
              {chatMode && <ComposerSettings terminalId={managerTerminal.id} transcript={transcript} agent={managerTerminal.type} />}
              <div className="flex-1" />
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] transition-opacity duration-quick disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
                aria-label={t.project_chat_send}
                title={t.project_chat_send}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The right edge: drag to resize; double-click for the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.project_chat_resize}
        title={t.project_chat_resize}
        className="group absolute bottom-0 right-0 top-0 z-10 flex w-2 cursor-col-resize items-center justify-center"
        onPointerDown={startResize}
        onDoubleClick={() => {
          useChatDockStore.getState().setWidth(440);
          useChatDockStore.getState().commitWidth();
        }}
      >
        <span
          className="h-11 w-[3px] rounded-full transition-colors duration-quick"
          style={{ background: dragging ? "var(--cyan)" : "color-mix(in srgb, var(--text-muted) 55%, transparent)" }}
        />
      </div>
    </aside>
  );
}
