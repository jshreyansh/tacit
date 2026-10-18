import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import type { Pin, PinStatus } from "../../shared/pin";
import { pinKind } from "../../shared/pin";
import { findAgentAdapter } from "../../shared/agent-adapters";
import type { ProjectData } from "../types/index.ts";
import { deriveTerminalState, isCanvasTerminal, type CanvasTerminalState } from "../components/sessionPanelModel";

/**
 * The workdesk view's grid (T7): every node on the canvas on screen, as
 * cards in three groups: agents, browsers by profile, and terminals and
 * notes. Pure, so the grouping and ordering are tested without React.
 */

export type WorkdeskFilter = "all" | "agents" | "terminals" | "browsers" | "tasks" | "notes";

export interface TerminalCard {
  kind: "terminal";
  id: string;
  type: string;
  isAgent: boolean;
  title: string;
  /** What it's working on: its first prompt, else its folder or branch. */
  subtitle: string;
  state: CanvasTerminalState;
  attentionReason?: "error" | "awaiting_input";
  /** When the running turn started, for "running · 2m". */
  since?: string;
  isManager: boolean;
  chatMode: boolean;
  projectId: string;
  worktreeId: string;
}

export interface BrowserCard {
  kind: "browser";
  id: string;
  title: string;
  url: string;
  host: string;
  identityId: string;
}

export interface NoteCard {
  kind: "note";
  id: string;
  projectPath: string;
  title: string;
  body: string;
}

export interface TaskCard {
  kind: "task";
  id: string;
  projectPath: string;
  title: string;
  status: PinStatus;
  /** "2/4", or empty with no steps. */
  progress: string;
  percent: number;
  /** The step being done, the agent's question, or nothing. */
  current: string | null;
  owners: string[];
}

export type WorkdeskCard = TerminalCard | BrowserCard | TaskCard | NoteCard;

export interface BrowserGroup {
  identityId: string;
  name: string;
  cards: BrowserCard[];
}

export interface WorkdeskSections {
  agents: TerminalCard[];
  browserGroups: BrowserGroup[];
  /** Whoever needs the person first, then work under way. */
  tasks: TaskCard[];
  /** Plain terminals: shells and anything that isn't an agent. */
  terminals: TerminalCard[];
  notes: NoteCard[];
  counts: Record<WorkdeskFilter, number>;
  runningAgents: number;
}

export interface WorkdeskInputs {
  projects: readonly ProjectData[];
  telemetry: ReadonlyMap<string, TerminalTelemetrySnapshot | null | undefined>;
  browsers: ReadonlyArray<{ id: string; url: string; title: string; identityId: string }>;
  identityNames: Readonly<Record<string, string>>;
  pins: readonly Pin[];
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
  for (const project of input.projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (!isCanvasTerminal(terminal)) continue;
        const telemetry = input.telemetry.get(terminal.id) ?? null;
        const derived = deriveTerminalState(terminal, telemetry, undefined);
        const isAgent = findAgentAdapter(terminal.type) !== null;
        const prompt = telemetry?.first_user_prompt;
        const card: TerminalCard = {
          kind: "terminal",
          id: terminal.id,
          type: terminal.type,
          isAgent,
          title: terminal.customTitle?.trim() || terminal.title,
          subtitle: prompt ? oneLine(prompt, 80) : worktree.name || project.name,
          state: derived.state,
          ...(derived.attentionReason ? { attentionReason: derived.attentionReason } : {}),
          ...(derived.state === "active" && derived.turnStartedAt ? { since: derived.turnStartedAt } : {}),
          isManager: terminal.id === input.managerTerminalId,
          chatMode: !!terminal.chatMode,
          projectId: project.id,
          worktreeId: worktree.id,
        };
        (isAgent ? agents : otherTerminals).push(card);
      }
    }
  }
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
    group.cards.push({ kind: "browser", id: b.id, title: b.title || hostOf(b.url), url: b.url, host: hostOf(b.url), identityId: b.identityId });
    groups.set(b.identityId, group);
  }
  const browserGroups = [...groups.values()];

  // Every task and note on this workdesk's projects, on the canvas or not.
  const notes: NoteCard[] = input.pins
    .filter((p) => pinKind(p) === "note")
    .map((p) => ({ kind: "note", id: p.id, projectPath: p.repo, title: p.title, body: p.body }));
  const TASK_ORDER: Record<PinStatus, number> = { needs_you: 0, in_progress: 1, open: 2, done: 3, dropped: 4 };
  const tasks: TaskCard[] = input.pins
    .filter((p) => pinKind(p) === "task" && p.status !== "dropped")
    .sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || Date.parse(b.updated) - Date.parse(a.updated))
    .map((p) => {
      const steps = p.steps ?? [];
      const done = steps.filter((st) => st.status === "done").length;
      const step = steps.find((st) => st.status === "active") ?? steps.find((st) => st.status === "pending");
      return {
        kind: "task",
        id: p.id,
        projectPath: p.repo,
        title: p.title,
        status: p.status,
        progress: steps.length ? `${done}/${steps.length}` : "",
        percent: steps.length ? Math.round((done / steps.length) * 100) : 0,
        current: p.status === "needs_you" ? (p.ask?.reason ?? null) : (step?.text ?? null),
        owners: p.owners ?? [],
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
