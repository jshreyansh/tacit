import test from "node:test";
import assert from "node:assert/strict";

import {
  startAutoSaveScheduler,
  type AutoSaveClock,
} from "../src/stores/autoSaveScheduler.ts";
import { useWorkspaceStore } from "../src/stores/workspaceStore.ts";
import { useIdentityStore } from "../src/stores/identityStore.ts";
import type {
  BrowserProfileImportResult,
  ImportedBrowserIdentity,
} from "../shared/browser-profile-import.ts";

/**
 * Why this file exists.
 *
 * A live session looked like the workspace had stopped saving: a Chrome
 * profile import and a profile delete both appeared to happen, and
 * `state.json` was not written for minutes afterwards. The suspicion fell on
 * the autosave state machine — a same-millisecond `markDirty` burst that
 * never restarts the debounce, a cancelled timer, an off-by-one backstop.
 *
 * These tests drive the real stores through the real scheduler on an
 * injected clock. They show the machine does save under each of those
 * conditions, and that the one thing that does produce a long silence is an
 * import that never reached the store at all.
 */

// ------------------------------------------------------------------ clock

/** Deterministic stand-in for setTimeout/setInterval/Date.now. */
class FakeClock implements AutoSaveClock {
  time = 1_000_000;
  private nextId = 1;
  private timers = new Map<
    number,
    { at: number; fn: () => void; every: number | null }
  >();

  now = () => this.time;

  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn, every: null });
    return id;
  };

  clearTimeout = (handle: unknown) => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  setInterval = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn, every: ms });
    return id;
  };

  clearInterval = (handle: unknown) => this.clearTimeout(handle);

  /** Advance time, firing every timer that comes due, in due order. */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.time = timer.at;
      if (timer.every === null) this.timers.delete(dueId);
      else timer.at = timer.at + timer.every;
      timer.fn();
    }
    this.time = target;
  }
}

/**
 * The store stamps `lastDirtyAt`/`lastSavedAt` with Date.now(), so the clock
 * the scheduler reads and the clock the store writes have to be the same one
 * or the backstop's arithmetic is meaningless.
 */
function withFakeNow<T>(clock: FakeClock, body: () => T): T {
  const realNow = Date.now;
  Date.now = () => clock.time;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Stands in for the real `saveSnapshot` in App.tsx: it does NOT clear
 * `dirty`, it only stamps `lastSavedAt`. That asymmetry is deliberate in the
 * app, and the backstop's pending check depends on it.
 */
function fakeSaver() {
  const at: number[] = [];
  return {
    at,
    save: () => {
      at.push(Date.now());
      useWorkspaceStore.setState((state) => ({
        ...state,
        lastSavedAt: Date.now(),
      }));
    },
  };
}

function resetStores(clock: FakeClock) {
  withFakeNow(clock, () => {
    useIdentityStore
      .getState()
      .hydrate([{ id: "identity-default", name: "Guest", createdAt: 1 }], "identity-default");
    useWorkspaceStore.setState({
      dirty: false,
      lastDirtyAt: null,
      lastSavedAt: null,
    });
  });
}

function importedProfile(n: number): ImportedBrowserIdentity {
  return {
    id: `identity-0000000${n}-4c67-48d8-900c-dd8f4b0b88b${n}`,
    name: `Chrome ${n}`,
    createdAt: 1,
    provenance: {
      source: "chrome",
      sourceProfileId: `Profile ${n}`,
      sourceProfileName: `Chrome ${n}`,
      importedAt: 1,
      categories: {
        profileMetadata: { status: "imported", count: 1 },
        cookies: { status: "imported", count: 12 },
        siteStorage: { status: "unsupported", count: 0 },
        history: { status: "unsupported", count: 0 },
        bookmarks: { status: "unsupported", count: 0 },
        savedPasswords: { status: "unsupported", count: 0 },
        openTabs: { status: "unsupported", count: 0 },
        cacheAndWorkers: { status: "unsupported", count: 0 },
        protectedState: { status: "unsupported", count: 0 },
      },
    },
  };
}

/**
 * The rule IdentityManagerModal applies to a batch result
 * (src/components/IdentityManagerModal.tsx, `importChromeProfiles`): only a
 * completed result reaches the store.
 */
function applyImportBatch(results: BrowserProfileImportResult[]) {
  for (const result of results) {
    if (result.status === "completed") {
      useIdentityStore.getState().registerImportedIdentity(result.identity);
    }
  }
}

// ------------------------------------------------------------------ tests

test("a seven-profile import inside one millisecond still schedules one save", () => {
  // Hypothesis: `markDirty` stamps Date.now(), the batch lands in a single
  // millisecond, `lastDirtyAt !== prev.lastDirtyAt` is false for calls 2..7,
  // and no debounce ever starts. Calls 2..7 do indeed not restart the timer —
  // but the first call does, and one timer is all a debounce needs.
  const clock = new FakeClock();
  resetStores(clock);
  const saver = fakeSaver();
  const scheduler = startAutoSaveScheduler({
    source: useWorkspaceStore,
    save: saver.save,
    clock,
  });

  withFakeNow(clock, () => {
    for (let n = 1; n <= 7; n += 1) {
      useIdentityStore.getState().registerImportedIdentity(importedProfile(n));
    }
  });

  const identities = useIdentityStore.getState().identities;
  assert.equal(Object.keys(identities).length, 8, "7 imports plus the built-in");
  assert.equal(useWorkspaceStore.getState().dirty, true);
  assert.equal(saver.at.length, 0, "nothing saved before the debounce elapses");

  withFakeNow(clock, () => clock.advance(5000));
  assert.equal(saver.at.length, 1, "one write for the whole batch");

  withFakeNow(clock, () => clock.advance(600_000));
  assert.equal(saver.at.length, 1, "and no repeat writes once it is saved");
  scheduler.stop();
});

test("the 60s backstop saves through a debounce that is never allowed to fire", () => {
  // Hypothesis: a store marking dirty faster than the 5s debounce window
  // restarts the timer forever. It does — and this is what the backstop is
  // for. Four minutes of edits every four seconds must not be four minutes
  // of silence.
  const clock = new FakeClock();
  resetStores(clock);
  const saver = fakeSaver();
  const scheduler = startAutoSaveScheduler({
    source: useWorkspaceStore,
    save: saver.save,
    clock,
  });

  withFakeNow(clock, () => {
    for (let tick = 0; tick < 60; tick += 1) {
      useWorkspaceStore.getState().markDirty();
      clock.advance(4000);
    }
  });

  // Four minutes of continuous edits, a one-minute backstop: four writes.
  // Before the `>=` fix in shouldRunAutoSaveBackstop this was two, because
  // the tick that landed exactly 60_000ms after the last save was rejected
  // for being zero milliseconds too early.
  assert.equal(
    saver.at.length,
    4,
    `expected a write each minute of the four, got ${saver.at.length}`,
  );
  const gaps = saver.at.slice(1).map((at, i) => at - saver.at[i]);
  for (const gap of gaps) {
    assert.ok(gap <= 60_000, `backstop gap of ${gap}ms is longer than a minute`);
  }
  scheduler.stop();
});

test("only markClean cancels a pending save; a save leaves the workspace dirty", () => {
  // Hypothesis: something sets `dirty: false` and swallows the pending write.
  // Only `markClean` does, and it is reached only by loading/opening a
  // workspace — where the pending state is being replaced wholesale anyway.
  const clock = new FakeClock();
  resetStores(clock);
  const saver = fakeSaver();
  const scheduler = startAutoSaveScheduler({
    source: useWorkspaceStore,
    save: saver.save,
    clock,
  });

  withFakeNow(clock, () => {
    useWorkspaceStore.getState().markDirty();
    clock.advance(5000);
  });
  assert.equal(saver.at.length, 1);
  assert.equal(
    useWorkspaceStore.getState().dirty,
    true,
    "a save stamps lastSavedAt and deliberately leaves dirty set",
  );

  withFakeNow(clock, () => {
    useWorkspaceStore.getState().markDirty();
    clock.advance(1000);
    useWorkspaceStore.getState().markClean();
    clock.advance(10_000);
  });
  assert.equal(saver.at.length, 1, "markClean withdraws the pending save");
  scheduler.stop();
});

test("deleting a profile schedules a save like any other edit", () => {
  const clock = new FakeClock();
  resetStores(clock);
  withFakeNow(clock, () => {
    useIdentityStore.getState().registerImportedIdentity(importedProfile(1));
    useWorkspaceStore.setState({ dirty: false, lastDirtyAt: null, lastSavedAt: null });
  });

  const saver = fakeSaver();
  const scheduler = startAutoSaveScheduler({
    source: useWorkspaceStore,
    save: saver.save,
    clock,
  });

  withFakeNow(clock, () => {
    useIdentityStore.getState().deleteIdentity(importedProfile(1).id);
    clock.advance(5000);
  });

  assert.equal(Object.keys(useIdentityStore.getState().identities).length, 1);
  assert.equal(saver.at.length, 1);
  scheduler.stop();
});

test("an import whose profiles all failed writes nothing, and that is correct", () => {
  // This is the shape of the reported incident. A failed import still
  // materialises its partition directory on disk (electron/browser-profile-
  // import.ts creates the session before the cookie import can throw, and the
  // rollback clears the partition's data without removing the directory), so
  // "the partition exists" is not evidence that an identity was registered.
  // Nothing reaches the store, nothing marks the workspace dirty, and the
  // absence of a write is the honest result — not a lost one.
  const clock = new FakeClock();
  resetStores(clock);
  const saver = fakeSaver();
  const scheduler = startAutoSaveScheduler({
    source: useWorkspaceStore,
    save: saver.save,
    clock,
  });

  withFakeNow(clock, () => {
    applyImportBatch([
      {
        status: "failed",
        profileId: "Profile 7",
        errorCode: "profile_import_failed",
        error: "Chrome profile import failed. The incomplete identity was removed.",
        cleanup: "completed",
      },
    ]);
    clock.advance(600_000);
  });

  assert.equal(
    Object.keys(useIdentityStore.getState().identities).length,
    1,
    "a failed import registers no identity",
  );
  assert.equal(useWorkspaceStore.getState().dirty, false);
  assert.equal(saver.at.length, 0, "ten minutes of silence, with nothing to save");

  // The same batch with a completed result saves on the normal schedule,
  // which is what rules the scheduler out as the cause.
  withFakeNow(clock, () => {
    applyImportBatch([
      { status: "completed", profileId: "Profile 7", identity: importedProfile(7) },
    ]);
    clock.advance(5000);
  });
  assert.equal(Object.keys(useIdentityStore.getState().identities).length, 2);
  assert.equal(saver.at.length, 1);
  scheduler.stop();
});
