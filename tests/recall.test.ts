import test from "node:test";
import assert from "node:assert/strict";

import { recall, tokenize, type RecallDoc } from "../shared/recall";

/**
 * Retrieval over the decision record.
 *
 * The behaviour worth protecting is that filters are gates, not scores: asking
 * about one browser must never return a strongly-worded entry about a
 * different one. Confidently returning the wrong thing is worse than returning
 * nothing.
 */

let seq = 0;
function doc(over: Partial<RecallDoc> & { text: string }): RecallDoc {
  seq += 1;
  return {
    id: `d${seq}`,
    at: "2026-08-17T06:00:00.000Z",
    kind: "prompt",
    origin: "record",
    nodes: [],
    summary: over.text,
    ...over,
  };
}

const NOW = new Date("2026-08-17T12:00:00.000Z").getTime();

test("tokenizing drops filler but keeps identifiers", () => {
  assert.deepEqual(tokenize("Can you open the browser"), ["open", "browser"]);
  assert.ok(tokenize("browser:browser-178-4").includes("browser-178-4"));
});

test("a query returns the entries that mention its words", () => {
  const docs = [
    doc({ text: "open the remotion studio in a browser" }),
    doc({ text: "post it to instagram" }),
  ];
  const hits = recall(docs, { text: "remotion browser" }, NOW);
  assert.equal(hits.length, 1);
  assert.match(hits[0].doc.text, /remotion/);
});

test("results say why they matched", () => {
  const hits = recall([doc({ text: "post it to instagram" })], { text: "instagram" }, NOW);
  assert.match(hits[0].why.join(" "), /instagram/);
});

// The failure this prevents: a vividly-worded entry about a different node
// outranking the node you actually asked about.
test("a node filter excludes other nodes no matter how well they read", () => {
  const docs = [
    doc({
      text: "opened browser:b-1 — the remotion studio, verified rendering",
      nodes: ["browser:b-1"],
      kind: "spawn",
    }),
    doc({ text: "closed browser:b-2", nodes: ["browser:b-2"], kind: "close" }),
  ];
  const hits = recall(docs, { node: "browser:b-2" }, NOW);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].doc.nodes, ["browser:b-2"]);
});

test("a kind filter is a gate too", () => {
  const docs = [
    doc({ text: "open a browser please", kind: "prompt" }),
    doc({ text: "opened browser:b-1", kind: "spawn", nodes: ["browser:b-1"] }),
  ];
  const hits = recall(docs, { text: "browser", kinds: ["spawn"] }, NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].doc.kind, "spawn");
});

// This is the whole point of separating authorship: the digest and every
// search must show what a person said, not what the software injected.
test("injected text is excluded unless explicitly asked for", () => {
  const docs = [
    doc({ text: "post it to instagram" }),
    doc({ text: "A browser on the canvas is wired to this terminal", source: "app" }),
    doc({ text: "<task-notification> instagram job done", source: "harness" }),
  ];
  assert.equal(recall(docs, { text: "instagram" }, NOW).length, 1);
  assert.equal(
    recall(docs, { text: "instagram", includeInjected: true }, NOW).length,
    2,
  );
});

test("no query text lists the most recent matches instead of nothing", () => {
  const docs = [
    doc({ at: "2026-08-17T06:00:00.000Z", text: "older" }),
    doc({ at: "2026-08-17T09:00:00.000Z", text: "newer" }),
  ];
  const hits = recall(docs, {}, NOW);
  assert.equal(hits[0].doc.text, "newer");
  assert.equal(hits.length, 2);
});

test("a time bound narrows the window", () => {
  const docs = [
    doc({ at: "2026-08-16T06:00:00.000Z", text: "yesterday instagram" }),
    doc({ at: "2026-08-17T09:00:00.000Z", text: "today instagram" }),
  ];
  const hits = recall(docs, { text: "instagram", since: "2026-08-17T00:00:00.000Z" }, NOW);
  assert.equal(hits.length, 1);
  assert.match(hits[0].doc.text, /today/);
});

// Recency is a tiebreak, not the ranking. An old entry that says exactly the
// right thing should still beat a recent one that barely mentions it.
test("a precise old match outranks a vague recent one", () => {
  const docs = [
    doc({
      at: "2026-08-10T06:00:00.000Z",
      text: "instagram carousel publishing pipeline via the webhook",
    }),
    doc({
      at: "2026-08-17T11:00:00.000Z",
      text: "the pipeline is fine and everything else here is unrelated filler text",
    }),
  ];
  const hits = recall(docs, { text: "instagram carousel webhook" }, NOW);
  assert.match(hits[0].doc.text, /carousel/);
});

test("the limit is honoured", () => {
  const docs = Array.from({ length: 30 }, (_, i) =>
    doc({ text: `instagram post number ${i}` }),
  );
  assert.equal(recall(docs, { text: "instagram", limit: 5 }, NOW).length, 5);
});

test("a query matching nothing returns nothing rather than everything", () => {
  const hits = recall([doc({ text: "post it to instagram" })], { text: "kubernetes" }, NOW);
  assert.equal(hits.length, 0);
});
