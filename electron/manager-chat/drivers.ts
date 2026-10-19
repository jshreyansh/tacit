import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { ApprovalDecision, ChatAnswers, ChatAttachment, ChatEvent, ChatSettings } from "../../shared/chat-events";
import { withMentions } from "../../shared/chat-attachments";
import {
  acpCapabilities,
  acpConfigChanges,
  acpPermissionOutcome,
  acpPrompt,
  acpStopOutcome,
  acpTurnEnded,
  ACP_PLAN_PREFIX,
  createAcpStreamState,
  parseAcpPermission,
  parseAcpUpdate,
} from "../../shared/chat-stream-acp";
import { elicitationResult, type Elicitation } from "../../shared/chat-elicitation";
import {
  claudeAnswerInput,
  claudeApprovalLine,
  claudeElicitation,
  claudeElicitationLine,
  claudeCapabilities,
  claudeControlLine,
  claudeInterruptLine,
  claudeKeepPlanningMessage,
  claudeUserLine,
  createClaudeStreamState,
  parseClaudeLine,
} from "../../shared/chat-stream-claude";
import {
  CODEX_MODES,
  CODEX_ASYNC_QUESTION_PREFIX,
  CODEX_PLAN_PREFIX,
  codexApprovalResult,
  codexAsyncReply,
  codexCapabilities,
  codexElicitationResult,
  codexQuestionResult,
  codexRateLimit,
  codexUserInput,
  createCodexStreamState,
  parseCodexMessage,
} from "../../shared/chat-stream-codex";

/**
 * The agent process behind a chat, one per manager in chat mode (T6.2).
 * Each driver starts its agent in the agent's structured protocol and
 * reports what happens as chat events; the engine (chat-engine.ts) does
 * the rest. Spawning is passed in, so tests drive these with fakes.
 */

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface DriverOptions {
  command: string;
  /** Extra arguments: Tacit's bridge wiring from the agent's adapter. */
  bridgeArgs: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** The session to resume, or null for a new one. */
  sessionId: string | null;
  spawn: SpawnFn;
  emit: (event: ChatEvent) => void;
  /** For the debug log; never shown in the chat. */
  log?: (line: string) => void;
}

export interface ChatDriver {
  /** The person's message, with any files sent with it. */
  send(text: string, attachments?: readonly ChatAttachment[]): void;
  interrupt(): void;
  /** `note`: what the person said with a deny; for a plan, what they'd change while they keep planning. */
  answer(requestId: string, decision: ApprovalDecision, note?: string): void;
  /** Answers the agent's questions; null skips them. */
  answerQuestion(requestId: string, answers: ChatAnswers | null): void;
  /** Changes the model, effort or mode from the next thing the agent does. */
  configure(settings: Partial<ChatSettings>): void;
  stop(): void;
}

const INIT_REQUEST = "tacit-initialize";

/** Splits a stream into lines, keeping a partial last line for the next chunk. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}

/** The tail of what the process printed to stderr, for a failure message. */
function stderrTail(): { push: (chunk: Buffer | string) => void; text: () => string } {
  let tail = "";
  return {
    push: (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
    },
    text: () => tail.trim().split("\n").slice(-3).join("\n"),
  };
}

/** What an Always allow covers: a shell command exactly, any other tool by name. */
export function allowKey(toolName: string, input: unknown): string {
  if (toolName === "Bash" && input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string") {
    return `Bash:${(input as { command: string }).command}`;
  }
  return toolName;
}

export function claudeArgs(sessionId: string | null, bridgeArgs: readonly string[]): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    // Permission asks come to Tacit as control requests and show as cards.
    "--permission-prompt-tool",
    "stdio",
    ...(sessionId ? ["--resume", sessionId] : []),
    ...bridgeArgs,
  ];
}

/** Claude Code over stream-json (`claude -p`), one process for the whole chat. */
export function startClaudeDriver(options: DriverOptions): ChatDriver {
  const state = createClaudeStreamState();
  /** Inputs and suggested rules of pending approvals, to answer them. */
  const pendingInputs = new Map<string, { input: unknown; suggestions: unknown; toolName: string; elicitation?: Elicitation }>();
  /**
   * What the person chose Always allow for, for the rest of this chat: a
   * tool by name, or a shell command exactly. Claude's own suggested rule
   * is sent too, but not every ask has one (Tacit's tools don't), and
   * without this "always" would ask again next time.
   */
  const alwaysAllowed = new Set<string>();
  let interrupting = false;
  let exited = false;
  const err = stderrTail();

  const child = options.spawn(options.command, claudeArgs(options.sessionId, options.bridgeArgs), {
    cwd: options.cwd,
    env: options.env,
  });

  child.stdout.on(
    "data",
    lineReader((line) => {
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          request_id?: string;
          request?: { subtype?: string; tool_name?: string; input?: unknown; permission_suggestions?: unknown };
        };
        // What Claude offers (its models and modes), asked for at start.
        const reply = raw as { type?: string; response?: { request_id?: string; subtype?: string; response?: unknown } };
        if (reply.type === "control_response" && reply.response?.request_id === INIT_REQUEST) {
          if (reply.response.subtype === "success") {
            const caps = claudeCapabilities(reply.response.response);
            options.emit({ kind: "capabilities", models: caps.models, modes: caps.modes });
            settings = { ...caps.settings, ...withoutNulls(settings) };
            options.emit({ kind: "settings", settings });
          }
          return;
        }
        if (raw.type === "control_request" && raw.request?.subtype === "elicitation" && raw.request_id) {
          pendingInputs.set(raw.request_id, { input: null, suggestions: null, toolName: "elicitation", elicitation: claudeElicitation(raw.request as Record<string, unknown>) });
        }
        if (raw.type === "control_request" && raw.request?.subtype === "can_use_tool" && raw.request_id) {
          const toolName = raw.request.tool_name ?? "tool";
          // Allowed always earlier in this chat: answered without asking again.
          if (alwaysAllowed.has(allowKey(toolName, raw.request.input))) {
            write(claudeApprovalLine(raw.request_id, true, raw.request.input));
            return;
          }
          pendingInputs.set(raw.request_id, { input: raw.request.input, suggestions: raw.request.permission_suggestions, toolName });
        }
      } catch {
        // parseClaudeLine ignores it too.
      }
      for (const event of parseClaudeLine(state, line)) {
        if (event.kind === "turn_ended" && interrupting) {
          interrupting = false;
          options.emit({ ...event, outcome: "interrupted" });
          continue;
        }
        options.emit(event);
      }
    }),
  );
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.on("error", (error) => {
    if (exited) return;
    exited = true;
    options.emit({ kind: "exited", code: null, error: error.message });
  });
  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    options.log?.(`claude chat exited code=${code} ${err.text()}`);
    options.emit({ kind: "exited", code, ...(code ? { error: err.text() || `Claude exited with code ${code}` } : {}) });
  });

  const write = (line: string) => {
    if (!exited && child.stdin.writable) child.stdin.write(line);
  };
  let settings: ChatSettings = { model: null, effort: null, mode: null };
  let controlSeq = 0;
  const control = (request: Record<string, unknown>) => write(claudeControlLine(`tacit-control-${++controlSeq}`, request));
  write(claudeControlLine(INIT_REQUEST, { subtype: "initialize" }));

  return {
    // Claude reads each `@path` as an attachment: an image as an image.
    send: (text, attachments = []) => write(claudeUserLine(withMentions(text, attachments.map((a) => a.path)))),
    answerQuestion: (requestId, answers) => {
      const pending = pendingInputs.get(requestId);
      pendingInputs.delete(requestId);
      if (pending?.elicitation) {
        // An MCP server's question: accepted with the values, or declined when skipped.
        write(claudeElicitationLine(requestId, elicitationResult(pending.elicitation, answers)));
        options.emit({ kind: "question_settled", requestId });
        return;
      }
      // Skipped: answered with nothing, which Claude reads as skipped.
      write(claudeApprovalLine(requestId, true, claudeAnswerInput(pending?.input, answers ?? {})));
      options.emit({ kind: "question_settled", requestId });
    },
    configure: (change) => {
      if (change.model !== undefined && change.model !== settings.model && change.model) control({ subtype: "set_model", model: change.model });
      if (change.effort !== undefined && change.effort !== settings.effort && change.effort) control({ subtype: "apply_flag_settings", settings: { effortLevel: change.effort } });
      if (change.mode !== undefined && change.mode !== settings.mode && change.mode) control({ subtype: "set_permission_mode", mode: change.mode });
      settings = { ...settings, ...change };
      options.emit({ kind: "settings", settings });
    },
    interrupt: () => {
      interrupting = true;
      write(claudeInterruptLine(`interrupt-${randomUUID()}`));
    },
    answer: (requestId, decision, note) => {
      const pending = pendingInputs.get(requestId);
      pendingInputs.delete(requestId);
      if (decision === "allow_always" && pending) alwaysAllowed.add(allowKey(pending.toolName, pending.input));
      if (decision === "deny") {
        // Keep planning: Claude stays in plan mode and revises, rather than stopping.
        const message = pending?.toolName === "ExitPlanMode" ? claudeKeepPlanningMessage(note) : undefined;
        write(claudeApprovalLine(requestId, false, undefined, message));
      } else if (decision === "allow_always" && Array.isArray(pending?.suggestions) && pending.suggestions.length > 0) {
        // Claude's own suggested rule, so it stops asking for this.
        const line = JSON.parse(claudeApprovalLine(requestId, true, pending.input));
        line.response.response.updatedPermissions = pending.suggestions;
        write(`${JSON.stringify(line)}\n`);
      } else {
        write(claudeApprovalLine(requestId, true, pending?.input));
      }
      options.emit({ kind: "approval_settled", requestId });
    },
    stop: () => {
      if (exited) return;
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** Codex over JSON-RPC (`codex app-server`), one thread for the whole chat. */
export function startCodexDriver(options: DriverOptions): ChatDriver {
  const state = createCodexStreamState();
  let nextId = 0;
  let exited = false;
  let ready = false;
  const queued: Array<{ text: string; attachments: readonly ChatAttachment[] }> = [];
  const pending = new Map<number, (result: { result?: unknown; error?: { message?: string } }) => void>();
  const err = stderrTail();

  const child = options.spawn(options.command, ["app-server", ...options.bridgeArgs], {
    cwd: options.cwd,
    env: options.env,
  });

  const writeMessage = (message: Record<string, unknown>) => {
    if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method: string, params: unknown): Promise<{ result?: unknown; error?: { message?: string } }> =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      writeMessage({ id, method, params });
    });

  const fail = (message: string) => options.emit({ kind: "turn_ended", outcome: "error", error: message });

  let settings: ChatSettings = { model: null, effort: null, mode: null };
  /** What the person picked; the thread keeps the rest as it was. */
  let chosen: Partial<ChatSettings> = {};
  /** The mode before Plan, to go back to when a plan is carried out. */
  let beforePlan: string | null = null;
  /** The thread was last set to plan collaboration, so leaving it has to be said. */
  let planning = false;
  /** An approved plan, carried out once the mode to work in has been picked (or shortly after). */
  let implementTimer: ReturnType<typeof setTimeout> | null = null;
  /** What a turn sets: only what the person picked (Codex keeps it for later turns too). */
  const turnOverrides = (): Record<string, unknown> => {
    const mode = CODEX_MODES.find((m) => m.id === chosen.mode);
    const model = chosen.model ?? settings.model;
    const wantsPlan = chosen.mode === "plan";
    // Plan mode is Codex's plan collaboration mode, which needs the model to plan with.
    const collaboration =
      model && (wantsPlan || planning)
        ? { collaborationMode: { mode: wantsPlan ? "plan" : "default", settings: { model, reasoning_effort: chosen.effort ?? settings.effort ?? null, developer_instructions: null } } }
        : {};
    if (model) planning = wantsPlan;
    return {
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(mode ? { approvalPolicy: mode.approvalPolicy, sandboxPolicy: mode.sandboxPolicy } : {}),
      ...collaboration,
    };
  };
  /** Carries out the approved plan: out of Plan, into the mode picked, with Codex's own words for it. */
  const implementPlan = () => {
    if (implementTimer) clearTimeout(implementTimer);
    implementTimer = null;
    if (chosen.mode === "plan") {
      chosen = { ...chosen, mode: beforePlan ?? "auto" };
      settings = { ...settings, mode: chosen.mode ?? null };
      options.emit({ kind: "settings", settings });
    }
    const text = "Implement the plan.";
    options.emit({ kind: "user_message", id: randomUUID(), text, at: new Date().toISOString() });
    void startTurn(text);
  };

  const startTurn = async (text: string, attachments: readonly ChatAttachment[] = []) => {
    if (!state.threadId) return;
    const input = codexUserInput(text, attachments);
    if (state.turnId) {
      // Mid-turn: steer the running turn, as Codex's own app does.
      const steered = await request("turn/steer", { threadId: state.threadId, input, expectedTurnId: state.turnId });
      if (!steered.error) return;
    }
    const started = await request("turn/start", { threadId: state.threadId, input, ...turnOverrides() });
    if (started.error) fail(started.error.message ?? "Codex didn't start the turn.");
  };

  child.stdout.on(
    "data",
    lineReader((line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      // A response to one of our requests.
      if (typeof message.id === "number" && !("method" in message)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve?.(message as { result?: unknown; error?: { message?: string } });
        return;
      }
      const events = parseCodexMessage(state, message);
      // A request from Codex we can't show must still be answered, or its
      // turn waits forever.
      if ("method" in message && "id" in message && events.length === 0) {
        writeMessage({ id: message.id, error: { code: -32601, message: "Tacit doesn't handle this request." } });
        return;
      }
      for (const event of events) options.emit(event);
    }),
  );
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.on("error", (error) => {
    if (exited) return;
    exited = true;
    options.emit({ kind: "exited", code: null, error: error.message });
  });
  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    for (const resolve of pending.values()) resolve({ error: { message: "Codex exited." } });
    pending.clear();
    options.log?.(`codex chat exited code=${code} ${err.text()}`);
    options.emit({ kind: "exited", code, ...(code ? { error: err.text() || `Codex exited with code ${code}` } : {}) });
  });

  void (async () => {
    // Experimental API for plan mode (collaboration modes and plan items).
    const init = await request("initialize", {
      clientInfo: { name: "tacit", title: "Tacit", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (init.error) return fail(init.error.message ?? "Codex didn't start.");
    writeMessage({ method: "initialized" });
    const opened = options.sessionId
      ? await request("thread/resume", { threadId: options.sessionId, cwd: options.cwd })
      : await request("thread/start", { cwd: options.cwd });
    const thread = (opened.result as { thread?: { id?: string } } | undefined)?.thread;
    if (opened.error || typeof thread?.id !== "string") {
      return fail(opened.error?.message ?? "Codex didn't open the conversation.");
    }
    state.threadId = thread.id;
    options.emit({ kind: "session", sessionId: thread.id });
    // What it offers, and what this thread is on now.
    const listed = await request("model/list", {});
    const caps = codexCapabilities(listed.result, opened.result);
    options.emit({ kind: "capabilities", models: caps.models, modes: caps.modes });
    settings = { ...caps.settings, ...withoutNulls(settings) };
    options.emit({ kind: "settings", settings });
    // How much of the usage limit is used, known before the first turn
    // (the rolling updates only come with turns).
    void request("account/rateLimits/read", { excludeResetCreditDetails: true }).then((read) => {
      const limit = codexRateLimit((read.result as { rateLimits?: unknown } | undefined)?.rateLimits);
      if (limit) options.emit(limit);
    });
    ready = true;
    for (const message of queued.splice(0)) await startTurn(message.text, message.attachments);
  })();

  return {
    send: (text, attachments = []) => {
      if (!ready) {
        queued.push({ text, attachments });
        return;
      }
      void startTurn(text, attachments);
    },
    interrupt: () => {
      if (state.threadId && state.turnId) void request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
    },
    answer: (requestId, decision, note) => {
      // A proposed plan is ours to act on: carry it out, or keep planning.
      if (requestId.startsWith(CODEX_PLAN_PREFIX)) {
        options.emit({ kind: "approval_settled", requestId });
        // The card picks the mode to work in right after; carried out then,
        // or after a moment in the mode from before Plan.
        if (decision !== "deny") implementTimer = setTimeout(implementPlan, 400);
        // Keeping on planning, still in Plan: what they'd change is their next message.
        else if (note?.trim()) {
          options.emit({ kind: "user_message", id: randomUUID(), text: note.trim(), at: new Date().toISOString() });
          void startTurn(note.trim());
        }
        return;
      }
      const target = state.approvals.get(requestId);
      if (!target) return;
      state.approvals.delete(requestId);
      writeMessage({ id: target.rpcId, result: codexApprovalResult(target.method, decision, target) });
      options.emit({ kind: "approval_settled", requestId });
    },
    answerQuestion: (requestId, answers) => {
      // Asked as its turn ended: the answer is the next message (skipped, nothing is sent).
      if (requestId.startsWith(CODEX_ASYNC_QUESTION_PREFIX)) {
        const asked = state.asyncQuestions.get(requestId);
        if (!asked) return;
        state.asyncQuestions.delete(requestId);
        options.emit({ kind: "question_settled", requestId });
        options.emit({ kind: "tool_result", toolCallId: asked.itemId, isError: false, output: JSON.stringify(codexQuestionResult(answers)) });
        const reply = answers ? codexAsyncReply(asked.itemId, asked.questions, answers) : null;
        if (reply) {
          options.emit({ kind: "user_message", id: randomUUID(), text: reply.shown, at: new Date().toISOString() });
          void startTurn(reply.text);
        }
        return;
      }
      const target = state.approvals.get(requestId);
      if (!target) return;
      state.approvals.delete(requestId);
      const result = target.elicitation ? codexElicitationResult(target.elicitation, answers) : codexQuestionResult(answers);
      writeMessage({ id: target.rpcId, result });
      options.emit({ kind: "question_settled", requestId });
      // The questions' card in the thread gets the answers.
      if (target.toolCallId) options.emit({ kind: "tool_result", toolCallId: target.toolCallId, isError: false, output: JSON.stringify(result) });
    },
    configure: (change) => {
      if (change.mode === "plan" && chosen.mode !== "plan") beforePlan = chosen.mode ?? settings.mode ?? null;
      chosen = { ...chosen, ...change };
      settings = { ...settings, ...change };
      options.emit({ kind: "settings", settings });
      if (implementTimer && change.mode && change.mode !== "plan") implementPlan();
    },
    stop: () => {
      if (exited) return;
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** Only the settings someone chose (null is "the agent's default"). */
function withoutNulls(settings: ChatSettings): Partial<ChatSettings> {
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null)) as Partial<ChatSettings>;
}

/**
 * OpenCode over the Agent Client Protocol (`opencode acp`), one session for
 * the whole chat. A session it already has is loaded, and the history it
 * replays comes as one `history` event that replaces what the chat held,
 * as Claude's and Codex's do from their session files. A prompt runs one
 * turn and there's no steering one, so a message sent mid-turn waits for
 * it. OpenCode gets Tacit's tools from its environment (the adapter's
 * OPENCODE_CONFIG_CONTENT), so the session is opened with no MCP servers
 * of its own.
 */
export function startOpenCodeDriver(options: DriverOptions): ChatDriver {
  const state = createAcpStreamState();
  let nextId = 0;
  let exited = false;
  /** Tacit asked it to stop: OpenCode leaves with code 130 then, which isn't a failure. */
  let stopping = false;
  let ready = false;
  let running = false;
  /** While a session loads, its replay is collected here rather than shown. */
  let replay: ChatEvent[] | null = null;
  let configOptions: unknown = null;
  /** Each model's efforts, as seen while it was in use (OpenCode lists the current model's only). */
  const knownEfforts = new Map<string, string[]>();
  let settings: ChatSettings = { model: null, effort: null, mode: null };
  let chosen: Partial<ChatSettings> = {};
  /** The mode before Plan, to go back to when a plan is carried out. */
  let beforePlan: string | null = null;
  let planSeq = 0;
  /** An approved plan, carried out once the mode to work in is set (or shortly after). */
  let implementTimer: ReturnType<typeof setTimeout> | null = null;
  const queued: Array<{ text: string; attachments: readonly ChatAttachment[] }> = [];
  const pending = new Map<number, (result: { result?: unknown; error?: { message?: string } }) => void>();
  const err = stderrTail();

  const child = options.spawn(options.command, ["acp", ...options.bridgeArgs], { cwd: options.cwd, env: options.env });

  const writeMessage = (message: Record<string, unknown>) => {
    if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method: string, params: unknown): Promise<{ result?: unknown; error?: { message?: string } }> =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      writeMessage({ id, method, params });
    });
  const emitAll = (events: ChatEvent[]) => {
    if (replay) replay.push(...events);
    else for (const event of events) options.emit(event);
  };
  const fail = (message: string) => options.emit({ kind: "turn_ended", outcome: "error", error: message });

  /** What the session offers and what's in use, said again after it changes (a model brings its own efforts). */
  const announce = () => {
    const caps = acpCapabilities(configOptions, knownEfforts);
    options.emit({ kind: "capabilities", models: caps.models, modes: caps.modes });
    settings = caps.settings;
    options.emit({ kind: "settings", settings });
  };

  /**
   * Sets what the person picked on the session: the model first, then each
   * other option against the options as they then stand.
   */
  const applyChosen = async (change: Partial<ChatSettings>) => {
    if (change.mode === "plan" && settings.mode !== "plan") beforePlan = settings.mode;
    for (const key of ["model", "effort", "mode"] as const) {
      if (change[key] === undefined) continue;
      for (const { configId, value } of acpConfigChanges(configOptions, { [key]: change[key] })) {
        const set = await request("session/set_config_option", { sessionId: state.sessionId, configId, value });
        if (set.error) {
          fail(set.error.message ?? `OpenCode didn't change its ${configId}.`);
          continue;
        }
        const next = (set.result as { configOptions?: unknown } | undefined)?.configOptions;
        if (next) configOptions = next;
      }
    }
    announce();
  };

  /** Carries out the approved plan: out of Plan, then Codex's and Claude's words for it. */
  const implementPlan = async () => {
    if (implementTimer) clearTimeout(implementTimer);
    implementTimer = null;
    if (settings.mode === "plan") await applyChosen({ mode: beforePlan && beforePlan !== "plan" ? beforePlan : "build" });
    const text = "Implement the plan.";
    options.emit({ kind: "user_message", id: randomUUID(), text, at: new Date().toISOString() });
    send(text, []);
  };

  const prompt = async (text: string, attachments: readonly ChatAttachment[]) => {
    running = true;
    state.lastReply = "";
    const planning = settings.mode === "plan";
    const done = await request("session/prompt", { sessionId: state.sessionId, prompt: acpPrompt(text, attachments) });
    const stop = done.error ? { outcome: "error" as const, error: done.error.message ?? "OpenCode couldn't run the turn." } : acpStopOutcome((done.result as { stopReason?: unknown } | undefined)?.stopReason);
    emitAll(acpTurnEnded(state, stop.outcome, stop.error));
    // A turn in Plan that ends with a reply is a plan: offered to start on,
    // as Claude's and Codex's are. OpenCode itself asks nothing.
    if (planning && stop.outcome === "success" && state.lastReply.trim() && queued.length === 0) {
      options.emit({ kind: "approval_request", requestId: `${ACP_PLAN_PREFIX}${++planSeq}`, toolName: "ExitPlanMode", input: { plan: state.lastReply.trim() } });
    }
    running = false;
    const next = queued.shift();
    if (next) void prompt(next.text, next.attachments);
  };

  child.stdout.on(
    "data",
    lineReader((line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.id === "number" && !("method" in message)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve?.(message as { result?: unknown; error?: { message?: string } });
        return;
      }
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.method === "session/update" && params.update && typeof params.update === "object") {
        emitAll(parseAcpUpdate(state, params.update as Record<string, unknown>));
        return;
      }
      if (message.method === "session/request_permission" && (typeof message.id === "number" || typeof message.id === "string")) {
        emitAll(parseAcpPermission(state, message.id, params));
        return;
      }
      // Anything else OpenCode asks (file or terminal access we didn't offer) is refused, not left hanging.
      if ("method" in message && "id" in message) writeMessage({ id: message.id, error: { code: -32601, message: "Tacit doesn't handle this request." } });
    }),
  );
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.on("error", (error) => {
    if (exited) return;
    exited = true;
    options.emit({ kind: "exited", code: null, error: error.message });
  });
  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    for (const resolve of pending.values()) resolve({ error: { message: "OpenCode exited." } });
    pending.clear();
    options.log?.(`opencode chat exited code=${code} ${err.text()}`);
    if (stopping) options.emit({ kind: "exited", code: null });
    else options.emit({ kind: "exited", code, ...(code ? { error: err.text() || `OpenCode exited with code ${code}` } : {}) });
  });

  void (async () => {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (init.error) return fail(init.error.message ?? "OpenCode didn't start.");
    let opened: { result?: unknown; error?: { message?: string } };
    if (options.sessionId) {
      replay = [];
      opened = await request("session/load", { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] });
      const history = replay;
      replay = null;
      if (opened.error) return fail(`OpenCode couldn't open session ${options.sessionId}: ${opened.error.message ?? "unknown error"}`);
      if (state.inTurn || state.user) history.push(...acpTurnEnded(state, "success"));
      state.sessionId = options.sessionId;
      options.emit({ kind: "history", events: history });
    } else {
      opened = await request("session/new", { cwd: options.cwd, mcpServers: [] });
      const id = (opened.result as { sessionId?: unknown } | undefined)?.sessionId;
      if (opened.error || typeof id !== "string") return fail(opened.error?.message ?? "OpenCode didn't open a session.");
      state.sessionId = id;
    }
    options.emit({ kind: "session", sessionId: state.sessionId! });
    configOptions = (opened.result as { configOptions?: unknown } | undefined)?.configOptions ?? null;
    announce();
    if (Object.keys(chosen).length > 0) await applyChosen(chosen);
    ready = true;
    const next = queued.shift();
    if (next) void prompt(next.text, next.attachments);
  })();

  const send = (text: string, attachments: readonly ChatAttachment[]) => {
    if (!ready || running) {
      queued.push({ text, attachments });
      return;
    }
    void prompt(text, attachments);
  };

  return {
    send: (text, attachments = []) => send(text, attachments),
    interrupt: () => {
      if (!state.sessionId) return;
      writeMessage({ method: "session/cancel", params: { sessionId: state.sessionId } });
      // Asks still open are answered as cancelled, as the protocol wants.
      for (const [requestId, ask] of state.permissions) {
        writeMessage({ id: ask.rpcId, result: { outcome: { outcome: "cancelled" } } });
        options.emit({ kind: "approval_settled", requestId });
      }
      state.permissions.clear();
      queued.length = 0;
    },
    answer: (requestId, decision, note) => {
      // The plan offered after a turn in Plan: start on it, or keep planning.
      if (requestId.startsWith(ACP_PLAN_PREFIX)) {
        options.emit({ kind: "approval_settled", requestId });
        // The card picks the mode to work in right after; carried out then,
        // or after a moment in the mode from before Plan.
        if (decision !== "deny") implementTimer = setTimeout(() => void implementPlan(), 400);
        else if (note?.trim()) {
          options.emit({ kind: "user_message", id: randomUUID(), text: note.trim(), at: new Date().toISOString() });
          send(note.trim(), []);
        }
        return;
      }
      const ask = state.permissions.get(requestId);
      if (!ask) return;
      state.permissions.delete(requestId);
      writeMessage({ id: ask.rpcId, result: acpPermissionOutcome(ask.options, decision) });
      options.emit({ kind: "approval_settled", requestId });
    },
    // OpenCode asks nothing but permissions over ACP.
    answerQuestion: () => {},
    configure: (change) => {
      chosen = { ...chosen, ...change };
      if (!ready) return;
      const applied = applyChosen(change);
      // The plan's card picked the mode to work in: carry it out once that's set.
      if (implementTimer && change.mode && change.mode !== "plan") {
        clearTimeout(implementTimer);
        implementTimer = null;
        void applied.then(implementPlan);
      }
    },
    stop: () => {
      if (exited) return;
      stopping = true;
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
