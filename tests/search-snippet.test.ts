import test from "node:test";
import assert from "node:assert/strict";

import { readableSessionSnippet } from "../src/components/SearchModal/sessionSnippet.ts";

test("a matched message shows its words, not the JSON around them", () => {
  assert.equal(
    readableSessionSnippet('[{"type":"text","text":"I created **X2** in the Tacit task list\\n(id x2)."}]'),
    "I created **X2** in the Tacit task list (id x2).",
  );
  assert.equal(readableSessionSnippet("plain words from a prompt"), "plain words from a prompt");
});

test("plumbing lines are left out of search results", () => {
  assert.equal(readableSessionSnippet('[{"tool_use_id":"toolu_1","type":"tool_result","content":"Exit code 1"}]'), null);
  assert.equal(readableSessionSnippet('[{"type":"text","text":"<system-reminder>\\nCodebase and user"}]'), null);
  assert.equal(readableSessionSnippet('[{"type":"text","text":"# Environment\\nYou have been invoked"}]'), null);
  assert.equal(readableSessionSnippet('[{"type":"text","text":"The following tools just became available"}]'), null);
});
