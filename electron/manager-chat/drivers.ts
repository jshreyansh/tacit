import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { ApprovalDecision, ChatAnswers, ChatEvent, ChatSettings } from "../../shared/chat-events";
import {
  claudeAnswerInput,
  claudeApprovalLine,
  claudeCapabilities,
  claudeControlLine,
  claudeInterruptLine,
  claudeUserLine,
  createClaudeStreamState,
  parseClaudeLine,
} from "../../shared/chat-stream-claude";
import {
  CODEX_MODES,
  codexApprovalResult,
  codexCapabilities,
  codexQuestionResult,
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
  send(text: string): void;
  interrupt(): void;
  answer(requestId: string, decision: ApprovalDecision): void;
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
  const pendingInputs = new Map<string, { input: unknown; suggestions: unknown; toolName: string }>();
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
    send: (text) => write(claudeUserLine(text)),
    answerQuestion: (requestId, answers) => {
      const pending = pendingInputs.get(requestId);
      pendingInputs.delete(requestId);
      if (answers === null) write(claudeApprovalLine(requestId, false, undefined, "The person skipped these questions."));
      else write(claudeApprovalLine(requestId, true, claudeAnswerInput(pending?.input, answers)));
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
    answer: (requestId, decision) => {
      const pending = pendingInputs.get(requestId);
      pendingInputs.delete(requestId);
      if (decision === "allow_always" && pending) alwaysAllowed.add(allowKey(pending.toolName, pending.input));
      if (decision === "deny") {
        write(claudeApprovalLine(requestId, false, undefined));
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
  const queued: string[] = [];
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
  /** What a turn sets: only what the person picked (Codex keeps it for later turns too). */
  const turnOverrides = (): Record<string, unknown> => {
    const mode = CODEX_MODES.find((m) => m.id === chosen.mode);
    return {
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(mode ? { approvalPolicy: mode.approvalPolicy, sandboxPolicy: mode.sandboxPolicy } : {}),
    };
  };

  const startTurn = async (text: string) => {
    if (!state.threadId) return;
    const input = codexUserInput(text);
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
    const init = await request("initialize", { clientInfo: { name: "tacit", title: "Tacit", version: "1" }, capabilities: null });
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
    ready = true;
    for (const text of queued.splice(0)) await startTurn(text);
  })();

  return {
    send: (text) => {
      if (!ready) {
        queued.push(text);
        return;
      }
      void startTurn(text);
    },
    interrupt: () => {
      if (state.threadId && state.turnId) void request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
    },
    answer: (requestId, decision) => {
      const target = state.approvals.get(requestId);
      if (!target) return;
      state.approvals.delete(requestId);
      writeMessage({ id: target.rpcId, result: codexApprovalResult(target.method, decision) });
      options.emit({ kind: "approval_settled", requestId });
    },
    answerQuestion: (requestId, answers) => {
      const target = state.approvals.get(requestId);
      if (!target) return;
      state.approvals.delete(requestId);
      writeMessage({ id: target.rpcId, result: codexQuestionResult(answers) });
      options.emit({ kind: "question_settled", requestId });
    },
    configure: (change) => {
      chosen = { ...chosen, ...change };
      settings = { ...settings, ...change };
      options.emit({ kind: "settings", settings });
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
