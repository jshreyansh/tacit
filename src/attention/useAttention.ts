import { drawingInView } from "../board/agentOps";
import { changeWords, openCanvasRequest, startCanvasRequests, useCanvasRequestStore, wantsTo } from "../board/canvasRequests";
import { keepToast } from "./attentionToasts";
import { useEffect, useMemo } from "react";

import type { AttentionNotice, AttentionTarget } from "../../shared/attention";
import { findTerminal } from "../actions/terminalLookup";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { openTask } from "../tasks/taskActions";
import { useTaskStore } from "../tasks/taskStore";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { TERMINAL_TYPE_CONFIG } from "../terminal/terminalTypeConfig";
import { panToTerminal } from "../utils/panToTerminal";
import { attentionText, folderName } from "./attentionText";
import { waitingTotal } from "./waitingCount";
import { useWaitingItems } from "./waiting";

/** A running agent's tile: its name, folder and workdesk. Only the open workdesk runs agents. */
function placeOf(terminalId: string) {
  const found = findTerminal(terminalId);
  const { canvases, activeCanvasId } = useCanvasRegistryStore.getState();
  const workdesk = canvases.find((c) => c.id === activeCanvasId)?.name ?? null;
  if (!found) return { name: null, workdesk };
  const { terminal, worktree, project } = found;
  return {
    name: terminal.customTitle?.trim() || TERMINAL_TYPE_CONFIG[terminal.type]?.label || terminal.title,
    folder: folderName(worktree, project),
    workdesk,
  };
}

/** They already have this agent or task in front of them, so a toast would say nothing new. */
function isViewing(target: AttentionTarget): boolean {
  const { mode, openNode } = useWorkdeskViewStore.getState();
  if (target.kind === "terminal") {
    if (mode === "grid") return openNode?.kind === "terminal" && openNode.id === target.terminalId;
    return !!findTerminal(target.terminalId)?.terminal.focused;
  }
  if (target.kind === "canvas") {
    const request = useCanvasRequestStore.getState().requests.find((x) => x.id === target.requestId);
    if (!request || request.workdesk === null || !activeIs(request.workdesk)) return false;
    const onBoard = mode === "grid" ? openNode?.kind === "tasks" : useCanvasPageStore.getState().page === "tasks";
    // On the board, marked on its drawing, or on its agent in front of them.
    return onBoard || drawingInView(request.targets[0]) || isViewing({ kind: "terminal", terminalId: request.terminalId });
  }
  const { openTask: open } = useTaskStore.getState();
  const board = mode === "grid" ? openNode?.kind === "tasks" : useCanvasPageStore.getState().page === "tasks";
  return board && (open === target.taskId || open === null) && activeIs(target.workdesk);
}

function showToast(notice: AttentionNotice, text: { title: string; body: string }, t: ReturnType<typeof useT>): void {
  const { notify, dismiss } = useNotificationStore.getState();
  const type = notice.kind === "failed" ? "error" : notice.kind === "finished" ? "info" : "warn";
  const label =
    notice.kind === "failed"
      ? t["attention.toastFailed"]
      : notice.kind === "finished"
        ? t["attention.toastFinished"]
        : t["attention.toastNeedsYou"];
  const id = notify(
    type,
    (notice.kind === "needs_you" && notice.target.kind !== "canvas" ? [notice.detail, text.body] : [text.title, text.body]).filter(Boolean).join(" · "),
    {
      label: t["attention.open"],
      run: () => {
        dismiss(id);
        openTarget(notice.target);
      },
    },
    label,
  );
  keepToast(id, notice.kind === "needs_you");
}

/** Who wants to do what on the canvas. */
function canvasText(requestId: string, t: ReturnType<typeof useT>): { title: string; body: string } | null {
  const request = useCanvasRequestStore.getState().requests.find((x) => x.id === requestId);
  if (!request) return null;
  const name = request.titles.length === 1 ? `"${request.titles[0]}"` : t.canvas_ask_several(request.titles.length);
  const words = changeWords(request);
  if (wantsTo(request) === "rename" && words.length === 1) return { title: t.canvas_ask_wants.rename(request.name), body: words[0] };
  return { title: `${t.canvas_ask_wants[wantsTo(request)](request.name)} ${name}`, body: words.join(", ") };
}

/** Brings the clicked notification's agent or task into view. */
function openTarget(target: AttentionTarget): void {
  const view = useWorkdeskViewStore.getState();
  if (target.kind === "terminal") {
    // The tile may have closed since; then just Tacit comes forward.
    if (!findTerminal(target.terminalId)) return;
    if (view.mode === "grid") view.setOpenNode({ kind: "terminal", id: target.terminalId });
    else panToTerminal(target.terminalId);
    return;
  }
  // It may be on another workdesk; go there first.
  const registry = useCanvasRegistryStore.getState();
  const { workdesk } = target;
  if (workdesk === null || !registry.canvases.some((c) => c.id === workdesk)) return;
  registry.switchCanvas(workdesk);
  if (target.kind === "canvas") openCanvasRequest(target.requestId);
  else openTask(target.taskId);
}
const activeIs = (workdesk: string) => useCanvasRegistryStore.getState().activeCanvasId === workdesk;

/**
 * Notifications (T16), the window's half: tells main the settings and how
 * many tasks wait on the person (for the dock badge), writes each notice's
 * words, shows the toasts for when Tacit is focused, and opens what a clicked
 * notification was about.
 */
export function useAttention(): void {
  const t = useT();
  const prefs = usePreferencesStore((s) => s.attentionPrefs);
  // Everything waiting on the person, every workdesk added up (attention/waitingCount.ts): the dock's number.
  const waitingItems = useWaitingItems();
  // Not until the tasks are loaded: a count of half of them is wrong, and main has its own until then.
  const loaded = useTaskStore((s) => s.loaded);
  const needsYouTasks = useMemo(() => (loaded ? waitingTotal(waitingItems) : null), [waitingItems, loaded]);
  useEffect(() => startCanvasRequests(), []);

  useEffect(() => {
    void window.tacit.attention.configure({ prefs, needsYouTasks });
  }, [prefs, needsYouTasks]);

  useEffect(
    () =>
      window.tacit.attention.onNotice((notice: AttentionNotice) => {
        const place = notice.target.kind === "terminal" ? placeOf(notice.target.terminalId) : { name: null };
        const text = notice.target.kind === "canvas" ? canvasText(notice.target.requestId, t) : attentionText(notice, place, t);
        // Answered before it could be said.
        if (!text) return;
        if (notice.surface === "banner") void window.tacit.attention.answer(notice.id, text);
        else if (!isViewing(notice.target)) showToast(notice, text, t);
      }),
    [t],
  );

  useEffect(() => window.tacit.attention.onOpen(openTarget), []);
}
