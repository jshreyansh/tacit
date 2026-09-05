import test from "node:test";
import assert from "node:assert/strict";

import { isFailedToolResult } from "../shared/sessions";
import { toolVerb } from "../src/components/transcriptModel";

/**
 * The two pure pieces behind the tool tags: what a tag is called, and whether
 * it is painted red.
 *
 * Both matter more for a workspace manager than for an ordinary terminal —
 * its interesting calls are all MCP canvas tools, which are exactly the ones
 * that arrive with an unreadable machine prefix.
 */

test("built-in tool names pass through untouched", () => {
  assert.equal(toolVerb("Read"), "Read");
  assert.equal(toolVerb("Bash"), "Bash");
  assert.equal(toolVerb("ToolSearch"), "ToolSearch");
  assert.equal(toolVerb("apply_patch"), "apply_patch");
});

test("MCP tools lose the server prefix", () => {
  assert.equal(toolVerb("mcp__tacit-bridge__spawn_browser"), "spawn_browser");
  assert.equal(toolVerb("mcp__tacit-bridge__connect_nodes"), "connect_nodes");
  // The bridge's former name, which appears 53 times in this machine's history.
  assert.equal(toolVerb("mcp__browser-bridge__browser_eval"), "browser_eval");
  assert.equal(
    toolVerb("mcp__claude-in-chrome__tabs_context_mcp"),
    "tabs_context_mcp",
  );
});

test("a missing tool name still renders something", () => {
  assert.equal(toolVerb(undefined), "Tool");
});

test("an underscore-heavy tool name keeps everything after the server", () => {
  assert.equal(toolVerb("mcp__a__b__c"), "b__c");
});

test("an explicit error flag wins", () => {
  assert.equal(isFailedToolResult({ explicitError: true, text: "fine" }), true);
});

test("an HTTP-shaped failure code counts", () => {
  assert.equal(isFailedToolResult({ statusCode: 500 }), true);
  assert.equal(isFailedToolResult({ statusCode: 404 }), true);
  assert.equal(isFailedToolResult({ statusCode: 200 }), false);
});

test("failure words in the result text count", () => {
  assert.equal(isFailedToolResult({ text: "Error: page did not load" }), true);
  assert.equal(isFailedToolResult({ text: "request timed out" }), true);
  assert.equal(isFailedToolResult({ text: "Exception in handler" }), true);
});

// The singular-only pattern missed this: "errors" has no word boundary after
// "error", so a result reporting several of them read as a success.
test("plural failure words count too", () => {
  assert.equal(isFailedToolResult({ text: "found 3 errors" }), true);
  assert.equal(isFailedToolResult({ text: "2 failures during apply" }), true);
  assert.equal(isFailedToolResult({ text: "hit two timeouts" }), true);
});

test("ordinary output is not a failure", () => {
  assert.equal(isFailedToolResult({ text: "Opened 8 browsers" }), false);
  assert.equal(isFailedToolResult({ text: "" }), false);
  assert.equal(isFailedToolResult({}), false);
});

// The text check is the loosest signal and deliberately last. A false positive
// paints one tag red; a false negative hides the thing the reader most needed.
// This records that we accept the former to avoid the latter.
test("the text check is knowingly eager", () => {
  assert.equal(
    isFailedToolResult({ text: "no errors found in the log" }),
    true,
    "a sentence merely mentioning errors reads as a failure — accepted trade",
  );
});
