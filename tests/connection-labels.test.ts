import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ENDPOINT_LABEL_LENGTH,
  describeEndpoint,
  truncateLabel,
  type EndpointLabelContext,
} from "../src/canvas/connectionLabels";
import type { BrowserCardData } from "../src/stores/browserCardStore";
import type { Pin, ProjectData, TerminalData } from "../src/types";

const STRINGS = {
  workspaceManager: "the workspace manager",
  unknownTerminal: "a terminal that no longer exists",
  unknownBrowser: "a browser that no longer exists",
  unknownNote: "a note that no longer exists",
};

function terminal(over: Partial<TerminalData> & { id: string }): TerminalData {
  return {
    title: "claude",
    type: "claude",
    minimized: false,
    focused: false,
    ptyId: null,
    status: "idle",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    ...over,
  } as TerminalData;
}

function projects(terminals: TerminalData[], worktreeName = "main"): ProjectData[] {
  return [
    {
      id: "proj-1",
      name: "tacit",
      path: "/Users/x/tacit",
      worktrees: [
        {
          id: "wt-1",
          name: worktreeName,
          path: "/Users/x/tacit",
          isPrimary: true,
          terminals,
        },
      ],
    } as ProjectData,
  ];
}

function card(over: Partial<BrowserCardData> & { id: string }): BrowserCardData {
  return {
    url: "https://example.com/page",
    title: "",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    identityId: "identity-default",
    ...over,
  };
}

function context(over: Partial<EndpointLabelContext> = {}): EndpointLabelContext {
  return {
    projects: [],
    browserCards: {},
    pins: [],
    workspaceManagerTerminalId: null,
    strings: STRINGS,
    ...over,
  };
}

test("workspace manager terminal is named as such, not by its CLI", () => {
  const ctx = context({
    projects: projects([terminal({ id: "t1" })]),
    workspaceManagerTerminalId: "t1",
  });
  assert.equal(
    describeEndpoint({ kind: "terminal", id: "t1" }, ctx),
    "the workspace manager",
  );
});

test("an unrenamed terminal is qualified by its worktree", () => {
  const ctx = context({ projects: projects([terminal({ id: "t2" })]) });
  assert.equal(
    describeEndpoint({ kind: "terminal", id: "t2" }, ctx),
    "claude · main",
  );
});

test("a renamed terminal uses its own name with no worktree suffix", () => {
  const ctx = context({
    projects: projects([terminal({ id: "t3", customTitle: "reviewer" })]),
  });
  assert.equal(describeEndpoint({ kind: "terminal", id: "t3" }, ctx), "reviewer");
});

test("browser prefers its page title", () => {
  const ctx = context({
    browserCards: { b1: card({ id: "b1", title: "Element: wheel event" }) },
  });
  assert.equal(
    describeEndpoint({ kind: "browser", id: "b1" }, ctx),
    "Element: wheel event",
  );
});

test("browser falls back to hostname without www when untitled", () => {
  const ctx = context({
    browserCards: {
      b2: card({ id: "b2", title: "  ", url: "https://www.mozilla.org/en/docs" }),
    },
  });
  assert.equal(describeEndpoint({ kind: "browser", id: "b2" }, ctx), "mozilla.org");
});

test("browser with an unparseable url falls back to the unknown string", () => {
  const ctx = context({
    browserCards: { b3: card({ id: "b3", title: "", url: "about:blank" }) },
  });
  assert.equal(
    describeEndpoint({ kind: "browser", id: "b3" }, ctx),
    STRINGS.unknownBrowser,
  );
});

test("note uses its pin title", () => {
  const ctx = context({
    pins: [{ id: "p1", title: "drawer jitters on resize" } as Pin],
  });
  assert.equal(
    describeEndpoint({ kind: "note", id: "p1" }, ctx),
    "drawer jitters on resize",
  );
});

test("a long page title is elided so the sentence stays readable", () => {
  const long = "Element: wheel event - Web APIs | MDN Web Docs Reference";
  const ctx = context({ browserCards: { b4: card({ id: "b4", title: long }) } });
  const label = describeEndpoint({ kind: "browser", id: "b4" }, ctx);
  assert.ok(label.length <= MAX_ENDPOINT_LABEL_LENGTH, label);
  assert.ok(label.endsWith("…"), label);
});

test("titles spanning lines collapse to one line", () => {
  assert.equal(truncateLabel("two\n  lines   here"), "two lines here");
});

// A wire can outlive the node on one end — the codex terminal that failed to
// launch left exactly this behind in a real save. The dialog must still be
// able to describe what it is about to remove.
test("endpoints whose node is gone still get a description", () => {
  const ctx = context();
  assert.equal(
    describeEndpoint({ kind: "terminal", id: "missing" }, ctx),
    STRINGS.unknownTerminal,
  );
  assert.equal(
    describeEndpoint({ kind: "browser", id: "missing" }, ctx),
    STRINGS.unknownBrowser,
  );
  assert.equal(
    describeEndpoint({ kind: "note", id: "missing" }, ctx),
    STRINGS.unknownNote,
  );
});
