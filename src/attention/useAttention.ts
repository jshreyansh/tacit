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

/** The tasks waiting on the person across every workdesk, each counted once. */
function useNeedsYouTaskCount(): number {
  const tasks = useTaskStore((s) => s.tasks);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  return useMemo(() => {
    const here = new Set(canvases.map((c) => c.id));
    // A permission is counted by its terminal.
    return Object.values(tasks).filter((t) => here.has(t.workdesk) && t.requests.some((r) => r.kind !== "allow")).length;
  }, [tasks, canvases]);
}

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
    (notice.kind === "needs_you" ? [notice.detail, text.body] : [text.title, text.body]).filter(Boolean).join(" · "),
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
  if (!registry.canvases.some((c) => c.id === target.workdesk)) return;
  registry.switchCanvas(target.workdesk);
  openTask(target.taskId);
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
  const needsYouTasks = useNeedsYouTaskCount();

  useEffect(() => {
    void window.tacit.attention.configure({ prefs, needsYouTasks });
  }, [prefs, needsYouTasks]);

  useEffect(
    () =>
      window.tacit.attention.onNotice((notice: AttentionNotice) => {
        const place = notice.target.kind === "terminal" ? placeOf(notice.target.terminalId) : { name: null };
        const text = attentionText(notice, place, t);
        if (notice.surface === "banner") void window.tacit.attention.answer(notice.id, text);
        else if (!isViewing(notice.target)) showToast(notice, text, t);
      }),
    [t],
  );

  useEffect(() => window.tacit.attention.onOpen(openTarget), []);
}
