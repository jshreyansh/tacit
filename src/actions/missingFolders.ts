import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { useLocaleStore } from "../stores/localeStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { confirmAsync } from "../components/ui/confirmAsync";

/**
 * A workdesk folder that's gone: deleted, moved, or on a drive that isn't
 * mounted. Its agents aren't started (each would only fail), and instead of
 * one error per agent the person gets one notice per folder that stays until
 * they choose: Locate… (point it at where the files are now, and its agents
 * start there) or Remove (take it off the workdesk).
 */

const dictionaries = { en, zh } as const;
const getT = () => ({ ...en, ...dictionaries[useLocaleStore.getState().locale] });

/** Whether each folder is there, asked once per launch and per relocation. */
const checked = new Map<string, Promise<boolean>>();
let batch: { paths: Set<string>; done: Promise<Set<string>> } | null = null;

/** Folders asked about together share one question to the main process. */
function missingAmong(path: string): Promise<Set<string>> {
  if (!batch) {
    const paths = new Set<string>();
    const done = Promise.resolve().then(async () => {
      batch = null;
      return new Set(await window.tacit.project.missingFolders([...paths]));
    });
    batch = { paths, done };
  }
  batch.paths.add(path);
  return batch.done;
}

export function folderIsThere(path: string): Promise<boolean> {
  if (!window.tacit?.project?.missingFolders || !path) return Promise.resolve(true);
  let known = checked.get(path);
  if (!known) {
    known = missingAmong(path).then((missing) => !missing.has(path));
    checked.set(path, known);
  }
  return known;
}

/** The same, asked now: for starting something new, long after the launch's answer. */
export function folderIsThereNow(path: string): Promise<boolean> {
  checked.delete(path);
  return folderIsThere(path);
}

/** Called when starting failed because the folder isn't there after all. */
export function isMissingFolderError(message: string): boolean {
  return message.includes("Directory does not exist") || message.includes("folder doesn't exist");
}

/** Per folder: the agents that couldn't start, and the notice shown for them. */
const waiting = new Map<string, { terminals: Set<string>; timer: ReturnType<typeof setTimeout> | null; noticeId: string | null }>();

function projectHolding(worktreePath: string) {
  for (const project of useProjectStore.getState().projects) {
    if (project.worktrees.some((w) => w.path === worktreePath)) return project;
  }
  return null;
}

/**
 * An agent couldn't start because its folder is gone. Agents of the same
 * folder found missing together make one notice.
 */
export function noteMissingFolder(worktreePath: string, terminalId: string): void {
  checked.set(worktreePath, Promise.resolve(false));
  const project = projectHolding(worktreePath);
  if (!project) return;
  let entry = waiting.get(project.id);
  if (!entry) {
    entry = { terminals: new Set(), timer: null, noticeId: null };
    waiting.set(project.id, entry);
  }
  if (entry.terminals.has(terminalId)) return;
  entry.terminals.add(terminalId);
  if (entry.noticeId) {
    // Already asked; a later agent of the same folder joins the count.
    useNotificationStore.getState().dismiss(entry.noticeId);
    entry.noticeId = null;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => showNotice(project.id), 400);
}

function showNotice(projectId: string): void {
  const entry = waiting.get(projectId);
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!entry || !project) return;
  entry.timer = null;
  const t = getT();
  const notifications = useNotificationStore.getState();
  const close = () => {
    if (entry.noticeId) notifications.dismiss(entry.noticeId);
    entry.noticeId = null;
  };
  entry.noticeId = notifications.notify("warn", t.folder_missing_body(project.name, entry.terminals.size, project.path), undefined, t.folder_missing_label, {
    sticky: true,
    actions: [
      {
        label: t.folder_missing_locate,
        run: () => {
          void locate(projectId).then((moved) => {
            if (moved) close();
          });
        },
      },
      {
        label: t.folder_missing_remove,
        run: () => {
          void remove(projectId).then((removed) => {
            if (removed) close();
          });
        },
      },
    ],
  });
}

async function locate(projectId: string): Promise<boolean> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return true;
  const picked = await window.tacit.project.selectDirectory();
  if (!picked) return false;
  const terminals = waiting.get(projectId)?.terminals ?? new Set<string>();
  waiting.delete(projectId);
  for (const w of project.worktrees) checked.delete(w.path);
  // The agents that couldn't start are stopped for good, so they start
  // again in the folder's new place once the canvas sees it.
  const { destroyTerminalRuntime } = await import("../terminal/terminalRuntimeStore");
  for (const id of terminals) destroyTerminalRuntime(id, { caller: "missingFolders.locate", reason: "folder_relocated" });
  useProjectStore.getState().relocateProject(projectId, picked);
  const { findTerminal } = await import("./terminalLookup");
  const { startTerminalChat } = await import("./managerChatMode");
  for (const id of terminals) {
    if (findTerminal(id)?.terminal.chatMode) void startTerminalChat(id);
  }
  useNotificationStore.getState().notify("info", getT().folder_relocated(useProjectStore.getState().projects.find((p) => p.id === projectId)?.name ?? project.name));
  return true;
}

async function remove(projectId: string): Promise<boolean> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return true;
  const t = getT();
  const terminals = project.worktrees.reduce((n, w) => n + w.terminals.length, 0);
  const ok = await confirmAsync({
    title: t.folder_remove_title(project.name),
    body: terminals > 0 ? t.panel_project_remove_confirm_with_terminals(project.name, terminals) : t.panel_project_remove_confirm(project.name),
    confirmLabel: t.folder_remove_action,
    confirmTone: "danger",
    focusCancel: true,
  });
  if (!ok) return false;
  waiting.delete(projectId);
  useProjectStore.getState().removeProject(projectId);
  useNotificationStore.getState().notify("info", t.panel_project_removed(project.name));
  return true;
}
