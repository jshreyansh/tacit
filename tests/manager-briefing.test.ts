import test from "node:test";
import assert from "node:assert/strict";

import { listBridgeTools } from "../tacit-bridge/src/list-tools.ts";
import {
  WORKSPACE_MANAGER_BRIEFING,
  WORKSPACE_MANAGER_CATCH_UP,
  isWorkspaceManagerBriefing,
  workspaceManagerBriefing,
} from "../shared/manager-role.ts";

/**
 * The briefing is typed into a new manager's terminal, so a tool it names that
 * no longer exists sends the manager looking for something it can't call.
 * Tool names are the snake_case words; nothing else in the briefing is.
 */
test("every tool the manager briefing names is one the bridge serves", async () => {
  const served = new Set((await listBridgeTools()).map((tool) => tool.name));
  const named = [...new Set(workspaceManagerBriefing(true).match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  assert.ok(named.length > 0, "the briefing should name the tools it gives instructions about");
  assert.deepEqual(named.filter((name) => !served.has(name)), []);
});

test("the briefing points the manager at single-worker delivery", () => {
  assert.match(WORKSPACE_MANAGER_BRIEFING, /send_prompt_to_node/);
  assert.match(WORKSPACE_MANAGER_BRIEFING, /emit_event/);
});

test("a manager taking over a busy workdesk is asked to catch the user up first", () => {
  assert.equal(workspaceManagerBriefing(false), WORKSPACE_MANAGER_BRIEFING);
  const late = workspaceManagerBriefing(true);
  assert.ok(late.startsWith(WORKSPACE_MANAGER_BRIEFING));
  assert.ok(late.endsWith(WORKSPACE_MANAGER_CATCH_UP));
  assert.match(WORKSPACE_MANAGER_CATCH_UP, /what you'd do next/);
  // Still recognised, so the chat shows it as the handover line.
  assert.ok(isWorkspaceManagerBriefing(late));
});
