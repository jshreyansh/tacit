import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ChatEngine, appendEvent } from "../electron/manager-chat/chat-engine";
import type { ChatEvent } from "../shared/chat-events";

/** What Tacit wrote to Claude after asking what it offers (the initialize request it sends at start). */
function sentToClaude(child: { written: string[] }): Array<Record<string, any>> {
  return child.written.map((l) => JSON.parse(l)).filter((m) => !(m.type === "control_request" && m.request?.subtype === "initialize"));
}

/** A stand-in agent process: what Tacit writes is kept, what it prints is ours to feed. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: string[] = [];
  killed = false;
  onWrite: (line: string) => void = () => {};
  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        this.written.push(line);
        this.onWrite(line);
      }
      done();
    },
  });
  kill() {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
  print(line: string | object) {
    this.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
  }
}

function setup(
  agent: "claude" | "codex",
  sessionId: string | null = null,
  loadHistory?: (agent: "claude" | "codex", sessionId: string) => Promise<ChatEvent[] | null>,
) {
  const logged: string[] = [];
  const child = new FakeChild();
  const spawned: Array<{ command: string; args: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
  const events: ChatEvent[] = [];
  const turnsEnded: Array<string | null> = [];
  const engine = new ChatEngine({
    spawn: (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd as string, env: options.env as Record<string, string> });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    prepare: async (req) => ({ command: req.agent, bridgeArgs: ["--mcp-config", "/tmp/tacit-mcp-t1.json"], env: { TACIT_TERMINAL_ID: req.terminalId } }),
    onEvent: (_id, event) => events.push(event),
    onTurnEnded: (_id, session) => turnsEnded.push(session),
    now: () => new Date("2026-10-17T12:00:00Z"),
    log: (line) => logged.push(line),
    ...(loadHistory ? { loadHistory } : {}),
  });
  const started = engine.start({ terminalId: "t1", agent, cwd: "/repo", sessionId });
  return { child, spawned, events, turnsEnded, engine, started, logged };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Claude starts in stream-json with approvals routed to Tacit, the bridge, and the session to resume", async () => {
  const { spawned, started } = setup("claude", "sess-1");
  await started;
  assert.equal(spawned[0].command, "claude");
  assert.deepEqual(spawned[0].args, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--permission-prompt-tool", "stdio", "--resume", "sess-1", "--mcp-config", "/tmp/tacit-mcp-t1.json",
  ]);
  assert.equal(spawned[0].cwd, "/repo");
  assert.equal(spawned[0].env?.TACIT_TERMINAL_ID, "t1");
});

test("what Claude prints becomes the chat, and its turn end reaches telemetry with the session", async () => {
  const { child, events, turnsEnded, engine, started } = setup("claude");
  await started;
  for (const line of fs.readFileSync(path.join(import.meta.dirname, "fixtures/claude-stream/reply.jsonl"), "utf-8").split("\n").filter(Boolean)) {
    child.print(line);
  }
  await tick();
  assert.ok(events.some((e) => e.kind === "text_delta"));
  assert.deepEqual(turnsEnded, ["423fcc3d-6923-4bbf-82da-b679c92aff85"]);
  assert.equal(engine.sessionIdOf("t1"), "423fcc3d-6923-4bbf-82da-b679c92aff85");
  // A window catching up gets the same conversation, deltas merged.
  const snapshot = engine.snapshot("t1");
  assert.ok(snapshot.length <= events.length);
});

test("a message is written to Claude's stdin and shown at once as the person's", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  assert.equal(engine.send("t1", "hello"), true);
  assert.deepEqual(sentToClaude(child)[0], { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  const shown = events.find((e) => e.kind === "user_message");
  assert.ok(shown && shown.kind === "user_message" && shown.text === "hello" && shown.at === "2026-10-17T12:00:00.000Z");
  assert.equal(engine.send("nobody", "hi"), false);
});

test("Stop interrupts Claude, and the turn it ends reads as interrupted", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  engine.interrupt("t1");
  const req = sentToClaude(child)[0];
  assert.equal(req.type, "control_request");
  assert.deepEqual(req.request, { subtype: "interrupt" });
  child.print({ type: "result", subtype: "success", is_error: false });
  await tick();
  const ended = events.find((e) => e.kind === "turn_ended");
  assert.ok(ended && ended.kind === "turn_ended" && ended.outcome === "interrupted");
});

test("an approval is answered with the tool's own input, and 'always' passes on Claude's suggested rule", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "localSettings" }];
  child.print({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" }, permission_suggestions: suggestions } });
  child.print({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" } } });
  await tick();
  assert.equal(events.filter((e) => e.kind === "approval_request").length, 2);
  engine.answer("t1", "r1", "allow_always");
  engine.answer("t1", "r2", "deny");
  const [always, deny] = sentToClaude(child);
  assert.deepEqual(always.response.response, { behavior: "allow", updatedInput: { command: "git push" }, updatedPermissions: suggestions });
  assert.equal(always.response.request_id, "r1");
  assert.equal(deny.response.response.behavior, "deny");
  assert.equal(events.filter((e) => e.kind === "approval_settled").length, 2);
});

test("a Claude that fails to start says why, from what it printed", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  child.stderr.write("Error: invalid API key\n");
  await tick();
  child.emit("exit", 1);
  const exited = events.find((e) => e.kind === "exited");
  assert.ok(exited && exited.kind === "exited" && exited.code === 1 && exited.error === "Error: invalid API key");
  assert.equal(engine.isRunning("t1"), false);
  assert.equal(engine.send("t1", "hi"), false);
});

/** A fake Codex app-server: answers the handshake and records requests. */
function codexServer(child: FakeChild, opts: { threadId?: string } = {}) {
  const requests: Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }> = [];
  child.onWrite = (line) => {
    const msg = JSON.parse(line);
    requests.push(msg);
    if (msg.method === "initialize") child.print({ id: msg.id, result: { platformOs: "macos" } });
    if (msg.method === "thread/start" || msg.method === "thread/resume") {
      child.print({ id: msg.id, result: { thread: { id: opts.threadId ?? "thread-1" }, model: "gpt-5.3", reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } } });
    }
    if (msg.method === "model/list") {
      child.print({ id: msg.id, result: { data: [{ model: "gpt-5.3", displayName: "GPT-5.3", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] }] } });
    }
    if (msg.method === "turn/start" || msg.method === "turn/steer" || msg.method === "turn/interrupt") child.print({ id: msg.id, result: {} });
  };
  return requests;
}

test("Codex starts app-server with the bridge, opens a thread in the terminal's folder, then sends what was typed meanwhile", async () => {
  const { child, spawned, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  assert.deepEqual(spawned[0].args, ["app-server", "--mcp-config", "/tmp/tacit-mcp-t1.json"]);
  engine.send("t1", "early message");
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.map((r) => r.method).filter(Boolean), ["initialize", "initialized", "thread/start", "model/list", "account/rateLimits/read", "turn/start"]);
  assert.deepEqual(requests.find((r) => r.method === "thread/start")?.params, { cwd: "/repo" });
  assert.deepEqual(requests.find((r) => r.method === "turn/start")?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "early message", text_elements: [] }],
  });
  assert.ok(events.some((e) => e.kind === "session" && e.sessionId === "thread-1"));
});

test("Codex resumes the terminal's thread, steers a running turn, and is interrupted by turn id", async () => {
  const { child, engine, started } = setup("codex", "thread-9");
  const requests = codexServer(child, { threadId: "thread-9" });
  await started;
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(requests.find((r) => r.method === "thread/resume")?.params, { threadId: "thread-9", cwd: "/repo" });
  child.print({ method: "turn/started", params: { threadId: "thread-9", turn: { id: "turn-1", status: "inProgress" } } });
  await tick();
  engine.send("t1", "also check e2e");
  for (let i = 0; i < 4; i++) await tick();
  const steer = requests.find((r) => r.method === "turn/steer");
  assert.equal(steer?.params?.expectedTurnId, "turn-1");
  engine.interrupt("t1");
  await tick();
  assert.deepEqual(requests.find((r) => r.method === "turn/interrupt")?.params, { threadId: "thread-9", turnId: "turn-1" });
});

test("Codex approvals are answered by id in its words; requests Tacit can't show are refused, not left hanging", async () => {
  const { child, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  for (let i = 0; i < 6; i++) await tick();
  child.print({ id: 41, method: "item/commandExecution/requestApproval", params: { itemId: "e1", command: "git push", threadId: "thread-1", turnId: "u", startedAtMs: 0 } });
  child.print({ id: 42, method: "account/chatgptAuthTokens/refresh", params: {} });
  await tick();
  assert.ok(events.some((e) => e.kind === "approval_request" && e.requestId === "codex-41"));
  const refused = requests.find((r) => r.id === 42);
  assert.ok(refused && refused.error, "the unknown request got an error back");
  engine.answer("t1", "codex-41", "allow_once");
  assert.deepEqual(requests.find((r) => r.id === 41)?.result, { decision: "accept" });
});

test("streaming deltas of one block are merged in the kept events", () => {
  const events: ChatEvent[] = [];
  appendEvent(events, { kind: "block_start", key: "k", block: "text" });
  appendEvent(events, { kind: "text_delta", key: "k", text: "Hel" });
  appendEvent(events, { kind: "text_delta", key: "k", text: "lo" });
  appendEvent(events, { kind: "text_delta", key: "other", text: "x" });
  assert.deepEqual(events.map((e) => (e.kind === "text_delta" ? e.text : e.kind)), ["block_start", "Hello", "x"]);
});

test("a second start while the agent runs starts nothing new", async () => {
  const { spawned, engine, started } = setup("claude");
  await started;
  await engine.start({ terminalId: "t1", agent: "claude", cwd: "/repo", sessionId: null });
  assert.equal(spawned.length, 1);
  engine.stop("t1");
  assert.equal(engine.isRunning("t1"), false);
});

test("a resumed chat opens on the session's history from the agent's record", async () => {
  const history: ChatEvent[] = [
    { kind: "user_message", id: "h1", text: "said in the terminal", at: "2026-10-17T11:00:00Z" },
    { kind: "block_start", key: "h0", block: "text" },
    { kind: "block_done", key: "h0", text: "noted" },
    { kind: "turn_ended", outcome: "success" },
  ];
  const asked: Array<[string, string]> = [];
  const { engine, started } = setup("claude", "sess-9", async (agent, id) => {
    asked.push([agent, id]);
    return history;
  });
  await started;
  assert.deepEqual(asked, [["claude", "sess-9"]]);
  assert.deepEqual(engine.snapshot("t1"), history);
  engine.send("t1", "and now in the chat");
  assert.equal(engine.snapshot("t1").length, history.length + 1);
});

test("history replaces what the chat held, and an unreadable record keeps it and says why", async () => {
  let fail = false;
  const { engine, started, logged } = setup("claude", "sess-9", async () => {
    if (fail) throw new Error("EACCES");
    return [{ kind: "user_message", id: "h1", text: "from the record", at: "2026-10-17T11:00:00Z" }];
  });
  await started;
  engine.send("t1", "typed in the chat");
  engine.stop("t1");
  await engine.start({ terminalId: "t1", agent: "claude", cwd: "/repo", sessionId: "sess-9" });
  assert.deepEqual(engine.snapshot("t1").map((e) => (e.kind === "user_message" ? e.text : e.kind)), ["from the record"]);

  engine.send("t1", "kept");
  engine.stop("t1");
  fail = true;
  await engine.start({ terminalId: "t1", agent: "claude", cwd: "/repo", sessionId: "sess-9" });
  const said = engine.snapshot("t1").flatMap((e) => (e.kind === "user_message" ? [e.text] : []));
  assert.deepEqual(said, ["from the record", "kept"]);
  assert.ok(logged.some((line) => line.includes("unreadable") && line.includes("EACCES")));
});

test("a new chat with no session reads no history", async () => {
  let asked = false;
  const { started } = setup("claude", null, async () => {
    asked = true;
    return [];
  });
  await started;
  assert.equal(asked, false);
});

test("Claude: Always allow covers the next ask for that tool (or that exact command) without asking again", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  const ask = (id: string, tool: string, input: object) =>
    child.print({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input } });
  ask("r1", "mcp__tacit__update_task", { id: "a" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.filter((e) => e.kind === "approval_request").length, 1);
  engine.answer("t1", "r1", "allow_always");
  ask("r2", "mcp__tacit__update_task", { id: "b" });
  ask("r3", "Bash", { command: "npm test" });
  await new Promise((r) => setTimeout(r, 10));
  // The second update_task was answered for you; the shell command still asks.
  assert.deepEqual(events.filter((e) => e.kind === "approval_request").map((e) => (e as { requestId: string }).requestId), ["r1", "r3"]);
  assert.ok(child.written.some((l) => l.includes('"request_id":"r2"') && l.includes('"behavior":"allow"')));
  engine.answer("t1", "r3", "allow_always");
  ask("r4", "Bash", { command: "npm test" });
  ask("r5", "Bash", { command: "rm -rf build" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events.filter((e) => e.kind === "approval_request").map((e) => (e as { requestId: string }).requestId), ["r1", "r3", "r5"]);
});

test("Codex: what it offers comes from model/list and the thread; a change applies to the next turn", async () => {
  const { child, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  for (let i = 0; i < 8; i++) await tick();
  const caps = events.find((e) => e.kind === "capabilities");
  assert.ok(caps && caps.kind === "capabilities" && caps.models[0].id === "gpt-5.3");
  assert.deepEqual(
    [...events].reverse().find((e) => e.kind === "settings"),
    { kind: "settings", settings: { model: "gpt-5.3", effort: "medium", mode: "auto" } },
  );
  engine.configure("t1", { effort: "high", mode: "full-access" });
  engine.send("t1", "go");
  for (let i = 0; i < 4; i++) await tick();
  const turn = requests.find((r) => r.method === "turn/start");
  assert.equal(turn?.params?.effort, "high");
  // Only what was picked: the model stays the thread's own.
  assert.equal(turn?.params?.model, undefined);
  assert.equal(turn?.params?.approvalPolicy, "never");
  assert.deepEqual(turn?.params?.sandboxPolicy, { type: "dangerFullAccess" });
});

test("Codex: a question is answered by id", async () => {
  const { child, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  for (let i = 0; i < 6; i++) await tick();
  child.print({ id: 55, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "u", itemId: "i", isBlocking: true, questions: [{ id: "env", header: "Env", question: "Which?", options: [{ label: "Prod", description: "" }] }] } });
  await tick();
  assert.ok(events.some((e) => e.kind === "question_request" && e.requestId === "codex-55"));
  engine.answerQuestion("t1", "codex-55", { env: ["Prod"] });
  await tick();
  assert.deepEqual(requests.find((r) => r.id === 55)?.result, { answers: { env: { answers: ["Prod"] } } });
  assert.ok(events.some((e) => e.kind === "question_settled" && e.requestId === "codex-55"));
});

test("Claude: asks what it offers at start, switches model, effort and mode at once, and answers questions in its form", async () => {
  const { child, events, engine, started } = setup("claude");
  await started;
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(child.written[0].includes('"subtype":"initialize"'));
  child.print({
    type: "control_response",
    response: { subtype: "success", request_id: "tacit-initialize", response: { current_permission_mode: "default", models: [{ value: "default", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] } },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(events.some((e) => e.kind === "capabilities"));
  engine.configure("t1", { model: "sonnet", effort: "high", mode: "plan" });
  await new Promise((r) => setTimeout(r, 5));
  const controls = child.written.map((l) => JSON.parse(l)).filter((m) => m.type === "control_request").map((m) => m.request);
  assert.deepEqual(controls.slice(1), [
    { subtype: "set_model", model: "sonnet" },
    { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
    { subtype: "set_permission_mode", mode: "plan" },
  ]);
  child.print({
    type: "control_request",
    request_id: "q1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Colour?", header: "C", options: [{ label: "Blue" }], multiSelect: false }] } },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(events.some((e) => e.kind === "question_request" && e.requestId === "q1"));
  engine.answerQuestion("t1", "q1", { "Colour?": ["Blue"] });
  await new Promise((r) => setTimeout(r, 5));
  const reply = child.written.map((l) => JSON.parse(l)).find((m) => m.type === "control_response" && m.response.request_id === "q1");
  assert.equal(reply.response.response.behavior, "allow");
  assert.deepEqual(reply.response.response.updatedInput.answers, { "Colour?": "Blue" });
});
