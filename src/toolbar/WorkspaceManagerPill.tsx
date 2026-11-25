import { useFileTileStore } from "../stores/fileTileStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { SidebarGlyph } from "./ChatList";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AssignMenu } from "./AssignMenu";

import { TerminalConversation } from "./TerminalConversation";
import { SessionReader } from "./SessionReader";
import { findTerminal } from "../actions/terminalLookup";
import { removeManager, seatManager, startManager, useManagerSetupStore } from "../actions/managerSeat";
import { confirmAsync } from "../components/ui/confirmAsync";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import {
  ConversationBody,
  PeekLine,
  useManagerConversation,
} from "./ProjectChatPanel";
import type { ManagerSessionRow } from "../../shared/manager-role";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { waitForTerminalReady } from "../actions/sceneConnectionActions";
import { getLivePtyId } from "../actions/terminalLookup";
import { useNotificationStore } from "../stores/notificationStore";
import { flyToBounds } from "../utils/panToTerminal";
import { PILL_GLASS, useComposerBottomOffset } from "./pillChrome";
import { useLiveTree } from "./LiveSessions";
import { useTasksNeedingYou } from "../tasks/taskStore";
import { TaskBar } from "../tasks/TaskBar";
import { openTask } from "../tasks/taskActions";
import { useTaskOfTerminal } from "../tasks/taskStore";
import { LimitCard, PlanCard, QueuedMessages, UsageMeter, useQueue, useQueueSender } from "./chat/LongRunning";
import { ComposerBox, useAttachments } from "./chat/Composer";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { PaperclipIcon } from "./chat/Attachments";
import { useContextNotices } from "./TaskControl";
import { previewLine } from "./sessionReaderModel";
import { terminalName } from "../actions/terminalLookup";
import { withMentions } from "../../shared/chat-attachments";
import type { ChatAttachmentInfo } from "../../shared/chat-events";
import { useManagerChatStore } from "../stores/managerChatStore";
import { CanvasAsks } from "../board/CanvasAskCard";
import { ApprovalCards, ChatThread } from "./chat/ChatThread";
import { canSwitchToAuto } from "./chat/composerSettingsModel";
import { QuestionForm } from "./chat/QuestionForm";
import { ComposerSettings } from "./chat/ComposerSettings";
import { useManagerTranscript, usePendingManagerMove, useTakeChatNote } from "../stores/managerChatStore";
import { isWorkspaceManagerBriefing } from "../../shared/manager-role";
import {
  answerManagerApproval,
  ensureManagerChat,
  hasChatMode,
  interruptManagerChat,
  moveManagerToTerminal,
  sendToManagerChat,
  answerChatQuestion,
  configureChat,
  runPendingMove,
} from "../actions/managerChatMode";
import { pickAgentMode, PendingSwitchLine } from "../components/AgentModeSwitch";
import { borrowTerminalView, fitTerminalRuntime, useTerminalViewHolder } from "../terminal/terminalRuntimeStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useCanvasStore } from "../stores/canvasStore";
import { ManagerMark } from "./ManagerMark";
import { TITLE_STRIP_CSS, titleStripHeight } from "./titleStripHeight";
import { CHROME_GAP, CHROME_INSET, LEFT_RAIL_WIDTH } from "../stores/canvasStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useLeftChromeInset } from "../stores/chromeLayout";
import { CHAT_LIST_MIN_WINDOW, chatDockLeft, fittedChatWidth, useChatDockStore } from "../stores/chatDockStore";
import { usePanelPresence } from "../utils/usePanelPresence";
import { PANEL_REVEAL_TRANSITION, PANEL_SHIFT_TRANSITION, PANEL_TRANSITION_DURATION_MS, PANEL_TRANSITION_EASING_CSS, panelContentStyle } from "../utils/panelAnimation";
import { MOTION, prefersReducedMotion } from "../utils/motion";
import { clampFloatRect, defaultFloatRect, FLOAT_MIN } from "../stores/chatDockStore";
import { ChatFullScreenToggle, ChatPlacementMenu } from "./chat/ChatPlacementMenu";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { useWindowSize } from "../utils/useWindowSize";
import { useShortcutStore, formatShortcut } from "../stores/shortcutStore";
import { useT } from "../i18n/useT";
import { agentIcon } from "./agentIcons";
import { findAgentAdapter } from "../../shared/agent-adapters";
import type { TerminalType } from "../types";
import { openListedLiveChat, openPastSession } from "../actions/openSession";

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
  // Context recording's controls are in Activity; what others do to it is said here.
  useContextNotices();
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



  /**
   * Which face the seat is showing.
   *
   * Roster and history used to be popovers anchored inside the panel, which
   * put them off the bottom of the window — the panel is anchored to the
   * bottom of the screen, so anything hanging below it is clipped by
   * construction. They are faces now: one shell, contents swapped, a back
   * button to return. Nothing can be positioned off-screen because nothing is
   * positioned at all. Held in the dock's store, so other places can
   * open the chat on one.
   */
  const view = useChatDockStore((s) => s.face);
  const setView = useChatDockStore((s) => s.setFace);
  /**
   * Resting, it is the pill at the bottom; opened, it docks full height on
   * the left beside the bar (SHR-127). The old in-between heights grew a
   * box over the middle of the canvas, which is where your work is.
   */
  const dockOpen = useChatDockStore((s) => s.open);
  // The dock unfolds and folds like the panels beside it, so it stays in
  // the page while it closes.
  const { mounted: dockMounted, revealed: dockRevealed } = usePanelPresence(dockOpen);
  const dockWidth = useChatDockStore((s) => s.width);
  const setDockOpen = useChatDockStore((s) => s.setOpen);
  const [draft, setDraft] = useState("");
  // The note left after undoing the manager's turn in chat mode.
  useTakeChatNote(managerTerminal?.chatMode ? managerTerminal.id : null, setDraft);
  const attachments = useAttachments(managerTerminal?.id ?? null);
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
  // The pill's own box, which grows a few lines with the draft before it scrolls.
  const pillInputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(pillInputRef, draft);

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
    const files = attachments.items;
    if ((!text && files.length === 0) || attachments.busy || sending || !managerTerminal) return;
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
        useManagerChatStore.getState().enqueue(managerTerminal.id, text, files);
        setDraft("");
        attachments.clear();
        return;
      }
      setSending(true);
      try {
        if (await sendToManagerChat(managerTerminal.id, text, files)) {
          setDraft("");
          attachments.clear();
        } else useNotificationStore.getState().notify("warn", t.project_chat_send_not_ready);
      } catch (error) {
        useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error));
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
        // The agent's own terminal reads `@path` as a file too.
        withMentions(text, files.map((f) => f.path)),
      );
      if (result.ok) {
        setDraft("");
        attachments.clear();
      }
      else {
        useNotificationStore
          .getState()
          .notify("warn", result.detail ?? result.error ?? t.project_chat_send_failed);
      }
    } finally {
      setSending(false);
    }
  }, [draft, attachments, sending, managerTerminal, viewing, t]);

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


  const assignWorkspaceManager = useCallback(
    (terminalId: string | null) => {
      if (terminalId) seatManager(terminalId);
      else removeManager();
      returnToChat();
    },
    [returnToChat],
  );

  const spawnAndAssignManager = useCallback(
    (type: TerminalType) => {
      if (startManager(type)) returnToChat();
    },
    [returnToChat],
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
    useChatDockStore.getState().setResizing(true);
    const move = (ev: PointerEvent) => useChatDockStore.getState().setWidth(startWidth + ev.clientX - startX);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      useChatDockStore.getState().commitWidth();
      useChatDockStore.getState().setResizing(false);
      setDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, []);

  // ── Where the chat lives: docked, popped out or full screen ──
  const placement = useChatDockStore((s) => s.placement);
  const storedFloat = useChatDockStore((s) => s.floatRect);
  const viewSize = useWindowSize();
  const floatRect = clampFloatRect(storedFloat ?? defaultFloatRect(viewSize), viewSize);
  const [nearDock, setNearDock] = useState(false);
  const railEdge = CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP;

  /**
   * Dragging the header: a floating chat moves, and let go by the bar it
   * docks; a docked one dragged out pops out under the pointer.
   */
  const startMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, textarea, a")) return;
      if (placement !== "float" && placement !== "dock") return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const view = { width: window.innerWidth, height: window.innerHeight };
      const startX = e.clientX;
      const startY = e.clientY;
      let floating = placement === "float";
      let rect = floatRect;
      let offsetX = startX - rect.x;
      let offsetY = startY - rect.y;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < (floating ? 3 : 36)) return;
        moved = true;
        setDragging(true);
        const store = useChatDockStore.getState();
        if (!floating) {
          // Out of the dock: a window of its own, held where you grabbed it.
          const w = Math.min(Math.max(store.width, 380), 460);
          rect = { x: 0, y: 0, w, h: Math.min(640, view.height - 80) };
          offsetX = Math.min(startX - railEdge, w - 60);
          offsetY = Math.max(16, startY - (titleStripHeight() + CHROME_INSET));
          floating = true;
          store.setPlacement("float");
        }
        rect = clampFloatRect({ ...rect, x: ev.clientX - offsetX, y: ev.clientY - offsetY }, view);
        store.setFloatRect(rect);
        // The dock is after the navigator when that's docked.
        setNearDock(ev.clientX < chatDockLeft(railEdge, store, CHROME_GAP) + 40);
      };
      const up = (ev: PointerEvent) => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        setDragging(false);
        setNearDock(false);
        const store = useChatDockStore.getState();
        if (moved && floating && ev.clientX < chatDockLeft(railEdge, store, CHROME_GAP) + 40) store.setPlacement("dock");
        else if (moved) store.commitFloatRect();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [placement, floatRect, railEdge],
  );

  /** A floating chat's edges and corners resize it. */
  const startFloatResize = useCallback(
    (edges: { l?: boolean; r?: boolean; t?: boolean; b?: boolean }) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const view = { width: window.innerWidth, height: window.innerHeight };
      const start = floatRect;
      const sx = e.clientX;
      const sy = e.clientY;
      setDragging(true);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let { x, y, w, h } = start;
        if (edges.r) w = start.w + dx;
        if (edges.b) h = start.h + dy;
        if (edges.l) {
          w = Math.max(FLOAT_MIN.w, start.w - dx);
          x = start.x + start.w - w;
        }
        if (edges.t) {
          h = Math.max(FLOAT_MIN.h, start.h - dy);
          y = start.y + start.h - h;
        }
        useChatDockStore.getState().setFloatRect(clampFloatRect({ x, y, w, h }, view));
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        setDragging(false);
        useChatDockStore.getState().commitFloatRect();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [floatRect],
  );

  /** Esc to the manager's terminal: how Claude and Codex stop a turn. */
  const stopTurn = useCallback(() => {
    if (!managerTerminal) return;
    const ptyId = getLivePtyId(managerTerminal.id);
    if (ptyId != null) window.tacit.terminal.input(ptyId, "\x1b");
  }, [managerTerminal]);


  // Chat mode (T6): the manager's agent runs in the engine, not its tile.
  const chatMode = !!managerTerminal?.chatMode;
  const transcript = useManagerTranscript(chatMode ? managerTerminal!.id : null);
  const chatTerminalId = chatMode ? managerTerminal!.id : null;
  const sendQueued = useCallback(
    async (text: string, files?: ChatAttachmentInfo[]) => {
      if (!chatTerminalId) return false;
      const ok = await sendToManagerChat(chatTerminalId, text, files);
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
      // Terminal ids read as names, as in the chat.
      if (text && text.type === "text") return previewLine(text.text, terminalName);
    }
    return null;
  }, [transcript.messages]);

  const faceOpen = view !== "chat";
  const gridMode = useWorkdeskViewStore((s) => s.mode === "grid");
  const pageOpen = useCanvasPageStore((s) => s.page !== null);
  const fileOpen = useCanvasStore((s) => s.fileEditorPath !== null);
  const leftInset = useLeftChromeInset();

  // The manager's own task sits above the message box.
  const activeTask = useTaskOfTerminal(managerTerminal?.id ?? "");
  const running = chatMode ? transcript.running : conversation?.telemetry?.turn_state === "in_turn";
  // A move asked for mid-turn happens when the turn ends. One that no longer
  // applies (the manager already moved) is dropped.
  const pendingMove = usePendingManagerMove(managerTerminal?.id ?? null);
  useEffect(() => {
    if (managerTerminal && pendingMove) runPendingMove(managerTerminal.id, running, chatMode);
  }, [pendingMove, running, chatMode, managerTerminal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The manager in its terminal, with a chat mode: the panel shows the
  // terminal itself (the real one, typed into here), not a reading of it.
  const showsTerminal = !!managerTerminal && !chatMode && hasChatMode(managerTerminal.type);

  const agentLabel = managerTerminal ? agentName(managerTerminal.type) : null;

  // The setup card asks who runs a new workdesk; the Assign control waits
  // until it's answered, and there's nothing to assign without a folder.
  const settingUp = useManagerSetupStore((s) => (activeCanvas ? !!s.asking[activeCanvas.id] : false));
  const showAssign = !managerTerminal && projects.length > 0 && !settingUp;
  const [assignOpen, setAssignOpen] = useState(false);
  const assignRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!assignOpen) return;
    const close = (e: MouseEvent) => {
      if (!assignRef.current?.contains(e.target as Node)) setAssignOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [assignOpen]);
  useEffect(() => {
    if (!showAssign) setAssignOpen(false);
  }, [showAssign]);

  // The navigator is its own panel; docked, the chat starts after it.
  const listShown = useChatDockStore((s) => s.listShown);
  const listWidth = useChatDockStore((s) => s.listWidth);
  // An edge being dragged (the navigator's or the chat's): follow the pointer, no easing.
  const edgeDragging = useChatDockStore((s) => s.resizing);
  // Moving between docked, popped out and full screen, the box changes shape
  // while its contents re-lay out: they fade back in so the text never jumps.
  const innerRef = useRef<HTMLDivElement>(null);
  const lastPlacement = useRef(placement);
  useEffect(() => {
    if (lastPlacement.current === placement) return;
    lastPlacement.current = placement;
    innerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: prefersReducedMotion() ? MOTION.reduced.ms : MOTION.move.ms, easing: MOTION.enter.ease });
  }, [placement]);
  // On a small window it narrows toward its minimum, after the navigator has folded.
  const shownWidth = fittedChatWidth(dockWidth, viewSize.width - chatDockLeft(railEdge, { listShown, listWidth }, CHROME_GAP) - CHROME_INSET);
  useEffect(() => {
    useChatDockStore.getState().setShownWidth(shownWidth);
  }, [shownWidth]);
  // Something new on the workdesk (an agent, terminal, browser or file tile
  // added from a shortcut or the palette) while full screen: dock, so it shows.
  const nodeCount = useProjectStore((s) => s.projects.reduce((n, p) => n + p.worktrees.reduce((m, w) => m + w.terminals.length, 0), 0));
  const cardCount = useBrowserCardStore((s) => Object.keys(s.cards).length);
  const tileCount = useFileTileStore((s) => Object.keys(s.tiles).length);
  const lastCount = useRef(nodeCount + cardCount + tileCount);
  useEffect(() => {
    const total = nodeCount + cardCount + tileCount;
    const grew = total > lastCount.current;
    lastCount.current = total;
    if (grew && placement === "full" && dockOpen) useChatDockStore.getState().setPlacement("dock");
  }, [nodeCount, cardCount, tileCount, placement, dockOpen]);
  // Full screen is the chat alone: opening anything else (a page, a file, a
  // tab in the grid) brings the docked layout back.
  const gridOpenNode = useWorkdeskViewStore((s) => (s.mode === "grid" ? s.openNode : null));
  const lastGridNode = useRef(gridOpenNode);
  useEffect(() => {
    const changed = lastGridNode.current !== gridOpenNode;
    lastGridNode.current = gridOpenNode;
    if (placement === "full" && dockOpen && (pageOpen || fileOpen || (changed && gridOpenNode))) useChatDockStore.getState().setPlacement("dock");
  }, [placement, dockOpen, pageOpen, fileOpen, gridOpenNode]);
  // Tasks and other chats open on the canvas or in the grid, not in the
  // manager's place: on a window wide enough for the navigator, those faces
  // go back to the conversation.
  const wideWindow = viewSize.width >= CHAT_LIST_MIN_WINDOW;
  useEffect(() => {
    if (wideWindow && view === "sessions") setView("chat");
  }, [wideWindow, view, setView]);
  const readerTerminalId = useChatDockStore((s) => s.readerTerminalId);
  const { attention } = useLiveTree();
  const needsYouItem = attention.find((item) => item.terminalId !== managerTerminal?.id) ?? null;


  const iconButton =
    "tc-rail-btn inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";

  // ── Resting: the pill at the bottom, the record button right of it ─────
  // The pill sits on a bare canvas only: not in the grid, and not while a
  // page or a file is open beside the panels (the Manager row and the rail
  // say when it needs you there).
  const restingPill = !dockOpen && !gridMode && !pageOpen && !fileOpen && (
      <div
        // The pill and its record button share one row, centred together, so
        // what is being recorded sits beside who you are talking to.
        className="tc-enter-fade-up pointer-events-none fixed z-[95] flex -translate-x-1/2 items-end gap-2"
        // Centred on the canvas you can see, right of the docked panels.
        style={{ bottom: bottomOffset, left: `calc(${leftInset}px + (100vw - ${leftInset}px) / 2)` }}
      >
        <div className="pointer-events-auto flex flex-col items-center gap-2">
          {/* One line above the pill: what the manager is doing, or the last
              thing it said. */}
          {/* A request waiting on you is answered right here, chat open or not:
              answering it is what the pill is kept for. */}
          {managerTerminal && chatMode && transcript.questions[0] && (
            <div className={`w-[min(34rem,calc(100vw-2rem))] rounded-[14px] py-2 ${PILL_GLASS}`}>
              <QuestionForm
                key={transcript.questions[0].requestId}
                floating
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
                onAnswer={(requestId, decision, note) => void answerManagerApproval(managerTerminal.id, requestId, decision, note)}
                onPlanMode={(mode) => void configureChat(managerTerminal.id, { mode })}
                onSwitchToAuto={canSwitchToAuto(transcript) ? () => void configureChat(managerTerminal.id, { mode: "auto" }) : undefined}
                agent={managerTerminal.type}
              />
            </div>
          )}
          {managerTerminal && chatMode && transcript.approvals.length === 0 && (running || lastChatReply) && (
            // The reply opens the chat, to read it all.
            <button
              type="button"
              className={`tc-pill flex max-w-[34rem] items-center gap-1.5 px-3 py-1.5 text-left hover:border-[var(--border-hover)] ${PILL_GLASS}`}
              style={{ fontSize: "var(--text-xs)" }}
              onClick={() => setDockOpen(true)}
              title={t.chat_pill_open}
            >
              {running ? (
                <>
                  <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
                  <span style={{ color: "var(--cyan)" }}>{t.chat_working}</span>
                </>
              ) : (
                <span className="truncate text-[var(--text-muted)]">{lastChatReply}</span>
              )}
            </button>
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
            // A message box, not a button: type and Enter sends without
            // opening anything (the reply shows on the line above); ↗, ⌘J
            // or that line opens the whole chat wherever it lives.
            <div
              className={`tc-pill flex min-h-12 items-center gap-2 py-1.5 pl-2.5 pr-1.5 transition-colors duration-quick ${PILL_GLASS}`}
              style={{
                width: "min(32rem, calc(100vw - 26rem))",
                borderColor: running ? "color-mix(in srgb, var(--cyan) 40%, transparent)" : undefined,
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-tacit-file")) return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                const fromPanel = e.dataTransfer.getData("application/x-tacit-file");
                if (!fromPanel && e.dataTransfer.files.length === 0) return;
                e.preventDefault();
                e.stopPropagation();
                if (fromPanel) attachments.addPaths(fromPanel.split("\n").filter(Boolean));
                else attachments.addFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <ManagerMark agent={managerTerminal.type} size={24} working={managerWorking} />
              <label className="min-w-0 flex-1">
                <span className="sr-only">{t.project_chat_placeholder}</span>
                <textarea
                  ref={pillInputRef}
                  rows={1}
                  value={draft}
                  disabled={sending}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files);
                    if (files.length === 0) return;
                    e.preventDefault();
                    attachments.addFiles(files);
                  }}
                  onKeyDown={(e) => {
                    // The canvas listens globally for single-key shortcuts.
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={running || queuedCount > 0 ? (chatMode ? t.chat_placeholder_queued : t.project_chat_placeholder_running) : t.project_chat_placeholder}
                  className="block max-h-24 w-full resize-none bg-transparent py-1 text-[13px] leading-snug text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                />
              </label>
              {attachments.items.length > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)]" title={attachments.items.map((a) => a.name).join("\n")}>
                  <PaperclipIcon size={12} />
                  {attachments.items.length}
                </span>
              )}
              <button
                type="button"
                className="tc-rail-btn flex h-8 shrink-0 items-center gap-1.5 px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => setDockOpen(true)}
                title={`${t.chat_pill_open} (${shortcutLabel})`}
                aria-label={t.chat_pill_open}
              >
                <kbd className="tc-kbd">{shortcutLabel}</kbd>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3.5h6.5V10M12.5 3.5L4 12" />
                </svg>
              </button>
            </div>
          ) : showAssign ? (
            // No manager: one quiet control where the manager's input would
            // be. Assign opens the list of who could take the seat.
            <div className="relative" ref={assignRef}>
              {assignOpen && (
                <div
                  className="tc-menu-pop bottom-[calc(100%+8px)] left-1/2 w-[320px] -translate-x-1/2"
                  style={{ position: "absolute" }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAssignOpen(false);
                  }}
                >
                  <AssignMenu managerId={null} onPicked={() => setAssignOpen(false)} />
                </div>
              )}
              <div className={`tc-pill flex h-10 items-center gap-3 pl-4 pr-1.5 text-[13px] text-[var(--text-secondary)] ${PILL_GLASS}`}>
                {t.assign_none}
                <button
                  type="button"
                  aria-expanded={assignOpen}
                  aria-haspopup="menu"
                  className="inline-flex h-7 items-center rounded-full bg-[var(--text-primary)] px-3 text-[12px] font-medium text-[var(--bg)] hover:opacity-90"
                  onClick={() => setAssignOpen((v) => !v)}
                >
                  {t.assign_action}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
  );

  // ── Open: docked, popped out, full screen, or in the manager's tile ─────
  const ease = PANEL_TRANSITION_EASING_CSS;
  const shown = dockRevealed;
  let frameStyle: React.CSSProperties;
  // (innerRef and edgeDragging are set up with the other hooks above.)
  let innerClass = "absolute inset-0 flex flex-col";
  let innerStyle: React.CSSProperties = panelContentStyle(shown);
  if (placement === "dock") {
    // Unfolds from the rail like the panels do: the box opens while the
    // contents, laid out at full width, settle in behind its edge.
    frameStyle = {
      top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`,
      bottom: CHROME_INSET,
      left: chatDockLeft(railEdge, { listShown, listWidth }, CHROME_GAP),
      width: shown ? shownWidth : 0,
      opacity: shown ? 1 : 0,
      pointerEvents: shown ? undefined : "none",
      // Its left edge moves with the navigator as that opens or folds, on the
      // same curve and the same frame, so the two read as one motion; while
      // an edge is dragged it follows the pointer 1:1.
      transition: dragging || edgeDragging ? undefined : `${PANEL_REVEAL_TRANSITION}, ${PANEL_SHIFT_TRANSITION}`,
      borderRadius: 20,
    };
    innerClass = "absolute inset-y-0 left-0 flex flex-col";
    innerStyle = { width: shownWidth, ...panelContentStyle(shown) };
  } else if (placement === "float") {
    // Rises into place from its corner.
    frameStyle = {
      left: floatRect.x,
      top: floatRect.y,
      width: floatRect.w,
      height: floatRect.h,
      opacity: shown ? 1 : 0,
      transform: shown ? "none" : "translateY(12px) scale(0.97)",
      transformOrigin: "bottom right",
      pointerEvents: shown ? undefined : "none",
      transition: dragging ? undefined : `opacity 200ms ${ease}, transform ${PANEL_TRANSITION_DURATION_MS}ms ${ease}`,
      borderRadius: 18,
      boxShadow: "0 24px 60px -12px rgba(0,0,0,0.55)",
    };
    innerStyle = {};
  } else if (placement === "full") {
    // The whole window (the rail steps aside), the conversation in one
    // readable column. Sized by left and width, as docked is, so going
    // between the two grows or shrinks the same box instead of swapping it.
    frameStyle = {
      top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`,
      bottom: CHROME_INSET,
      left: CHROME_INSET,
      width: `calc(100vw - ${CHROME_INSET * 2}px)`,
      opacity: shown ? 1 : 0,
      pointerEvents: shown ? undefined : "none",
      transition: `${PANEL_REVEAL_TRANSITION}, ${PANEL_SHIFT_TRANSITION}`,
      borderRadius: 20,
    };
    innerClass = "absolute inset-y-0 inset-x-0 mx-auto flex w-full max-w-[880px] flex-col";
  } else {
    frameStyle = { opacity: shown ? 1 : 0, transition: `opacity 200ms ${ease}` };
    innerStyle = {};
  }


  return (
    <>
    {restingPill}
    {nearDock && (
      // Let go here and it docks.
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[69] rounded-[20px] border-2 border-dashed"
        style={{ top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`, bottom: CHROME_INSET, left: chatDockLeft(railEdge, { listShown, listWidth }, CHROME_GAP), width: dockWidth, borderColor: "color-mix(in srgb, var(--cyan) 60%, transparent)", background: "color-mix(in srgb, var(--cyan) 7%, transparent)" }}
      />
    )}
    {dockMounted && (
    <aside
      className={`tc-float tc-manager-panel fixed overflow-hidden ${placement === "float" ? "z-[70]" : placement === "full" ? "z-[39]" : "z-[44]"}`}
      aria-label={t.project_chat_title}
      aria-hidden={!dockOpen}
      style={
        {
          ...frameStyle,
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
      <div ref={innerRef} className={innerClass} style={innerStyle}>
      {/* The lit edge, in the colour of whoever holds the seat. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{ background: `linear-gradient(90deg, transparent, ${speakingHue ?? "var(--accent)"}, transparent)`, opacity: 0.7 }}
      />

      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">

      {/* Header: the mark, who runs this workdesk, and the controls. A chat
          opened from the list draws its own. */}
      {view !== "sessions" && (
      <div
        className="flex h-[60px] shrink-0 items-center gap-2.5 pl-3.5 pr-2"
        style={{ cursor: placement === "float" ? (dragging ? "grabbing" : "grab") : undefined }}
        // Drag to move a floating chat, or to pop the docked one out;
        // double-click to swap between the two.
        onPointerDown={startMove}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (placement === "dock" || placement === "float") useChatDockStore.getState().setPlacement(placement === "dock" ? "float" : "dock");
        }}
      >
        {/* Full screen has no rail: the way back to the list (and the docked layout) is here. */}
        {placement === "full" && (
          <button
            type="button"
            className={iconButton}
            onClick={() => useChatDockStore.getState().showList()}
            title={t.chat_full_show_list}
            aria-label={t.chat_full_show_list}
          >
            <SidebarGlyph />
          </button>
        )}
        <ManagerMark agent={speakingCli} size={34} working={managerWorking && isLive} />
        <button
          type="button"
          className="tc-rail-btn flex min-w-0 flex-col items-start px-1.5 py-1 text-left"
          onClick={openRoster}
          title={t.project_chat_assign}
          aria-haspopup="true"
        >
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{t.project_chat_title}</span>
          <span className="flex max-w-full items-center gap-1 truncate text-[11px] text-[var(--text-muted)]">
            <span className="truncate">{agentLabel ? `${agentLabel} · ${managerLabel}` : t.project_chat_empty_seat}</span>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </button>
        <div className="flex-1" />
        {/* Full screen stays one click away; the rest is in ⋯: Terminal or
            Chat, where the chat lives, and going to the manager's tile. */}
        <ChatFullScreenToggle buttonClass={iconButton} />
        <ChatPlacementMenu
          buttonClass={iconButton}
          mode={
            managerTerminal && view === "chat" && !viewing && hasChatMode(managerTerminal.type)
              ? {
                  current: chatMode ? "chat" : "terminal",
                  pending: pendingMove,
                  onPick: (to) => void pickAgentMode(managerTerminal.id, to, chatMode, running, pendingMove),
                }
              : null
          }
          extras={managerTerminal ? [{ label: t.project_chat_go_to, onClick: flyToManager }] : []}
        />
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

      )}

      {view !== "sessions" && <div className="shrink-0 border-b border-[var(--border)]" />}

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
          <span className="text-[12px] text-[var(--text-muted)]">
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
          <div className="text-[13px]" style={{ color: "var(--red)" }}>{t.chat_failure_title}</div>
          <div className="mt-1 line-clamp-3 text-[12px] text-[var(--text-secondary)]">{transcript.failure}</div>
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

      {view === "chat" && !viewing && managerTerminal && pendingMove && (
        <PendingSwitchLine terminalId={managerTerminal.id} className="mx-3 mt-2 shrink-0" />
      )}
      {view === "chat" && !viewing && showsTerminal && managerTerminal && <PanelTerminal terminalId={managerTerminal.id} />}

      {view === "chat" && !chatMode && conversation && !(showsTerminal && !viewing) && (
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

      {/* A chat opened from the list: an agent in a terminal, read live; a
          chat-mode agent or a past session, in the session reader. */}
      {view === "sessions" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {readerTerminalId ? <TerminalConversation terminalId={readerTerminalId} /> : <SessionReader />}
        </div>
      )}


      {view === "roster" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!managerTerminal && (
            <div className="px-2.5 pb-2 pt-3">
              <div className="text-[16px] font-semibold text-[var(--text-primary)]">{t.assign_panel_title}</div>
              <div className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{t.assign_panel_body}</div>
            </div>
          )}
          {managerTerminal && (
            <div className="tc-menu-option pointer-events-none">
              <img src={agentIcon(managerTerminal.type)} alt="" className="h-4 w-4 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate">{agentLabel} · {managerLabel}</span>
              <span className="tc-mono shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                {t.project_chat_holding}
              </span>
            </div>
          )}
          {projects.length === 0 ? (
            <div className="px-2.5 py-2 text-[13px] text-[var(--text-muted)]">{t.manager_needs_folder}</div>
          ) : (
            <AssignMenu managerId={managerTerminal?.id ?? null} onPicked={returnToChat} />
          )}
          {managerTerminal && (
            <>
              <div className="mx-2 my-1.5 h-px bg-[var(--border)] opacity-60" />
              <button
                type="button"
                className="tc-menu-option"
                style={{ color: "var(--red)" }}
                onClick={() => {
                  // Asks first, and says what keeps running: removing the
                  // manager never stops its terminal or the workers it started.
                  void confirmAsync({
                    title: t.project_chat_remove_title,
                    body: t.project_chat_remove_body(agentLabel || t.project_chat_title),
                    confirmLabel: t.project_chat_remove_action,
                    confirmTone: "danger",
                    focusCancel: true,
                  }).then((ok) => {
                    if (ok) assignWorkspaceManager(null);
                  });
                }}
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
          <span className="tc-mono truncate text-[var(--text-muted)]" style={{ fontSize: "var(--text-xs)" }}>
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

      {/* The task, plan and limit lines; questions, approvals and queued
          messages wait behind the message box. */}
      {view === "chat" && !viewing && chatMode && managerTerminal && (
        <div className="shrink-0 pt-1">
          {activeTask ? (
            <TaskBar task={activeTask} onOpen={() => openTask(activeTask.id)} />
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
        </div>
      )}

      {view === "chat" && !viewing && managerTerminal && !showsTerminal && (
        <div className="shrink-0 px-3 pb-3">
          {/* Folded away, the list still says when a chat needs you. */}
          {!listShown && needsYouItem && (
            <button
              type="button"
              className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-left hover:border-[var(--border-hover)]"
              style={{ fontSize: "var(--text-xs)" }}
              // Live things are tiles: it flies there (or opens its tab in the
              // grid); the panel stays the manager's.
              onClick={() => openListedLiveChat(needsYouItem.terminalId)}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--amber)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{t.chat_list_needs_you(needsYouItem.title)}</span>
              <span className="shrink-0 text-[var(--text-primary)]">{t.chat_list_open}</span>
            </button>
          )}
          {running && !chatMode && conversation && (
            <div className="flex items-center gap-2 px-1 py-1.5" style={{ fontSize: "var(--text-xs)" }}>
              <PeekLine conversation={conversation} bare />
              <button
                type="button"
                className="tc-rail-btn ml-auto flex h-6 items-center gap-1.5 border border-[var(--border)] px-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
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
          <ComposerBox
            agent={managerTerminal?.type}
            inputRef={inputRef}
            value={draft}
            onChange={setDraft}
            onSubmit={() => void send()}
            disabled={sending}
            placeholder={running || queuedCount > 0 ? (chatMode ? t.chat_placeholder_queued : t.project_chat_placeholder_running) : t.project_chat_placeholder}
            attachments={attachments}
            settings={chatMode ? <ComposerSettings terminalId={managerTerminal.id} transcript={transcript} agent={managerTerminal.type} /> : undefined}
            meter={chatMode ? <UsageMeter transcript={transcript} agent={managerTerminal.type} /> : undefined}
            canSend={(!!draft.trim() || attachments.items.length > 0) && !attachments.busy && !sending}
            running={running && chatMode && pendingMove !== "terminal"}
            onStop={() => void interruptManagerChat(managerTerminal.id)}
            behind={
              chatMode ? (
                <>
                  <QueuedMessages
                    terminalId={managerTerminal.id}
                    onSendNow={(text, files) =>
                      void sendQueued(text, files).catch((error: unknown) =>
                        useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error)),
                      )
                    }
                  />
                  <CanvasAsks terminalId={managerTerminal.id} />
                  <ApprovalCards
                    approvals={transcript.approvals}
                    onAnswer={(requestId, decision, note) => void answerManagerApproval(managerTerminal.id, requestId, decision, note)}
                    onPlanMode={(mode) => void configureChat(managerTerminal.id, { mode })}
                    onSwitchToAuto={canSwitchToAuto(transcript) ? () => void configureChat(managerTerminal.id, { mode: "auto" }) : undefined}
                    onFollowUp={(text) => useManagerChatStore.getState().enqueue(managerTerminal.id, text, [])}
                    agent={managerTerminal.type}
                  />
                  {transcript.questions[0] && (
                    <QuestionForm
                      key={transcript.questions[0].requestId}
                      pending={transcript.questions[0]}
                      agentName={agentName(managerTerminal.type)}
                      onSubmit={(answers) => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, answers)}
                      onSkip={() => void answerChatQuestion(managerTerminal.id, transcript.questions[0].requestId, null)}
                    />
                  )}
                </>
              ) : undefined
            }
          />
        </div>
      )}

      </div>
      </div>

      {/* A floating chat resizes from its edges and corners. */}
      {placement === "float" && (
        <>
          <div aria-hidden="true" className="absolute inset-y-3 left-0 z-10 w-1.5 cursor-ew-resize" onPointerDown={startFloatResize({ l: true })} />
          <div aria-hidden="true" className="absolute inset-y-3 right-0 z-10 w-1.5 cursor-ew-resize" onPointerDown={startFloatResize({ r: true })} />
          <div aria-hidden="true" className="absolute inset-x-3 top-0 z-10 h-1.5 cursor-ns-resize" onPointerDown={startFloatResize({ t: true })} />
          <div aria-hidden="true" className="absolute inset-x-3 bottom-0 z-10 h-1.5 cursor-ns-resize" onPointerDown={startFloatResize({ b: true })} />
          <div aria-hidden="true" className="absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-nwse-resize" onPointerDown={startFloatResize({ r: true, b: true })} />
          <div aria-hidden="true" className="absolute bottom-0 left-0 z-10 h-3.5 w-3.5 cursor-nesw-resize" onPointerDown={startFloatResize({ l: true, b: true })} />
        </>
      )}
      {/* The right edge: drag to resize; double-click for the default width. */}
      {placement === "dock" && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.project_chat_resize}
        title={t.project_chat_resize}
        className="group/resize absolute bottom-0 right-0 top-0 z-10 w-2 cursor-col-resize"
        onPointerDown={startResize}
        onDoubleClick={() => {
          useChatDockStore.getState().setWidth(440);
          useChatDockStore.getState().commitWidth();
        }}
      >
        {/* The whole edge lights up on hover and while dragging, as the side
            panel's does. A short grip in the middle read as a scrollbar. */}
        <span
          className={`absolute bottom-0 right-0 top-0 w-px transition-colors duration-quick ${dragging ? "" : "bg-transparent group-hover/resize:bg-[var(--accent)]"}`}
          style={dragging ? { background: "var(--cyan)" } : undefined}
        />
      </div>
      )}
      </div>
    </aside>
    )}
    </>
  );
}


/**
 * The manager's live terminal in the panel: the same one its tile and Grid
 * tab show, drawn here while the panel is open. One place draws it at a
 * time; where it isn't, a line says where it is, with Show here.
 */
function PanelTerminal({ terminalId }: { terminalId: string }) {
  const t = useT();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [borrowed, setBorrowed] = useState(true);
  const [reborrow, setReborrow] = useState(0);
  const holder = useTerminalViewHolder(terminalId);
  const runtimeEpoch = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.epoch ?? 0);
  useLayoutEffect(() => {
    if (!container) return;
    const preferred = usePreferencesStore.getState().terminalFontSize;
    const giveBack = borrowTerminalView(terminalId, container, Math.min(preferred, 12), "panel");
    setBorrowed(giveBack !== null);
    if (!giveBack) return;
    const observer = new ResizeObserver(() => fitTerminalRuntime(terminalId));
    observer.observe(container);
    return () => {
      observer.disconnect();
      giveBack();
    };
  }, [container, terminalId, runtimeEpoch, reborrow]);
  return (
    <div className="relative mx-2 mb-2 mt-2 min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]" style={{ cornerShape: "round" } as React.CSSProperties}>
      <div ref={setContainer} className="absolute inset-0 m-1.5" />
      {(!borrowed || holder !== "panel") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg)] px-6 text-center">
          <div className="text-[13px] text-[var(--text-primary)]">{borrowed ? t.term_shown_elsewhere : t.workdesk_terminal_canvas_only}</div>
          {borrowed && (
            <button
              type="button"
              className="tc-rail-btn h-7 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              onClick={() => setReborrow((n) => n + 1)}
            >
              {t.term_show_here}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
