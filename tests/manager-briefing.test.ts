import test from "node:test";
import assert from "node:assert/strict";

import { listBridgeTools } from "../tacit-bridge/src/list-tools.ts";
import { WORKSPACE_MANAGER_BRIEFING } from "../shared/manager-role.ts";

/**
 * The briefing is typed into a new manager's terminal, so a tool it names that
 * no longer exists sends the manager looking for something it can't call.
 * Tool names are the snake_case words; nothing else in the briefing is.
 */
test("every tool the manager briefing names is one the bridge serves", async () => {
  const served = new Set((await listBridgeTools()).map((tool) => tool.name));
  const named = [...new Set(WORKSPACE_MANAGER_BRIEFING.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  assert.ok(named.length > 0, "the briefing should name the tools it gives instructions about");
  assert.deepEqual(named.filter((name) => !served.has(name)), []);
});

test("the briefing points the manager at single-worker delivery", () => {
  assert.match(WORKSPACE_MANAGER_BRIEFING, /send_prompt_to_node/);
  assert.match(WORKSPACE_MANAGER_BRIEFING, /emit_event/);
});
