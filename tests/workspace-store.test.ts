import test from "node:test";
import assert from "node:assert/strict";

import {
  hasPendingSnapshot,
  shouldRunAutoSaveBackstop,
  useWorkspaceStore,
} from "../src/stores/workspaceStore.ts";

test("markDirty updates lastDirtyAt even when workspace is already dirty", () => {
  useWorkspaceStore.setState({
    workspacePath: null,
    dirty: false,
    lastSavedAt: null,
    lastDirtyAt: null,
  });

  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    useWorkspaceStore.getState().markDirty();
    const firstDirtyAt = useWorkspaceStore.getState().lastDirtyAt;
    assert.equal(useWorkspaceStore.getState().dirty, true);
    assert.equal(firstDirtyAt, 1_000);

    now = 2_000;
    useWorkspaceStore.getState().markDirty();
    assert.equal(useWorkspaceStore.getState().dirty, true);
    assert.equal(useWorkspaceStore.getState().lastDirtyAt, 2_000);
  } finally {
    Date.now = originalNow;
  }
});

test("hasPendingSnapshot is false once the latest dirty state was snapshotted", () => {
  assert.equal(hasPendingSnapshot(false, null, null), false);
  assert.equal(hasPendingSnapshot(true, 2_000, null), true);
  assert.equal(hasPendingSnapshot(true, 2_000, 1_500), true);
  assert.equal(hasPendingSnapshot(true, 2_000, 2_000), false);
  assert.equal(hasPendingSnapshot(true, 2_000, 2_500), false);
});

test("shouldRunAutoSaveBackstop only runs for unsnapshotted changes after the interval", () => {
  assert.equal(
    shouldRunAutoSaveBackstop({
      dirty: true,
      lastDirtyAt: 20_000,
      lastSavedAt: 10_000,
      now: 69_999,
      intervalMs: 60_000,
    }),
    false,
  );

  assert.equal(
    shouldRunAutoSaveBackstop({
      dirty: true,
      lastDirtyAt: 20_000,
      lastSavedAt: 10_000,
      now: 70_001,
      intervalMs: 60_000,
    }),
    true,
  );

  // The tick that lands exactly one interval after the last save counts.
  // The backstop is polled on an interval of exactly this length, so with a
  // strict `>` every other tick missed by zero milliseconds and the effective
  // period doubled — see the comment in shouldRunAutoSaveBackstop.
  assert.equal(
    shouldRunAutoSaveBackstop({
      dirty: true,
      lastDirtyAt: 20_000,
      lastSavedAt: 10_000,
      now: 70_000,
      intervalMs: 60_000,
    }),
    true,
  );

  assert.equal(
    shouldRunAutoSaveBackstop({
      dirty: true,
      lastDirtyAt: 20_000,
      lastSavedAt: 20_000,
      now: 120_000,
      intervalMs: 60_000,
    }),
    false,
  );
});
