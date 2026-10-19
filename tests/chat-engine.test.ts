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
  agent: "claude" | "codex" | "opencode",
  sessionId: string | null = null,
  loadHistory?: (agent: "claude" | "codex" | "opencode", sessionId: string) => Promise<ChatEvent[] | null>,
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
  // The card in the thread gets the answer.
  assert.ok(events.some((e) => e.kind === "tool_result" && e.toolCallId === "i" && e.output === JSON.stringify({ answers: { env: { answers: ["Prod"] } } })));
});

test("Codex: an async question is answered with the next message; skipped, nothing is sent", async () => {
  const { child, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  for (let i = 0; i < 6; i++) await tick();
  const ask = (id: string) =>
    child.print({ method: "item/completed", params: { threadId: "thread-1", turnId: "u", item: { type: "agentMessage", id, text: "Lunch?", delivery: "async", questions: [{ title: "Lunch?", options: ["Salad"] }] } } });
  ask("c1");
  await tick();
  assert.ok(events.some((e) => e.kind === "question_request" && e.requestId === "codex-ask-c1"));
  engine.answerQuestion("t1", "codex-ask-c1", { q0: ["Salad"] });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(events.some((e) => e.kind === "question_settled" && e.requestId === "codex-ask-c1"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.toolCallId === "c1" && e.output === JSON.stringify({ answers: { q0: { answers: ["Salad"] } } })));
  assert.ok(events.some((e) => e.kind === "user_message" && e.text === "Salad"));
  // Codex gets the answer in its own envelope.
  const sent = JSON.stringify(requests.filter((r) => r.method === "turn/start" || r.method === "turn/steer").at(-1)?.params?.input);
  assert.ok(sent.includes("<send_user_message_question_reply>") && sent.includes("request_user_input_async"), sent);
  const turns = () => requests.filter((r) => r.method === "turn/start" || r.method === "turn/steer").length;
  const before = turns();
  assert.ok(before >= 1);
  ask("c2");
  await tick();
  engine.answerQuestion("t1", "codex-ask-c2", null);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(turns(), before);
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

test("Keep planning: Claude is told to stay in plan mode and revise with what the person would change, not just refused", async () => {
  const { child, engine, started } = setup("claude");
  await started;
  const plan = (id: string) => child.print({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. Add x.txt" } } });
  plan("p1");
  plan("p2");
  child.print({ type: "control_request", request_id: "b1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });
  await tick();
  engine.answer("t1", "p1", "deny", "Put it in docs/ instead");
  engine.answer("t1", "p2", "deny");
  engine.answer("t1", "b1", "deny");
  const [withNote, empty, bash] = sentToClaude(child).map((m) => m.response.response);
  assert.equal(withNote.behavior, "deny");
  assert.match(withNote.message, /keep planning/);
  assert.match(withNote.message, /don't make any changes/);
  assert.match(withNote.message, /Put it in docs\/ instead/);
  assert.match(withNote.message, /Revise the plan/);
  // Nothing typed: Claude asks what to change.
  assert.match(empty.message, /keep planning/);
  assert.match(empty.message, /Ask them what they'd like changed/);
  // Any other refusal is as before.
  assert.equal(bash.message, "The person declined this in Tacit.");
});

test("Keep planning with Codex: what the person would change is their next message, still in Plan; nothing typed, nothing sent", async () => {
  const { child, events, engine, started } = setup("codex");
  const requests = codexServer(child);
  await started;
  for (let i = 0; i < 6; i++) await tick();
  const turns = () => requests.filter((r) => r.method === "turn/start" || r.method === "turn/steer");
  const before = turns().length;
  engine.answer("t1", "codex-plan-p1", "deny");
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(turns().length, before);
  engine.answer("t1", "codex-plan-p2", "deny", "Use a shorter name");
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(events.some((e) => e.kind === "user_message" && e.text === "Use a shorter name"));
  assert.equal(turns().length, before + 1);
  assert.ok(JSON.stringify(turns().at(-1)?.params?.input).includes("Use a shorter name"));
  assert.ok(!events.some((e) => e.kind === "user_message" && e.text === "Implement the plan."));
});

/** A stand-in `opencode acp`: answers as opencode 2.0.29 does, and can replay a session on load. */
function openCodeServer(child: FakeChild, opts: { replay?: object[]; stopReason?: string; holdPrompt?: boolean } = {}) {
  const requests: Array<{ id?: number | string; method?: string; params?: Record<string, any>; result?: any }> = [];
  const config = [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [{ value: "opencode/big-pickle", name: "opencode/Big Pickle" }, { value: "anthropic/claude-opus", name: "anthropic/Claude Opus" }] },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "default", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "default", name: "Default" }] },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
  ];
  const prompts: Array<number> = [];
  const respondPrompt = (id: number) => child.print({ jsonrpc: "2.0", id, result: { stopReason: opts.stopReason ?? "end_turn" } });
  child.onWrite = (line) => {
    const msg = JSON.parse(line);
    requests.push(msg);
    if (msg.method === "initialize") child.print({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (msg.method === "session/new") child.print({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses_new1", configOptions: config } });
    if (msg.method === "session/load") {
      for (const update of opts.replay ?? []) child.print({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update } });
      child.print({ jsonrpc: "2.0", id: msg.id, result: { configOptions: config } });
    }
    if (msg.method === "session/set_config_option") {
      // The session's options as they now stand, as OpenCode answers.
      for (const o of config) if (o.id === msg.params.configId) o.currentValue = msg.params.value;
      child.print({ jsonrpc: "2.0", id: msg.id, result: { configOptions: config } });
    }
    if (msg.method === "session/prompt") {
      if (opts.holdPrompt) prompts.push(msg.id);
      else respondPrompt(msg.id);
    }
  };
  return { requests, release: () => prompts.splice(0).forEach(respondPrompt) };
}
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

test("OpenCode starts `opencode acp`, opens a session in the folder, offers its models and modes, and sends what was typed meanwhile", async () => {
  const { child, spawned, events, engine, started } = setup("opencode");
  const { requests } = openCodeServer(child);
  await started;
  assert.deepEqual(spawned[0].args, ["acp", "--mcp-config", "/tmp/tacit-mcp-t1.json"]);
  engine.send("t1", "early message", [{ id: "a1", name: "shot.png", path: "/tmp/shot one.png", kind: "image" }]);
  await settle();
  assert.deepEqual(requests.map((r) => r.method).filter(Boolean), ["initialize", "session/new", "session/prompt"]);
  assert.deepEqual(requests.find((r) => r.method === "session/new")?.params, { cwd: "/repo", mcpServers: [] });
  assert.deepEqual(requests.find((r) => r.method === "session/prompt")?.params, {
    sessionId: "ses_new1",
    prompt: [{ type: "text", text: "early message" }, { type: "resource_link", uri: "file:///tmp/shot%20one.png", name: "shot.png" }],
  });
  assert.ok(events.some((e) => e.kind === "session" && e.sessionId === "ses_new1"));
  const caps = events.find((e) => e.kind === "capabilities");
  assert.ok(caps && caps.kind === "capabilities");
  assert.deepEqual(caps.models.map((m) => [m.id, m.short, m.efforts]), [["opencode/big-pickle", "Big Pickle", ["low", "high"]], ["anthropic/claude-opus", "Claude Opus", ["low", "high"]]]);
  assert.deepEqual(caps.modes.map((m) => m.id), ["build", "plan"]);
  assert.deepEqual(events.find((e) => e.kind === "settings"), { kind: "settings", settings: { model: "opencode/big-pickle", effort: null, mode: "build" } });
  assert.ok(events.some((e) => e.kind === "turn_ended" && e.outcome === "success"));
});

test("OpenCode streams its thinking, reply and tool calls into the chat; a change of model, effort or mode is set on the session", async () => {
  const { child, events, engine, started } = setup("opencode");
  const server = openCodeServer(child, { holdPrompt: true });
  await started;
  await settle();
  engine.send("t1", "run it");
  await settle();
  const update = (u: object) => child.print({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "ses_new1", update: u } });
  update({ sessionUpdate: "agent_thought_chunk", messageId: "m1:reasoning:0", content: { type: "text", text: "Let me run it." } });
  update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "shell", title: "shell", kind: "execute", status: "pending", rawInput: { cwd: "/repo" } });
  update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", kind: "execute", title: "echo hi", rawInput: { command: "echo hi", cwd: "/repo" } });
  update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
  update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Ran " } });
  update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "it." } });
  update({ sessionUpdate: "usage_update", used: 9000, size: 1000000 });
  server.release();
  await settle();
  const reply = engine.snapshot("t1");
  const t = (await import("../shared/chat-transcript")).replayChat(reply);
  const last = t.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.ok(last.role === "assistant");
  assert.deepEqual(
    last.parts.map((p) => (p.type === "tool" ? ["tool", p.name, (p.input as { command?: string }).command, p.output, p.status] : [p.type, p.text])),
    [["thinking", "Let me run it."], ["tool", "Shell", "echo hi", "hi", "done"], ["text", "Ran it."]],
  );
  assert.deepEqual(t.context, { used: 9000, window: 1000000 });
  assert.equal(t.running, false);

  engine.configure("t1", { model: "anthropic/claude-opus", effort: "high", mode: "plan" });
  await settle();
  const sets = server.requests.filter((r) => r.method === "session/set_config_option").map((r) => [r.params!.configId, r.params!.value]);
  assert.deepEqual(sets, [["model", "anthropic/claude-opus"], ["effort", "high"], ["mode", "plan"]]);
  assert.deepEqual(events.filter((e) => e.kind === "settings").at(-1), { kind: "settings", settings: { model: "anthropic/claude-opus", effort: "high", mode: "plan" } });
});

test("OpenCode: a message sent mid-turn waits for the turn; Stop cancels the session's turn and the asks it had open", async () => {
  const { child, events, engine, started } = setup("opencode");
  const server = openCodeServer(child, { holdPrompt: true });
  await started;
  await settle();
  engine.send("t1", "first");
  await settle();
  engine.send("t1", "second");
  await settle();
  const prompts = () => server.requests.filter((r) => r.method === "session/prompt").map((r) => r.params!.prompt[0].text);
  assert.deepEqual(prompts(), ["first"]);
  server.release();
  await settle();
  assert.deepEqual(prompts(), ["first", "second"]);

  // An ask while the second runs, then Stop.
  child.print({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { sessionId: "ses_new1", toolCall: { toolCallId: "c9", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } });
  await settle();
  const ask = events.find((e) => e.kind === "approval_request");
  assert.deepEqual(ask, { kind: "approval_request", requestId: "acp-77", toolName: "Shell", input: { command: "rm -rf build" }, toolCallId: "c9" });
  engine.interrupt("t1");
  await settle();
  assert.ok(server.requests.some((r) => r.method === "session/cancel" && r.params!.sessionId === "ses_new1"));
  assert.deepEqual(server.requests.find((r) => r.id === 77)?.result, { outcome: { outcome: "cancelled" } });
  assert.ok(events.some((e) => e.kind === "approval_settled" && e.requestId === "acp-77"));
});

test("OpenCode: an ask is answered with the option the person picked", async () => {
  const { child, engine, started } = setup("opencode");
  const server = openCodeServer(child);
  await started;
  await settle();
  const options = [{ optionId: "o1", kind: "allow_once" }, { optionId: "o2", kind: "allow_always" }, { optionId: "o3", kind: "reject_once" }];
  for (const [id, decision] of [[1, "allow_once"], [2, "allow_always"], [3, "deny"]] as const) {
    child.print({ jsonrpc: "2.0", id: `p${id}`, method: "session/request_permission", params: { sessionId: "ses_new1", toolCall: { toolCallId: `c${id}`, kind: "edit", rawInput: { filePath: "/repo/a.ts" } }, options } });
    await settle(3);
    engine.answer("t1", `acp-p${id}`, decision);
  }
  await settle();
  assert.deepEqual(
    server.requests.filter((r) => typeof r.id === "string").map((r) => [r.id, r.result.outcome.optionId]),
    [["p1", "o1"], ["p2", "o2"], ["p3", "o3"]],
  );
});

test("OpenCode: a session it has is loaded, and its replay becomes the chat's history, not new messages", async () => {
  const replay = [
    { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "Run echo hi" } },
    { sessionUpdate: "agent_thought_chunk", messageId: "m1:reasoning:0", content: { type: "text", text: "Running." } },
    { sessionUpdate: "tool_call", toolCallId: "c1", name: "shell", title: "echo hi", kind: "execute", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] },
    { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "done" } },
    { sessionUpdate: "user_message_chunk", messageId: "u2", content: { type: "text", text: "Thanks" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m3", content: { type: "text", text: "Any time." } },
  ];
  let read = false;
  const { child, engine, started } = setup("opencode", "ses_old", async () => {
    read = true;
    return null;
  });
  const { requests } = openCodeServer(child, { replay });
  await started;
  await settle();
  assert.equal(read, false);
  assert.deepEqual(requests.find((r) => r.method === "session/load")?.params, { sessionId: "ses_old", cwd: "/repo", mcpServers: [] });
  const { replayChat } = await import("../shared/chat-transcript");
  const t = replayChat(engine.snapshot("t1"));
  assert.deepEqual(
    t.messages.map((m) => (m.role === "user" ? ["user", m.text] : [m.role, m.role === "assistant" ? m.parts.map((p) => p.type).join("+") : ""])),
    [["user", "Run echo hi"], ["assistant", "thinking+tool+text"], ["user", "Thanks"], ["assistant", "text"]],
  );
  assert.equal(t.running, false);
  assert.equal(t.sessionId, "ses_old");
});

test("OpenCode stopped by Tacit leaves without a failure; exiting on its own still says why", async () => {
  const stopped = setup("opencode");
  openCodeServer(stopped.child);
  await stopped.started;
  await settle();
  stopped.engine.stop("t1");
  stopped.child.emit("exit", 130);
  assert.deepEqual(stopped.events.at(-1), { kind: "exited", code: null });

  const crashed = setup("opencode");
  openCodeServer(crashed.child);
  await crashed.started;
  await settle();
  crashed.child.stderr.write("boom\n");
  await settle(3);
  crashed.child.emit("exit", 1);
  assert.deepEqual(crashed.events.at(-1), { kind: "exited", code: 1, error: "boom" });
});
