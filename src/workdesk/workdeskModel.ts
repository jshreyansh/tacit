import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import { columnOf, sortTasks, type Column, type Task } from "../../shared/task";
import { findAgentAdapter } from "../../shared/agent-adapters";
import type { ProjectData, TerminalData } from "../types/index.ts";
import { agentNames, agentsIn } from "../tasks/agentNames";
import { deriveTerminalState, isCanvasTerminal, isPlainTitle, isTaskBrief, type CanvasTerminalState } from "../components/sessionPanelModel";

/**
 * The workdesk view's grid (T7): every node on the canvas on screen, as
 * cards in three groups: agents, browsers by profile, and terminals and
 * notes. Pure, so the grouping and ordering are tested without React.
 */

/** What the overview counts: every node, or one kind. */
export type WorkdeskCountKey = "all" | "agents" | "terminals" | "browsers" | "tasks" | "notes";

export interface TerminalCard {
  kind: "terminal";
  id: string;
  type: string;
  isAgent: boolean;
  title: string;
  /** What it's working on: its first prompt, else its folder or branch. */
  subtitle: string;
  /** What its tab says, to tell five Claudes apart: the name it was given,
   *  else its first prompt, else what it is. A manager's first prompt is
   *  Tacit's briefing, so it goes by what it is. */
  label: string;
  state: CanvasTerminalState;
  attentionReason?: "error" | "awaiting_input";
  /** When the running turn started, for "running · 2m". */
  since?: string;
  isManager: boolean;
  chatMode: boolean;
  projectId: string;
  worktreeId: string;
  /** What its launch is built from, to show when it runs without approvals. */
  launch: Pick<TerminalData, "type" | "sessionId" | "autoApprove">;
}

export interface BrowserCard {
  kind: "browser";
  id: string;
  title: string;
  url: string;
  host: string;
  identityId: string;
  /** The page's icon, as its tab shows it. */
  favicon?: string;
}

export interface NoteCard {
  kind: "note";
  id: string;
  title: string;
  body: string;
}

export interface TaskCard {
  kind: "task";
  id: string;
  n: number;
  title: string;
  column: Column;
  /** "2/4" of its parts, or empty. */
  progress: string;
  percent: number;
  /** What it needs from you, or who's on it. */
  note: string | null;
}

export type WorkdeskCard = TerminalCard | BrowserCard | NoteCard;

/** A past session read in a tab of the workdesk view, by its file path. */
export interface SessionTabCard {
  kind: "session";
  id: string;
  title: string;
  agent: string | null;
}

/** A file open in a tab of the workdesk view, by its path. */
export interface FileTabCard {
  kind: "file";
  id: string;
  title: string;
}

/** All the tasks, in a tab of the workdesk view. */
export interface TasksTabCard {
  kind: "tasks";
  id: "all";
  title: string;
}

/** A folder's changes, history or memory, in a tab of the workdesk view, by tool id. */
export interface ToolTabCard {
  kind: "tool";
  id: string;
  title: string;
}

/** What a tab in the workdesk view can hold: any node, a past session, a file, all the tasks, or a folder's view. */
export type TabCard = WorkdeskCard | SessionTabCard | FileTabCard | TasksTabCard | ToolTabCard;

export interface BrowserGroup {
  identityId: string;
  name: string;
  cards: BrowserCard[];
}

export interface WorkdeskSections {
  agents: TerminalCard[];
  browserGroups: BrowserGroup[];
  /** Tasks needing the person, then work under way; the rest are on the board. */
  tasks: TaskCard[];
  /** Plain terminals: shells and anything that isn't an agent. */
  terminals: TerminalCard[];
  notes: NoteCard[];
  counts: Record<WorkdeskCountKey, number>;
  runningAgents: number;
  /**
   * Every card in the order of the open view's tabs: agents and terminals
   * as they were added to the canvas, then browsers. Unlike the grid's, it
   * never follows state, so a tab stays where it is when its agent starts
   * work or switches to chat. A note has a tab while it's open.
   */
  tabs: WorkdeskCard[];
}

export interface WorkdeskInputs {
  /** Agents waiting on you to allow something. */
  waiting?: ReadonlySet<string>;
  projects: readonly ProjectData[];
  telemetry: ReadonlyMap<string, TerminalTelemetrySnapshot | null | undefined>;
  browsers: ReadonlyArray<{ id: string; url: string; title: string; identityId: string; favicon?: string }>;
  identityNames: Readonly<Record<string, string>>;
  tasks: readonly Task[];
  notes: ReadonlyArray<{ id: string; title: string; text: string }>;
  managerTerminalId: string | null;
}

const STATE_ORDER: Record<CanvasTerminalState, number> = { attention: 0, active: 1, done: 2, idle: 3 };

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function buildWorkdeskSections(input: WorkdeskInputs): WorkdeskSections {
  const agents: TerminalCard[] = [];
  const otherTerminals: TerminalCard[] = [];
  const names = agentNames(agentsIn(input.projects));
  for (const project of input.projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (!isCanvasTerminal(terminal)) continue;
        const telemetry = input.telemetry.get(terminal.id) ?? null;
        const derived = deriveTerminalState(terminal, telemetry, undefined);
        // It asked you to allow something, whatever its turn is doing.
        const asked = derived.state !== "attention" && !!input.waiting?.has(terminal.id);
        const isAgent = findAgentAdapter(terminal.type) !== null;
        const first = telemetry?.first_user_prompt;
        const prompt = first && !isTaskBrief(first) ? first : undefined;
        const card: TerminalCard = {
          kind: "terminal",
          id: terminal.id,
          type: terminal.type,
          isAgent,
          title: terminal.customTitle?.trim() || terminal.title,
          subtitle: prompt ? oneLine(prompt, 80) : worktree.name || project.name,
          label:
            terminal.customTitle?.trim() ||
            (prompt && terminal.id !== input.managerTerminalId ? oneLine(prompt, 80) : isAgent && isPlainTitle(terminal.title, terminal.type) ? (names.get(terminal.id) ?? terminal.title) : terminal.title),
          state: asked ? "attention" : derived.state,
          ...(asked ? { attentionReason: "awaiting_input" as const } : derived.attentionReason ? { attentionReason: derived.attentionReason } : {}),
          ...(derived.state === "active" && derived.turnStartedAt ? { since: derived.turnStartedAt } : {}),
          isManager: terminal.id === input.managerTerminalId,
          chatMode: !!terminal.chatMode,
          projectId: project.id,
          worktreeId: worktree.id,
          launch: { type: terminal.type, sessionId: terminal.sessionId, autoApprove: terminal.autoApprove },
        };
        (isAgent ? agents : otherTerminals).push(card);
      }
    }
  }
  // The tabs keep the canvas's order; the grid sorts copies.
  const agentsAsAdded = [...agents];
  const terminalsAsAdded = [...otherTerminals];
  // Whoever needs you first, then whoever's working; the manager leads its group.
  const byState = (a: TerminalCard, b: TerminalCard) =>
    Number(b.isManager) - Number(a.isManager) || STATE_ORDER[a.state] - STATE_ORDER[b.state];
  agents.sort(byState);
  otherTerminals.sort(byState);

  const groups = new Map<string, BrowserGroup>();
  for (const b of input.browsers) {
    const group = groups.get(b.identityId) ?? {
      identityId: b.identityId,
      name: input.identityNames[b.identityId] ?? b.identityId,
      cards: [],
    };
    group.cards.push({
      kind: "browser",
      id: b.id,
      title: b.title || hostOf(b.url),
      url: b.url,
      host: hostOf(b.url),
      identityId: b.identityId,
      ...(b.favicon ? { favicon: b.favicon } : {}),
    });
    groups.set(b.identityId, group);
  }
  const browserGroups = [...groups.values()];

  const notes: NoteCard[] = input.notes.map((n) => ({ kind: "note", id: n.id, title: n.title, body: n.text }));
  const ORDER: Column[] = ["needs", "working"];
  const tasks: TaskCard[] = ORDER.flatMap((column) => sortTasks(input.tasks.filter((t) => columnOf(t) === column))).map((t) => {
    const done = t.parts.filter((x) => x.state === "done").length;
    return {
      kind: "task",
      id: t.id,
      n: t.n,
      title: t.title,
      column: columnOf(t),
      progress: t.parts.length ? `${done}/${t.parts.length}` : "",
      percent: t.parts.length ? Math.round((done / t.parts.length) * 100) : 0,
      note: t.requests[0]?.text ?? null,
    };
  });

  const browserCount = input.browsers.length;
  return {
    agents,
    browserGroups,
    tasks,
    terminals: otherTerminals,
    notes,
    counts: {
      all: agents.length + otherTerminals.length + browserCount + tasks.length + notes.length,
      agents: agents.length,
      terminals: otherTerminals.length,
      browsers: browserCount,
      tasks: tasks.length,
      notes: notes.length,
    },
    runningAgents: agents.filter((a) => a.state === "active").length,
    tabs: [...agentsAsAdded, ...terminalsAsAdded, ...browserGroups.flatMap((g) => g.cards)],
  };
}

/** Whole minutes since a time, for "running · 2m"; null under a minute. */
export function minutesSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  return minutes >= 1 ? minutes : null;
}
