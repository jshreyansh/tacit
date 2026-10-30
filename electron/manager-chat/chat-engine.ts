import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ChatAnswers, ChatAttachment, ChatEvent, ChatSettings } from "../../shared/chat-events";
import { startClaudeDriver, startCodexDriver, startOpenCodeDriver, type ChatDriver, type SpawnFn } from "./drivers";

/**
 * Chats with managers that run in chat mode (T6.2): one agent process per
 * manager terminal, under that terminal's id so Tacit's tools, hooks and
 * record treat it as the manager it is. The terminal's tile shows the
 * manager is in the chat; only one of the two runs the session at a time
 * (the renderer swaps them).
 *
 * The conversation opens on the session's history, read from the agent's
 * own record of it, so what was said in the terminal or before a restart is
 * there; every live event is then kept, deltas merged, so a window that
 * reloads replays the conversation so far.
 */

export type ChatAgent = "claude" | "codex" | "opencode";

/** Agents whose driver replays a session's history itself as it opens it, so none is read from a file. */
const REPLAYS_HISTORY: ReadonlySet<ChatAgent> = new Set(["opencode"]);

export interface ChatStartRequest {
  terminalId: string;
  agent: ChatAgent;
  cwd: string;
  /** The agent session to resume: the terminal's, so the chat continues it. */
  sessionId: string | null;
}

export interface ChatLaunch {
  command: string;
  bridgeArgs: string[];
  env: Record<string, string>;
}

export interface ChatEngineDeps {
  spawn: SpawnFn;
  /** The command, Tacit's bridge wiring and environment for this manager. */
  prepare: (request: ChatStartRequest) => Promise<ChatLaunch>;
  onEvent: (terminalId: string, event: ChatEvent) => void;
  /** A turn ended: telemetry needs to hear it, since stream-json fires no Stop hook. */
  onTurnEnded?: (terminalId: string, sessionId: string | null) => void;
  /**
   * The session's history from the agent's own record, as chat events: null
   * when there's no record to read. It replaces what the chat held, since
   * the record has everything, including what was said outside the chat.
   */
  loadHistory?: (agent: ChatAgent, sessionId: string) => Promise<ChatEvent[] | null>;
  /**
   * The agent's last usage-limit reading, kept across chats and restarts:
   * the limit is the account's, and Claude only reports it during a turn.
   */
  limits?: {
    get: (agent: ChatAgent) => ChatLimitEvent | null;
    set: (agent: ChatAgent, limit: ChatLimitEvent) => void;
  };
  /**
   * The mode last picked for the agent's chats, kept across chats and
   * restarts, so a new chat starts in it. Not every mode is kept (keptMode).
   */
  modes?: {
    get: (agent: ChatAgent) => string | null;
    set: (agent: ChatAgent, mode: string) => void;
  };
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Modes a new chat may start in because an earlier one picked them. Plan
 * is for one piece of work. Codex's Full access runs anything with no
 * sandbox, and the kept mode holds in every folder, so it's picked each
 * time rather than carried from one chat to the next.
 */
const NOT_KEPT_MODES = new Set(["plan", "full-access"]);

export function keptMode(mode: string | null | undefined): string | null {
  return mode && !NOT_KEPT_MODES.has(mode) ? mode : null;
}

/** A model, effort or mode name: OpenCode's models name their provider (`opencode/big-pickle`). */
const SETTING_NAME = /^[A-Za-z0-9._:[\]/@ -]{1,120}$/;

/** A settings change from the renderer, checked: null when it isn't one, so nothing of it applies. */
export function chatSettingsChange(settings: unknown): Partial<ChatSettings> | null {
  if (typeof settings !== "object" || settings === null) return null;
  const out: Partial<ChatSettings> = {};
  for (const key of ["model", "effort", "mode"] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "string" || !SETTING_NAME.test(value))) return null;
    out[key] = value;
  }
  return out;
}

export type ChatLimitEvent = Extract<ChatEvent, { kind: "rate_limit" }>;

/** A kept reading still holds until its window resets. */
export function limitStillHolds(limit: ChatLimitEvent, now: Date): boolean {
  if (!limit.resetsAt) return false;
  const at = Date.parse(limit.resetsAt);
  return Number.isFinite(at) && at > now.getTime();
}

interface ChatSession {
  agent: ChatAgent;
  driver: ChatDriver | null;
  events: ChatEvent[];
  sessionId: string | null;
  cwd: string;
  /** What the person picked (model, effort, mode), set again when the agent restarts. */
  chosen?: Partial<ChatSettings>;
}

/** What a replayed history doesn't replace: the agent's own state, not the conversation. */
const KEPT_ACROSS_HISTORY: ReadonlySet<ChatEvent["kind"]> = new Set(["session", "capabilities", "settings", "rate_limit", "context"]);

/** Events kept per chat; the oldest go first. Deltas are merged, so this is a long conversation. */
const MAX_EVENTS = 20_000;

/** Adds an event, merging it into the last one when both are deltas of the same block. */
export function appendEvent(events: ChatEvent[], event: ChatEvent): void {
  const last = events[events.length - 1];
  if (last && last.kind === event.kind && "key" in last && "key" in event && last.key === event.key) {
    if (event.kind === "text_delta" && last.kind === "text_delta") {
      events[events.length - 1] = { ...last, text: last.text + event.text };
      return;
    }
    if (event.kind === "thinking_delta" && last.kind === "thinking_delta") {
      events[events.length - 1] = { ...last, text: last.text + event.text };
      return;
    }
    if (event.kind === "tool_input_delta" && last.kind === "tool_input_delta") {
      events[events.length - 1] = { ...last, json: last.json + event.json };
      return;
    }
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export class ChatEngine {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly starting = new Map<string, Promise<void>>();

  constructor(private readonly deps: ChatEngineDeps) {}

  isRunning(terminalId: string): boolean {
    return this.sessions.get(terminalId)?.driver != null;
  }

  /** The chat's events so far, for a window catching up. */
  snapshot(terminalId: string): ChatEvent[] {
    return [...(this.sessions.get(terminalId)?.events ?? [])];
  }

  /** Starts the manager's agent in chat mode; a second call while it runs does nothing. */
  start(request: ChatStartRequest): Promise<void> {
    if (this.isRunning(request.terminalId)) return Promise.resolve();
    const inFlight = this.starting.get(request.terminalId);
    if (inFlight) return inFlight;
    const run = this.launch(request).finally(() => this.starting.delete(request.terminalId));
    this.starting.set(request.terminalId, run);
    return run;
  }

  private async launch(request: ChatStartRequest): Promise<void> {
    const existing = this.sessions.get(request.terminalId);
    const session: ChatSession = existing ?? { agent: request.agent, driver: null, events: [], sessionId: request.sessionId, cwd: request.cwd };
    session.agent = request.agent;
    session.cwd = request.cwd;
    session.sessionId = request.sessionId ?? session.sessionId;
    this.sessions.set(request.terminalId, session);
    if (session.sessionId && this.deps.loadHistory && !REPLAYS_HISTORY.has(request.agent)) {
      try {
        const history = await this.deps.loadHistory(request.agent, session.sessionId);
        if (history) session.events = [...history];
      } catch (error) {
        this.deps.log?.(`[chat] history for ${request.terminalId} unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const kept = this.deps.limits?.get(request.agent);
    if (kept && limitStillHolds(kept, this.deps.now?.() ?? new Date())) this.record(request.terminalId, kept);
    let launch: ChatLaunch;
    try {
      launch = await this.deps.prepare(request);
    } catch (error) {
      this.record(request.terminalId, { kind: "exited", code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const start = request.agent === "codex" ? startCodexDriver : request.agent === "opencode" ? startOpenCodeDriver : startClaudeDriver;
    const driver = start({
      command: launch.command,
      bridgeArgs: launch.bridgeArgs,
      cwd: request.cwd,
      env: launch.env,
      sessionId: session.sessionId,
      spawn: this.deps.spawn,
      emit: (event) => this.record(request.terminalId, event),
      log: this.deps.log,
    });
    session.driver = driver;
    const startMode = keptMode(this.deps.modes?.get(request.agent));
    const chosen = { ...(startMode ? { mode: startMode } : {}), ...session.chosen };
    if (Object.keys(chosen).length > 0) driver.configure(chosen);
  }

  private record(terminalId: string, event: ChatEvent): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    if (event.kind === "session") session.sessionId = event.sessionId;
    if (event.kind === "exited") session.driver = null;
    if (event.kind === "rate_limit") this.deps.limits?.set(session.agent, event);
    if (event.kind === "history") {
      // Replaces the conversation held; what the agent said about itself stays.
      session.events = [...event.events, ...session.events.filter((e) => KEPT_ACROSS_HISTORY.has(e.kind))];
      this.deps.onEvent(terminalId, event);
      return;
    }
    appendEvent(session.events, event);
    this.deps.onEvent(terminalId, event);
    if (event.kind === "turn_ended") this.deps.onTurnEnded?.(terminalId, session.sessionId);
  }

  /** Sends the person's message and its files. False when no agent is running for this manager. */
  send(terminalId: string, text: string, attachments: readonly ChatAttachment[] = []): boolean {
    const session = this.sessions.get(terminalId);
    if (!session?.driver) return false;
    this.record(terminalId, {
      kind: "user_message",
      id: randomUUID(),
      text,
      at: (this.deps.now?.() ?? new Date()).toISOString(),
      ...(attachments.length ? { attachments: [...attachments] } : {}),
    });
    session.driver.send(text, attachments);
    return true;
  }

  /** The folder the chat's agent works in. */
  cwdOf(terminalId: string): string | null {
    return this.sessions.get(terminalId)?.cwd ?? null;
  }

  interrupt(terminalId: string): void {
    this.sessions.get(terminalId)?.driver?.interrupt();
  }

  answer(terminalId: string, requestId: string, decision: ApprovalDecision, note?: string): void {
    this.sessions.get(terminalId)?.driver?.answer(requestId, decision, note);
  }

  answerQuestion(terminalId: string, requestId: string, answers: ChatAnswers | null): void {
    this.sessions.get(terminalId)?.driver?.answerQuestion(requestId, answers);
  }

  /** The model, effort or mode the person picked; kept, and set again if the agent restarts. */
  configure(terminalId: string, settings: Partial<ChatSettings>): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.chosen = { ...session.chosen, ...settings };
    const kept = keptMode(settings.mode);
    if (kept) this.deps.modes?.set(session.agent, kept);
    session.driver?.configure(settings);
  }

  /** Stops the agent; the conversation so far is kept for the chat to show. */
  stop(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    session?.driver?.stop();
    if (session) session.driver = null;
  }

  /** Forgets a manager entirely (its terminal was closed). */
  forget(terminalId: string): void {
    this.stop(terminalId);
    this.sessions.delete(terminalId);
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  agentOf(terminalId: string): ChatAgent | null {
    return this.sessions.get(terminalId)?.agent ?? null;
  }

  sessionIdOf(terminalId: string): string | null {
    return this.sessions.get(terminalId)?.sessionId ?? null;
  }
}
