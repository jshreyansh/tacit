import test from "node:test";
import assert from "node:assert/strict";

import { bypassFlags, launchApproval } from "../src/terminal/agentApprovals.ts";
import { getTerminalLaunchOptions, hasBypassArgs } from "../src/terminal/cliConfig.ts";
import { answerAgentApproval, requestAgentApproval, useAgentApprovalStore } from "../src/stores/agentApprovalStore.ts";

test("a launch that asks to skip approvals waits for the project's answer, then follows it", () => {
  assert.equal(launchApproval(true, true, undefined), "needs-answer");
  assert.equal(launchApproval(true, true, "bypass"), "bypass");
  assert.equal(launchApproval(true, true, "ask"), "ask");
});

test("nothing is asked for a launch that didn't ask, or an agent without bypass flags", () => {
  assert.equal(launchApproval(false, true, undefined), "ask");
  assert.equal(launchApproval(false, true, "bypass"), "ask", "allowing a project never turns approvals off by itself");
  assert.equal(launchApproval(true, false, undefined), "ask");
});

test("only Claude and Codex have bypass flags", () => {
  assert.equal(hasBypassArgs("claude"), true);
  assert.equal(hasBypassArgs("codex"), true);
  assert.equal(hasBypassArgs("opencode"), false);
  assert.equal(hasBypassArgs("shell"), false);
});

test("the badge reads the flags from the actual launch arguments", () => {
  const flagsOf = (...args: Parameters<typeof getTerminalLaunchOptions>) => bypassFlags(getTerminalLaunchOptions(...args)?.args ?? []);
  assert.deepEqual(flagsOf("claude", undefined, true), ["--dangerously-skip-permissions"]);
  assert.deepEqual(flagsOf("codex", undefined, true), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(flagsOf("claude", undefined, false), []);
  assert.deepEqual(flagsOf("codex", "abc", false), [], "a resumed session asks unless it was started without approvals");
  assert.deepEqual(
    flagsOf("claude", undefined, false, { command: "claude", args: ["--permission-mode", "bypassPermissions"] }),
    ["--permission-mode bypassPermissions"],
    "the person's own command override counts too",
  );
  assert.deepEqual(flagsOf("codex", undefined, false, { command: "codex", args: ["--yolo"] }), ["--yolo"]);
  assert.deepEqual(
    flagsOf("claude", undefined, true, { command: "claude", args: ["--dangerously-skip-permissions"] }),
    ["--dangerously-skip-permissions"],
    "a flag added twice is listed once",
  );
});

test("one answer starts every agent waiting on that project, and only that project", async () => {
  const started: string[] = [];
  const a1 = requestAgentApproval("/repo-a", "repo-a").then((c) => started.push(`a1:${c}`));
  const a2 = requestAgentApproval("/repo-a", "repo-a").then((c) => started.push(`a2:${c}`));
  const b = requestAgentApproval("/repo-b", "repo-b").then((c) => started.push(`b:${c}`));
  assert.deepEqual(
    useAgentApprovalStore.getState().pending.map((p) => [p.projectPath, p.waiting]),
    [["/repo-a", 2], ["/repo-b", 1]],
  );

  answerAgentApproval("/repo-a", "bypass");
  await Promise.all([a1, a2]);
  assert.deepEqual(started.sort(), ["a1:bypass", "a2:bypass"]);
  assert.deepEqual(useAgentApprovalStore.getState().pending.map((p) => p.projectPath), ["/repo-b"]);

  answerAgentApproval("/repo-b", "ask");
  await b;
  assert.ok(started.includes("b:ask"));
  assert.deepEqual(useAgentApprovalStore.getState().pending, []);
});
