import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import type { Pin } from "../../shared/pin";
import { findAgentAdapter } from "../../shared/agent-adapters";
import type { ProjectData } from "../types/index.ts";
import { deriveTerminalState, isCanvasTerminal, type CanvasTerminalState } from "../components/sessionPanelModel";

/**
 * The workdesk view's grid (T7): every node on the canvas on screen, as
 * cards in three groups: agents, browsers by profile, and terminals and
 * notes. Pure, so the grouping and ordering are tested without React.
 */

export type WorkdeskFilter = "all" | "agents" | "browsers" | "other";

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

export type WorkdeskCard = TerminalCard | BrowserCard | NoteCard;

export interface BrowserGroup {
  identityId: string;
  name: string;
  cards: BrowserCard[];
}

export interface WorkdeskSections {
  agents: TerminalCard[];
  browserGroups: BrowserGroup[];
  other: Array<TerminalCard | NoteCard>;
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

  const notes: NoteCard[] = input.pins
    .filter((p) => typeof p.x === "number" && typeof p.y === "number")
    .map((p) => ({ kind: "note", id: p.id, projectPath: p.repo, title: p.title, body: p.body }));

  const other = [...otherTerminals, ...notes];
  const browserCount = input.browsers.length;
  return {
    agents,
    browserGroups,
    other,
    counts: {
      all: agents.length + browserCount + other.length,
      agents: agents.length,
      browsers: browserCount,
      other: other.length,
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
