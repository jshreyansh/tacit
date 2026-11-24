import test from "node:test";
import assert from "node:assert/strict";
import { TaskEvidence, commandFrom, shellWrites, testCommandIn } from "../electron/task-evidence.ts";

test("a test run counts only when its own exit is the tests' exit", () => {
  for (const c of ["npm test", "pnpm test", "npm run test:unit", "npm t", "yarn test --ci", "bun test", "npx vitest run", "pnpm exec jest", "pytest -q", "python -m pytest tests", "uv run pytest", "go test ./...", "cargo test", "cargo nextest run && cargo test", "node --test tests/", "npx tsx --test tests/a.test.ts", "cd app && npm test", "CI=1 npm test", "swift test", "./gradlew test", "make test", "npm test 2>&1", "npm test > out.log", "npm run build && npm test"]) assert.ok(testCommandIn(c), c);
  for (const c of ["npm test | tail -5", "npm test || true", "npm test; echo done", "npm test &", "echo $(npm test)", "npm run build", "cat tests/a.test.ts", "git commit -m 'npm test'", "echo npm test", "npm test --help", "jest --listTests", "vitest --watch", "npm install jest", "grep -r pytest .", "ls\nnpm test", "npm run testing-tools", "", 5, null]) assert.equal(testCommandIn(c), null, String(c));
});

test("how a command ended comes from its hook, and isn't guessed", () => {
  const ev = (over: object) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", stderr: "" }, ...over });
  assert.deepEqual(commandFrom(ev({})), { command: "npm test", ok: true });
  assert.deepEqual(commandFrom(ev({ hook_event_name: "PostToolUseFailure", tool_response: undefined })), { command: "npm test", ok: false });
  assert.deepEqual(commandFrom(ev({ tool_response: { exit_code: 1 } })), { command: "npm test", ok: false });
  assert.deepEqual(commandFrom(ev({ tool_name: "exec_command", tool_input: { cmd: ["bash", "-lc", "npm test"] }, tool_response: "Process exited with code 0" })), { command: "npm test", ok: true });
  for (const over of [{ tool_input: { command: "npm test", run_in_background: true } }, { tool_response: { stdout: "", interrupted: true } }, { tool_response: { stdout: "", backgroundTaskId: "x" } }, { tool_response: "it went fine" }, { tool_response: undefined }, { tool_name: "Read" }, { hook_event_name: "PreToolUse" }, { hook_event_name: "PostToolUseFailure", is_interrupt: true }]) assert.equal(commandFrom(ev(over)), null, JSON.stringify(over));
});

test("passed, then changed, isn't passed on what's there now", async () => {
  let changed: Array<{ path: string; kind: "modified" }> | null = [];
  const make = () =>
    new TaskEvidence({
      mark: async () => "c1",
      changedFrom: async () => changed,
      changedSince: async () => [{ path: "src/a.ts", kind: "modified" }],
      othersChangedSince: async () => false,
      now: () => 100,
    });
  const run = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "" } };
  const e = make();
  e.toolUsed("a", "/p", run);
  assert.deepEqual((await e.of("a", "/p", 50)).tests, { command: "npm test", passed: true, after: true });
  changed = [{ path: "src/a.ts", kind: "modified" }];
  assert.deepEqual((await e.of("a", "/p", 50)).tests, { command: "npm test", passed: true, after: false });
  changed = null;
  assert.equal((await e.of("a", "/p", 50)).tests, undefined, "can't tell");
  assert.equal((await e.of("a", "/p", 150)).tests, undefined, "run before this try");
  assert.equal((await e.of("a", "/other", 50)).tests, undefined, "run somewhere else");
  assert.equal((await e.of("b", "/p", 50)).tests, undefined, "run by someone else");
  assert.deepEqual(await e.of("a", null, 50), { files: [], known: false, shared: false });
  e.toolUsed("a", "/p", { ...run, hook_event_name: "PostToolUseFailure" });
  assert.equal((await e.of("a", "/p", 50)).tests?.passed, false, "the last run is the one that counts");
});

test("another agent counts when it was seen editing here, not for being busy here", async () => {
  let asked: ReadonlySet<string> | null = null;
  const e = new TaskEvidence({ mark: async () => null, changedFrom: async () => null, changedSince: async () => [], othersChangedSince: async (_t, _d, _s, except) => ((asked = except), !except.has("manager")), now: () => 100 });
  const tool = (name: string) => ({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {} });
  e.toolUsed("manager", "/p", tool("mcp__tacit__wait_for_nodes"));
  assert.equal((await e.of("a", "/p", 50)).shared, false);
  assert.deepEqual([...asked!], ["manager"], "one that says what it does isn't judged by what changed around it");
  e.toolUsed("b", "/other", tool("Edit"));
  assert.equal((await e.of("a", "/p", 50)).shared, false, "somewhere else");
  e.toolUsed("b", "/p", tool("Edit"));
  assert.equal((await e.of("a", "/p", 50)).shared, true);
  assert.equal((await e.of("a", "/p", 150)).shared, false, "before this try");
  assert.equal((await e.of("b", "/p", 50)).shared, false, "its own edits");
});

test("a shell command that plainly writes files counts as editing; reading doesn't", () => {
  for (const c of ["sed -i '' 's/a/b/' greet.js", "cat > greet.js <<'E'\nx\nE", "echo hi >> notes.txt", "python3 - <<'E'\nopen('a.py','w').write('x')\nE", "git apply fix.patch", "cd app && rm old.js", "perl -pi -e 's/a/b/' x", "printf x | tee out.txt"]) assert.ok(shellWrites(c), c);
  for (const c of ["npm test", "npm test 2>&1", "ls > /dev/null", "cat greet.js", "git status", "grep -r 'x => y' src", "git diff HEAD~1", "node -e 'console.log(1 >= 0)'", "rg remove src", null]) assert.equal(shellWrites(c), false, String(c));
});
