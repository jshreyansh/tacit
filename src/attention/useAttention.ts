import { useEffect, useMemo } from "react";

import type { AttentionNotice, AttentionTarget } from "../../shared/attention";
import { findTerminal } from "../actions/terminalLookup";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePinStore } from "../stores/pinStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useProjectStore } from "../stores/projectStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { tasksNeedingYou } from "../tasks/taskModel";
import { openPinFull } from "../tasks/TasksView";
import { TERMINAL_TYPE_CONFIG } from "../terminal/terminalTypeConfig";
import { panToTerminal } from "../utils/panToTerminal";
import { attentionText, folderName } from "./attentionText";

/** The tasks waiting on the person across every workdesk, each counted once. */
function useNeedsYouTaskCount(): number {
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const projects = useProjectStore((s) => s.projects);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useMemo(() => {
    const paths = new Set(projects.map((p) => p.path));
    for (const canvas of canvases) {
      if (canvas.id === activeCanvasId) continue;
      for (const project of canvas.scene.projects) paths.add(project.path);
    }
    return tasksNeedingYou(pinsByProject, paths).length;
  }, [pinsByProject, projects, canvases, activeCanvasId]);
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
  if (mode === "grid") return openNode?.kind === "task" && openNode.id === target.taskId;
  return usePinStore.getState().openDetailPinId === target.taskId;
}

/** A burst of agents shows the latest few, not a column up the window. */
const MAX_ATTENTION_TOASTS = 3;
const attentionToasts: string[] = [];

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
    [text.title, text.body].filter(Boolean).join(" · "),
    {
      label: t["attention.open"],
      run: () => {
        dismiss(id);
        openTarget(notice.target);
      },
    },
    label,
  );
  attentionToasts.push(id);
  while (attentionToasts.length > MAX_ATTENTION_TOASTS) dismiss(attentionToasts.shift()!);
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
  // A task's project may be on another workdesk; go there first.
  const registry = useCanvasRegistryStore.getState();
  const onActive = useProjectStore.getState().projects.some((p) => p.path === target.repo);
  if (!onActive) {
    const other = registry.canvases.find((c) => c.scene.projects.some((p) => p.path === target.repo));
    if (other) registry.switchCanvas(other.id);
  }
  const pin = usePinStore.getState().pinsByProject[target.repo]?.find((p) => p.id === target.taskId);
  if (pin) openPinFull(pin);
}

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
