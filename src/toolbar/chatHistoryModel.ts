import { isWorkspaceManagerBriefing } from "../../shared/manager-role";

/**
 * What the docked chat's history list shows for each past session (SHR-127).
 * Pure, so the title rules and search can be tested without a DOM.
 */

export interface ChatHistoryEntry {
  sessionId: string;
  provider: string;
  projectDir: string;
  filePath: string;
  firstPrompt: string;
  startedAt: string;
  lastActivityAt: string;
  estimatedMessageCount: number;
}

const PASTED_BLOCK = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;
const QUOTE_MARKERS = /^\s*(?:[>▎▍▌▏│┃]\s*)+/;

export type ChatTitle =
  | { kind: "manager" }
  | { kind: "pasted" }
  | { kind: "untitled" }
  | { kind: "text"; text: string };

/**
 * A row's title: the first line someone typed, without pasted blocks or
 * quote bars. A session opened by the manager briefing is named as the
 * manager's, rather than showing the briefing's first words every time.
 */
export function chatTitle(firstPrompt: string | null | undefined): ChatTitle {
  const raw = (firstPrompt ?? "").trim();
  if (!raw) return { kind: "untitled" };
  if (isWorkspaceManagerBriefing(raw)) return { kind: "manager" };
  const plain = raw
    .replace(PASTED_BLOCK, " ")
    .split("\n")
    .map((line) => line.replace(QUOTE_MARKERS, "").trim())
    .filter(Boolean);
  if (plain.length === 0) return PASTED_BLOCK.test(raw) ? { kind: "pasted" } : { kind: "untitled" };
  if (isWorkspaceManagerBriefing(plain[0])) return { kind: "manager" };
  const line = plain[0].replace(/\s+/g, " ");
  return { kind: "text", text: briefingTitle(line) ?? line };
}

/**
 * Sessions the manager started open with a briefing, not something a person
 * typed: name them by their job instead of by the briefing's first words.
 * "You're the browser-QA worker for the Lantern launch page in /Users/…"
 * becomes "Browser-QA worker · Lantern launch page".
 */
export function briefingTitle(line: string): string | null {
  const worker = line.match(/^You're (?:a|an|the) ((?:[\w-]+ )?worker) (?:on|for) (?:the )?(.+?)(?: in \/| \(|\. |$)/i);
  if (worker) {
    const role = worker[1][0].toUpperCase() + worker[1].slice(1);
    return `${role} · ${worker[2].trim()}`;
  }
  const wired = line.match(/^A browser on the canvas is wired to you: "([^"]+)"/i);
  if (wired) return `Wired to a browser · ${wired[1].trim()}`;
  return null;
}

export function projectName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** Entries whose title or project contains every word of the query, any case. */
export function filterChatHistory<T extends ChatHistoryEntry>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const title = chatTitle(entry.firstPrompt);
    const haystack = [
      title.kind === "text" ? title.text : title.kind === "manager" ? "manager workdesk workspace" : "",
      entry.firstPrompt,
      projectName(entry.projectDir),
      entry.provider,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago". */
export function relativeAge(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Clock time for today, the weekday this week ("Mon"), else the date. */
export function stamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** How long a session ran, from its first entry to its last. */
export function duration(startedAt: string, lastActivityAt: string): string | null {
  const ms = new Date(lastActivityAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * What a person typed to open the session, for search: the first message
 * without pasted blocks. Empty when the manager wrote it (its briefing), so
 * a search never matches words nobody sees.
 */
export function typedText(firstPrompt: string | null | undefined): string {
  const title = chatTitle(firstPrompt);
  if (title.kind !== "text") return "";
  const raw = (firstPrompt ?? "").trim();
  const firstLine = raw.replace(PASTED_BLOCK, " ").split("\n").map((l) => l.replace(QUOTE_MARKERS, "").trim()).find(Boolean) ?? "";
  if (briefingTitle(firstLine.replace(/\s+/g, " "))) return "";
  return raw.replace(PASTED_BLOCK, " ").replace(/\s+/g, " ").trim();
}
