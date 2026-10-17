import { addTerminal, addBrowser, addNote, addTask } from "../actions/dockActions";
import { useAgentDetection } from "../stores/agentAvailabilityStore";
import { useNotificationStore } from "../stores/notificationStore";
import type { DockId } from "../stores/dockStore";
import type { TerminalType } from "../types";
import { AGENT_ICON } from "./agentIcons";
import browserIcon from "../assets/dock-icons/browser.png";
import noteIcon from "../assets/dock-icons/note.png";
import taskIcon from "../assets/dock-icons/task.svg";
import type { useT } from "../i18n/useT";

type Dict = ReturnType<typeof useT>;

/**
 * Everything the dock and the All Nodes tray can add to the canvas.
 *
 * Moved here from the right rail when the rail went away (the dock now
 * lives in the left bar and the tray). One list, so the bar and the tray
 * can't disagree about what exists.
 */

/**
 * A dock mark, and whether it brings its own tile.
 *
 * These assets are not alike. Shell is drawn as a dark squircle and Note as a
 * card, so the artwork *is* the icon tile. Claude, Codex, Antigravity and
 * Chrome are bare vendor logos on transparency, so they get a shell behind
 * them and the tiled ones do not, which is what a macOS dock does: every icon
 * occupies the same squircle, some supplied by the app and some by us.
 *
 * `inner` exists because the marks are cropped at different tightnesses, so
 * one box size renders them at visibly different weights.
 */
export interface DockArt {
  icon: string;
  /** Artwork already carries its own tile; render it without a shell. */
  tiled?: boolean;
  /** Size of the mark inside the shell (or the footprint, when tiled), at rail size. */
  inner?: number;
}

export interface DockEntry {
  id: DockId;
  group: "agents" | "tools";
  art: DockArt;
  /** The name shown under the icon in the tray. */
  label: (t: Dict) => string;
  /** Set for agents: its CLI may be missing on this Mac. */
  terminalType?: TerminalType;
  create: () => void;
}

const agent = (id: DockId & TerminalType, name: string, art: DockArt): DockEntry => ({
  id,
  group: "agents",
  art,
  label: () => name,
  terminalType: id,
  create: () => addTerminal(id),
});

export const DOCK_ENTRIES: readonly DockEntry[] = [
  agent("claude", "Claude Code", { icon: AGENT_ICON.claude, inner: 24 }),
  agent("codex", "Codex", { icon: AGENT_ICON.codex, inner: 24 }),
  // Google's successor to the Gemini CLI, which stopped serving consumer
  // accounts on 18 June 2026.
  agent("antigravity", "Antigravity", { icon: AGENT_ICON.antigravity, inner: 22 }),
  // opencode-mark.png is the mark lifted off OpenCode's cream field with its
  // tones flipped, so it sits on the same shell as the rest.
  agent("opencode", "OpenCode", { icon: AGENT_ICON.opencode, inner: 24 }),
  {
    id: "shell",
    group: "tools",
    art: { icon: AGENT_ICON.shell, tiled: true },
    label: (t) => t.dock_terminal,
    terminalType: "shell",
    create: () => addTerminal("shell"),
  },
  { id: "browser", group: "tools", art: { icon: browserIcon, inner: 23 }, label: (t) => t.dock_browser, create: addBrowser },
  { id: "task", group: "tools", art: { icon: taskIcon, tiled: true }, label: (t) => t.dock_task, create: addTask },
  { id: "note", group: "tools", art: { icon: noteIcon, tiled: true }, label: (t) => t.dock_note, create: addNote },
];

export function dockEntry(id: DockId): DockEntry {
  const entry = DOCK_ENTRIES.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown dock entry ${id}`);
  return entry;
}

/** Entries whose name contains the query, any case; all of them for an empty one. */
export function filterDockEntries(entries: readonly DockEntry[], query: string, t: Dict): DockEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.label(t).toLowerCase().includes(q) || e.id.includes(q));
}

/** The icon, at rail size (scale 1) or larger in the tray. */
export function DockIcon({ art, scale = 1 }: { art: DockArt; scale?: number }) {
  if (art.tiled) {
    const size = (art.inner ?? 33) * scale;
    return <img src={art.icon} alt="" style={{ width: size, height: size }} className="object-contain" draggable={false} />;
  }
  const shell = 30 * scale;
  const inner = (art.inner ?? 24) * scale;
  return (
    <span className="tc-icon-shell" style={{ width: shell, height: shell }}>
      <img src={art.icon} alt="" style={{ width: inner, height: inner }} className="object-contain" draggable={false} />
    </span>
  );
}

/**
 * Whether an entry can be added: an agent whose CLI isn't installed stays
 * visible but says why instead of opening a terminal that fails with
 * "executable not found".
 */
export function useDockAvailability(entry: DockEntry): { missing: boolean; title: string | null } {
  // Tools (shell, browser, note) need no CLI; an empty id is never detected.
  const detection = useAgentDetection(entry.group === "agents" ? entry.terminalType ?? "" : "");
  if (!detection) return { missing: false, title: null };
  if (!detection.installed) return { missing: true, title: detection.reason ?? null };
  return { missing: false, title: detection.version ?? null };
}

export function createFromDock(entry: DockEntry, missingReason: string | null, missing: boolean): boolean {
  if (missing) {
    useNotificationStore.getState().notify("warn", missingReason ?? "This agent isn't installed");
    return false;
  }
  entry.create();
  return true;
}
