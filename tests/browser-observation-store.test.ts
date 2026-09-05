import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserObservationStore } from "../electron/browser-observation-store";

function scratch(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-observation-test-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const visit = (url: string) => ({
  type: "page_text" as const,
  url,
  title: "t",
  // Distinct per URL so the store's near-duplicate guard is not what is under
  // test here.
  text: `visible text for ${url}`,
  truncated: false,
  at: Date.now(),
});

test("a summary describes what was recorded without opening the pages", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    store.record("identity-a", visit("https://example.com/one"));
    store.record("identity-a", visit("https://example.com/two"));
    store.record("identity-b", visit("https://example.com/three"));

    const summary = store.summary();
    assert.equal(summary.totalEntries, 3);
    assert.equal(summary.profiles.length, 2);
    const byId = Object.fromEntries(summary.profiles.map((p) => [p.profileId, p.entries]));
    assert.deepEqual(byId, { "identity-a": 2, "identity-b": 1 });
    assert.equal(summary.totalBytes > 0, true);
  } finally {
    cleanup();
  }
});

test("a directory that has never been written to summarises as empty, not as an error", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: path.join(root, "never") });
    assert.deepEqual(store.summary(), { profiles: [], totalEntries: 0, totalBytes: 0 });
  } finally {
    cleanup();
  }
});

test("clearing one profile leaves the others intact", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    store.record("identity-a", visit("https://example.com/one"));
    store.record("identity-b", visit("https://example.com/two"));

    assert.deepEqual(store.clear("identity-a"), { cleared: 1 });

    const summary = store.summary();
    assert.deepEqual(summary.profiles.map((p) => p.profileId), ["identity-b"]);
  } finally {
    cleanup();
  }
});

test("clearing everything leaves nothing on disk", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    store.record("identity-a", visit("https://example.com/one"));
    store.record("identity-b", visit("https://example.com/two"));

    assert.deepEqual(store.clear(), { cleared: 2 });
    assert.deepEqual(store.summary(), { profiles: [], totalEntries: 0, totalBytes: 0 });
  } finally {
    cleanup();
  }
});

test("clearing a profile that recorded nothing is not an error", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    assert.deepEqual(store.clear("identity-never"), { cleared: 0 });
  } finally {
    cleanup();
  }
});

test("recording resumes after an erase rather than being suppressed as a repeat", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    const page = {
      type: "page_text" as const,
      url: "https://example.com/",
      title: "t",
      text: "the same page text, recorded twice around an erase",
      truncated: false,
      at: Date.now(),
    };
    assert.equal(store.record("identity-a", page).written, true);
    store.clear("identity-a");

    // The duplicate guard lives in memory. Left standing across an erase it
    // would silently drop the first observation after one, so the user who
    // asked for a clean slate would get a stream that starts by losing a page.
    assert.equal(store.record("identity-a", page).written, true);
    assert.equal(store.summary().totalEntries, 1);
  } finally {
    cleanup();
  }
});

test("a profile id that is not one of ours cannot name a file to read or delete", () => {
  const { root, cleanup } = scratch();
  try {
    const store = new BrowserObservationStore({ rootDir: root });
    for (const hostile of ["../escape", "a/b", "..", "", "A".repeat(200), "Identity-Caps"]) {
      assert.throws(() => store.fileFor(hostile), /Refused/, hostile);
      assert.throws(() => store.clear(hostile), /Refused/, hostile);
    }
  } finally {
    cleanup();
  }
});
