import type { CanvasTerminalItem } from "../components/sessionPanelModel";
import { filterChatHistory, typedText, type ChatHistoryEntry } from "./chatHistoryModel";
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
    /** Keep the workdesk's folders with nothing in them (the navigator lists every folder). */
    keepEmpty?: boolean;
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
  const kept = new Set(options.keepEmpty && !query ? folders.map((f) => f.id) : []);
  return out.filter((folder) => kept.has(folder.key) || folder.live.length > 0 || folder.past.length > 0);
}

/** A folder's chats, the ones that need you first, then those running, then the rest. */
export function orderLive<T extends { state: CanvasTerminalItem["state"] }>(items: readonly T[]): T[] {
  const rank = (s: CanvasTerminalItem["state"]) => (s === "attention" ? 0 : s === "active" ? 1 : 2);
  return [...items].sort((a, b) => rank(a.state) - rank(b.state));
}

/** The dot on a folder's row: amber if anything in it needs you, else green while something runs. */
export function folderDot(live: readonly { state: CanvasTerminalItem["state"] }[]): "need" | "run" | null {
  if (live.some((i) => i.state === "attention")) return "need";
  if (live.some((i) => i.state === "active")) return "run";
  return null;
}

/** The dot on a live row: running, needs you, or nothing to say. */
export function liveDot(state: CanvasTerminalItem["state"]): "run" | "need" | null {
  if (state === "attention") return "need";
  if (state === "active") return "run";
  return null;
}

/** One search result: a chat on this workdesk, live or finished, with where it lives. */
export type ChatSearchHit =
  | { kind: "live"; item: CanvasTerminalItem; title: string; folder: string }
  | { kind: "past"; entry: ChatHistoryEntry; title: string; folder: string };

function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Searching the list: one flat list of chats, live ones first (needing
 * you, then running), then finished ones newest first. A chat matches on
 * what the row shows (its title) and the first message someone typed;
 * never its folder or agent name, nor a manager's briefing.
 */
export function searchChats(
  folders: readonly ChatListSource[],
  live: readonly CanvasTerminalItem[],
  past: readonly ChatHistoryEntry[],
  options: { query: string; hidden?: ReadonlySet<string>; pastTitle: (entry: ChatHistoryEntry) => string },
): ChatSearchHit[] {
  const words = queryWords(options.query);
  if (words.length === 0) return [];
  const matches = (...texts: string[]) => {
    const hay = texts.join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const byDir = new Map<string, string>();
  for (const f of folders) {
    byDir.set(f.path, f.name);
    for (const dir of f.worktreePaths) byDir.set(dir, f.name);
  }
  const running = new Set(live.map((item) => item.sessionId).filter(Boolean));

  const liveHits: ChatSearchHit[] = orderLive(live.filter((item) => !options.hidden?.has(item.terminalId) && matches(item.title))).map((item) => ({
    kind: "live",
    item,
    title: item.title,
    folder: item.projectName,
  }));
  const pastHits: ChatSearchHit[] = past
    .filter((entry) => !running.has(entry.sessionId))
    .map((entry) => ({ entry, title: options.pastTitle(entry) }))
    .filter(({ entry, title }) => matches(title, typedText(entry.firstPrompt)))
    .sort((a, b) => Date.parse(b.entry.lastActivityAt) - Date.parse(a.entry.lastActivityAt))
    .map(({ entry, title }) => ({ kind: "past", entry, title, folder: byDir.get(entry.projectDir) ?? baseName(entry.projectDir) }));
  return [...liveHits, ...pastHits];
}

/** Where the query's words fall in a title, merged and in order, to highlight them. */
export function matchRanges(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of queryWords(query)) {
    for (let i = lower.indexOf(word); i !== -1; i = lower.indexOf(word, i + word.length)) ranges.push([i, i + word.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
