import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ChatEvent } from "../../shared/chat-events";
import { startClaudeDriver, startCodexDriver, type ChatDriver, type SpawnFn } from "./drivers";

/**
 * Chats with managers that run in chat mode (T6.2): one agent process per
 * manager terminal, under that terminal's id so Tacit's tools, hooks and
 * record treat it as the manager it is. The terminal's tile shows the
 * manager is in the chat; only one of the two runs the session at a time
 * (the renderer swaps them).
 *
 * Every event is kept, with streaming deltas merged, so a window that
 * reloads, or a chat opened later, replays the conversation so far.
 */

export type ChatAgent = "claude" | "codex";

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
  log?: (line: string) => void;
  now?: () => Date;
}

interface ChatSession {
  agent: ChatAgent;
  driver: ChatDriver | null;
  events: ChatEvent[];
  sessionId: string | null;
}

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
    const session: ChatSession = existing ?? { agent: request.agent, driver: null, events: [], sessionId: request.sessionId };
    session.agent = request.agent;
    session.sessionId = request.sessionId ?? session.sessionId;
    this.sessions.set(request.terminalId, session);
    let launch: ChatLaunch;
    try {
      launch = await this.deps.prepare(request);
    } catch (error) {
      this.record(request.terminalId, { kind: "exited", code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const start = request.agent === "codex" ? startCodexDriver : startClaudeDriver;
    session.driver = start({
      command: launch.command,
      bridgeArgs: launch.bridgeArgs,
      cwd: request.cwd,
      env: launch.env,
      sessionId: session.sessionId,
      spawn: this.deps.spawn,
      emit: (event) => this.record(request.terminalId, event),
      log: this.deps.log,
    });
  }

  private record(terminalId: string, event: ChatEvent): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    if (event.kind === "session") session.sessionId = event.sessionId;
    if (event.kind === "exited") session.driver = null;
    appendEvent(session.events, event);
    this.deps.onEvent(terminalId, event);
    if (event.kind === "turn_ended") this.deps.onTurnEnded?.(terminalId, session.sessionId);
  }

  /** Sends the person's message. False when no agent is running for this manager. */
  send(terminalId: string, text: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session?.driver) return false;
    this.record(terminalId, { kind: "user_message", id: randomUUID(), text, at: (this.deps.now?.() ?? new Date()).toISOString() });
    session.driver.send(text);
    return true;
  }

  interrupt(terminalId: string): void {
    this.sessions.get(terminalId)?.driver?.interrupt();
  }

  answer(terminalId: string, requestId: string, decision: ApprovalDecision): void {
    this.sessions.get(terminalId)?.driver?.answer(requestId, decision);
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

  sessionIdOf(terminalId: string): string | null {
    return this.sessions.get(terminalId)?.sessionId ?? null;
  }
}
