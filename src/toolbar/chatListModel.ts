import type { CanvasTerminalItem } from "../components/sessionPanelModel";
import { filterChatHistory, type ChatHistoryEntry } from "./chatHistoryModel";
import { filterLiveTerminals } from "./liveSessionsModel";

/**
 * The list beside the open chat: every chat on the workdesk, grouped by
 * folder. Live ones first (running, needing you, idle), then finished
 * sessions from the history index. Pure, so it's tested without a DOM.
 */

export interface ChatListSource {
  id: string;
  name: string;
  path: string;
  /** Every worktree's path: history records the directory a session ran in. */
  worktreePaths: readonly string[];
}

export interface ChatListFolder {
  key: string;
  name: string;
  /** For the folder's tooltip. */
  path: string;
  live: CanvasTerminalItem[];
  past: ChatHistoryEntry[];
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function buildChatList(
  folders: readonly ChatListSource[],
  live: readonly CanvasTerminalItem[],
  past: readonly ChatHistoryEntry[],
  options: {
    /** Terminals not listed: the manager (pinned above), plain shells. */
    hidden?: ReadonlySet<string>;
    query?: string;
  } = {},
): ChatListFolder[] {
  const query = options.query?.trim() ?? "";
  const shown = filterLiveTerminals(
    live.filter((item) => !options.hidden?.has(item.terminalId)),
    query,
  );
  // A session that is still running is listed once, as the live row.
  const running = new Set(live.map((item) => item.sessionId).filter(Boolean));
  const finished = filterChatHistory(
    past.filter((entry) => !running.has(entry.sessionId)),
    query,
  ).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  const out: ChatListFolder[] = folders.map((folder) => ({
    key: folder.id,
    name: folder.name,
    path: folder.path,
    live: shown.filter((item) => item.projectId === folder.id),
    past: [],
  }));
  const byDir = new Map<string, ChatListFolder>();
  folders.forEach((folder, i) => {
    byDir.set(folder.path, out[i]);
    for (const dir of folder.worktreePaths) byDir.set(dir, out[i]);
  });
  // Some agents record a bare folder name instead of its path.
  const byName = new Map<string, ChatListFolder>();
  folders.forEach((folder, i) => {
    if (!byName.has(folder.name)) byName.set(folder.name, out[i]);
  });
  for (const entry of finished) {
    let folder = byDir.get(entry.projectDir) ?? (/[\\/]/.test(entry.projectDir) ? undefined : byName.get(entry.projectDir));
    if (!folder) {
      // History from a directory that's no longer a folder here.
      folder = { key: entry.projectDir, name: baseName(entry.projectDir), path: entry.projectDir, live: [], past: [] };
      byDir.set(entry.projectDir, folder);
      out.push(folder);
    }
    folder.past.push(entry);
  }
  return out.filter((folder) => folder.live.length > 0 || folder.past.length > 0);
}

/** The dot on a live row: running, needs you, or nothing to say. */
export function liveDot(state: CanvasTerminalItem["state"]): "run" | "need" | null {
  if (state === "attention") return "need";
  if (state === "active") return "run";
  return null;
}
