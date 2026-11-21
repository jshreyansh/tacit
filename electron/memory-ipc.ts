import fs from "node:fs";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryAction,
  type MemoryKind,
  type MemoryScope,
  type MemoryViewData,
  type MemoryViewRequest,
} from "../shared/memory";
import type { MemoryStore } from "./memory-store";

/**
 * The Memory view's IPC (src/components/MemoryView.tsx): reading a
 * workdesk's or a folder's memory, and the person's own actions on it.
 *
 * Narrow on purpose. Reads take a workdesk id and folder paths (absolute,
 * existing folders); actions on a note take its file, which the store
 * refuses outside Tacit's memory folder. Nothing here writes a CLI's own
 * memory.
 */

const isFolder = (value: unknown): value is string => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
};

const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);

export function readMemoryView(store: MemoryStore, request: MemoryViewRequest): MemoryViewData {
  const workdeskId = isId(request.workdeskId) ? request.workdeskId : null;
  const folder = isFolder(request.folder) ? store.placeOf(request.folder).folder : null;
  const place = { workdeskId, folder };
  const worktrees = (Array.isArray(request.worktrees) ? request.worktrees : [])
    .filter(isFolder)
    .map((p) => store.placeOf(p))
    .filter((p) => p.folder === folder && p.worktree)
    .map((p) => ({ path: p.worktree!, notes: store.list("worktree", p) }));
  return {
    you: workdeskId ? store.list("you", place) : [],
    workdesk: workdeskId ? store.list("workdesk", place) : [],
    pending: workdeskId ? store.pending() : [],
    folder: folder ? store.list("folder", place) : [],
    folderPath: folder,
    worktrees,
    native: folder ? [{ cli: "claude", dir: store.claudeMemoryDir(folder), notes: store.claudeMemory(folder) }] : [],
  };
}

export function applyMemoryAction(store: MemoryStore, raw: unknown): { ok: boolean; reason?: string } {
  const action = raw as MemoryAction | null;
  if (!action || typeof action !== "object") return { ok: false, reason: "invalid action" };
  switch (action.action) {
    case "approve":
    case "restore":
    case "forget":
    case "delete":
      return typeof action.filePath === "string" && store.actOn(action.filePath, action.action)
        ? { ok: true }
        : { ok: false, reason: "no such note" };
    case "edit": {
      if (typeof action.filePath !== "string") return { ok: false, reason: "no such note" };
      const change: { description?: string; body?: string } = {};
      if (typeof action.description === "string" && action.description.trim()) change.description = action.description.trim();
      if (typeof action.body === "string") change.body = action.body;
      return store.actOn(action.filePath, change) ? { ok: true } : { ok: false, reason: "no such note" };
    }
    case "add": {
      if (!(MEMORY_SCOPES as readonly string[]).includes(action.scope)) return { ok: false, reason: "invalid scope" };
      if (!(MEMORY_KINDS as readonly string[]).includes(action.kind) || action.kind === "event") return { ok: false, reason: "invalid kind" };
      if (typeof action.name !== "string" || typeof action.description !== "string" || typeof action.body !== "string" || !action.body.trim()) {
        return { ok: false, reason: "a note needs a title and text" };
      }
      const scope = action.scope as MemoryScope;
      const place = {
        workdeskId: isId(action.workdeskId) ? action.workdeskId : null,
        folder: isFolder(action.folder) ? store.placeOf(action.folder).folder : null,
        worktree: isFolder(action.folder) ? store.placeOf(action.folder).worktree : null,
      };
      const result = store.write(scope, place, {
        name: action.name || action.description,
        kind: action.kind as MemoryKind,
        description: action.description || action.name,
        body: action.body,
        author: "you",
      });
      return result.filePath ? { ok: true } : { ok: false, reason: result.reason ?? "not saved" };
    }
    default:
      return { ok: false, reason: "invalid action" };
  }
}

/**
 * Registers the handlers, and tells the window when anything in Tacit's
 * memory changes (an agent's write, the person's edit), so an open Memory
 * view stays current.
 */
export function registerMemoryIpc(options: {
  ipcMain: IpcMain;
  store: MemoryStore;
  isAppSender: (event: IpcMainInvokeEvent) => boolean;
  notifyChanged: () => void;
}): () => void {
  const { ipcMain, store, isAppSender, notifyChanged } = options;
  ipcMain.handle("memory:view", (event, request: unknown) => {
    if (!isAppSender(event)) return null;
    return readMemoryView(store, (request ?? {}) as MemoryViewRequest);
  });
  // Whether a note an agent saved is still there, and as what: a chat's
  // "Saved" card asks so it doesn't offer Undo for a note already gone.
  // Only files inside Tacit's memory are read.
  ipcMain.handle("memory:note-status", (event, filePath: unknown) => {
    if (!isAppSender(event)) return null;
    if (typeof filePath !== "string" || filePath.length > 4096) return null;
    return store.noteAt(filePath)?.status ?? null;
  });
  ipcMain.handle("memory:act", (event, action: unknown) => {
    if (!isAppSender(event)) return { ok: false, reason: "not allowed" };
    const result = applyMemoryAction(store, action);
    if (result.ok) notifyChanged();
    return result;
  });

  let watcher: fs.FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.mkdirSync(store.root, { recursive: true });
    watcher = fs.watch(store.root, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(notifyChanged, 300);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
