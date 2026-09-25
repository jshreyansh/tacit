import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKSPACE_MANAGER_BRIEFING,
  isWorkspaceManagerBriefing,
} from "../shared/manager-role.ts";

/*
 * The handover briefing is delivered by typing into the agent's terminal — the
 * only way to talk to a CLI — so the transcript records it as `role: user`.
 * Rendered naively, the Project Chat shows that wall of setup text as a message
 * from the person reading it, who never wrote it. These pin the recognition
 * that keeps it out of the user stream and turns it into a handover marker.
 */

test("the briefing is recognised from a transcript line", () => {
  assert.equal(isWorkspaceManagerBriefing(WORKSPACE_MANAGER_BRIEFING), true);
});

test("a truncated preview of the briefing is still recognised", () => {
  // Transcripts may hold a preview rather than a whole turn, and the tail of
  // the briefing changes whenever the tool list does — so the match is on the
  // opening sentence, not the full string.
  assert.equal(
    isWorkspaceManagerBriefing(WORKSPACE_MANAGER_BRIEFING.slice(0, 90)),
    true,
  );
});

test("leading whitespace does not hide the briefing", () => {
  assert.equal(
    isWorkspaceManagerBriefing(`\n  ${WORKSPACE_MANAGER_BRIEFING}`),
    true,
  );
});

test("something the user actually wrote is not mistaken for the briefing", () => {
  assert.equal(isWorkspaceManagerBriefing("Who is blocked?"), false);
  assert.equal(
    isWorkspaceManagerBriefing("remind me what the workspace manager role does"),
    false,
  );
  assert.equal(isWorkspaceManagerBriefing(null), false);
  assert.equal(isWorkspaceManagerBriefing(undefined), false);
});
