import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCurrentAgentType,
  resolveDefaultAgentType,
  resolveWorkerAgentType,
} from "../src/agent-selection.ts";

test("resolveCurrentAgentType ignores non-Hydra terminal types", () => {
  assert.equal(
    resolveCurrentAgentType({ TACIT_TERMINAL_TYPE: "shell" }),
    undefined,
  );
  assert.equal(
    resolveCurrentAgentType({ TACIT_TERMINAL_TYPE: "codex" }),
    "codex",
  );
});

test("resolveDefaultAgentType inherits the current terminal type before falling back", () => {
  assert.equal(
    resolveDefaultAgentType({ TACIT_TERMINAL_TYPE: "claude" }),
    "claude",
  );
  assert.equal(resolveDefaultAgentType({}), "claude");
});

test("resolveWorkerAgentType inherits the current terminal type when unset", () => {
  assert.equal(
    resolveWorkerAgentType({}, { TACIT_TERMINAL_TYPE: "gemini" }),
    "gemini",
  );
  assert.equal(resolveWorkerAgentType({}, {}), "claude");
});
