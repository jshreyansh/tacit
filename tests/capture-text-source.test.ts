import test from "node:test";
import assert from "node:assert/strict";

import { InjectedTextTracker, detectHarnessText } from "../shared/capture";

/**
 * Telling apart what the user typed from what the software typed for them.
 *
 * The first real session recorded 22 prompts, of which 11 were the app or the
 * CLI harness talking to itself — the prompt hook fires for any text entering
 * the input and cannot see the difference. A record that claims twice as many
 * instructions as were given is worse than no record, because it reads as
 * though it is telling you something.
 *
 * The strings below are taken verbatim from that session.
 */

test("a task notification is recognised as the harness", () => {
  assert.equal(
    detectHarnessText(
      "<task-notification> <task-id>bk0kz7nsk</task-id> <tool-use-id>toolu_01XA",
    ),
    true,
  );
});

test("other machine wrappers are recognised too", () => {
  assert.equal(detectHarnessText("<system-reminder>\nsomething\n"), true);
  assert.equal(detectHarnessText("<local-command-stdout>ok</local-command-stdout>"), true);
});

test("leading whitespace does not hide a wrapper", () => {
  assert.equal(detectHarnessText("\n  <task-notification>x"), true);
});

test("real instructions are never mistaken for the harness", () => {
  for (const text of [
    "ok can you open in the browser the remotion player",
    "run everythiugni seperately the crom will run on it own",
    "post it to instagram too",
    "why are you reloading in every some minutes ???",
    // A wrapper mentioned mid-sentence is someone talking ABOUT one.
    "what does <task-notification> even mean here",
  ]) {
    assert.equal(detectHarnessText(text), false, text);
  }
});

test("text the app injected is claimed once and attributed to the app", () => {
  const tracker = new InjectedTextTracker();
  const notice =
    "A browser on the canvas is wired to this terminal (showing: (54) Home / X).";

  tracker.note("t-1", notice);
  assert.equal(tracker.claim("t-1", notice), true);
});

// If it kept matching, a user who genuinely repeated the same words would have
// their own message filed as the app's.
test("the same text a second time is the user, not the app", () => {
  const tracker = new InjectedTextTracker();
  tracker.note("t-1", "hello");
  assert.equal(tracker.claim("t-1", "hello"), true);
  assert.equal(tracker.claim("t-1", "hello"), false);
});

test("an injection into one terminal does not claim another's text", () => {
  const tracker = new InjectedTextTracker();
  tracker.note("t-1", "shared wording");
  assert.equal(tracker.claim("t-2", "shared wording"), false);
  assert.equal(tracker.claim("t-1", "shared wording"), true);
});

test("surrounding whitespace does not break the match", () => {
  const tracker = new InjectedTextTracker();
  tracker.note("t-1", "  briefing text\n");
  assert.equal(tracker.claim("t-1", "briefing text"), true);
});

// The hook normally fires within milliseconds. A note left lying around for
// minutes would misfile a genuine later message that happened to match.
test("a stale injection expires rather than claiming a later message", () => {
  const tracker = new InjectedTextTracker(1000);
  tracker.note("t-1", "hello", 0);
  assert.equal(tracker.claim("t-1", "hello", 5000), false);
});

test("text that was never injected is never claimed", () => {
  const tracker = new InjectedTextTracker();
  assert.equal(tracker.claim("t-1", "something the user wrote"), false);
});
