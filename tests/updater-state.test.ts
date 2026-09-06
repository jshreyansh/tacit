import test from "node:test";
import assert from "node:assert/strict";
import {
  emitUpdaterEvent,
  getUpdaterSnapshot,
  resetUpdaterSnapshot,
} from "../electron/updater-state";

// The window is irrelevant here; sendToWindow already refuses a dead one.
const noWindow = null;

test("a renderer that starts late can still learn an update is ready", () => {
  resetUpdaterSnapshot();
  // Exactly the sequence a relaunch produces: main broadcasts before anyone
  // is listening. Previously this was lost for thirty minutes.
  emitUpdaterEvent(noWindow, "updater:update-downloaded", {
    version: "0.39.16",
    releaseNotes: "notes",
    releaseDate: "2026-09-06T00:00:00Z",
  });

  const snap = getUpdaterSnapshot();
  assert.equal(snap.status, "ready");
  assert.equal(snap.info?.version, "0.39.16");
  assert.equal(snap.downloadPercent, 100);
});

test("progress accumulates without losing which version it is for", () => {
  resetUpdaterSnapshot();
  emitUpdaterEvent(noWindow, "updater:update-available", {
    version: "0.39.16",
    releaseNotes: "",
    releaseDate: "",
  });
  emitUpdaterEvent(noWindow, "updater:download-progress", { percent: 42 });

  const snap = getUpdaterSnapshot();
  assert.equal(snap.status, "downloading");
  assert.equal(snap.downloadPercent, 42);
  // The progress event carries no version; dropping it here would leave the
  // dialog unable to say what it is downloading.
  assert.equal(snap.info?.version, "0.39.16");
});

test("an error is remembered with its message", () => {
  resetUpdaterSnapshot();
  emitUpdaterEvent(noWindow, "updater:error", { message: "Not enough disk space" });

  const snap = getUpdaterSnapshot();
  assert.equal(snap.status, "error");
  assert.equal(snap.errorMessage, "Not enough disk space");
});

test("a location warning is not an update status", () => {
  resetUpdaterSnapshot();
  emitUpdaterEvent(noWindow, "updater:update-downloaded", {
    version: "0.39.16",
    releaseNotes: "",
    releaseDate: "",
  });
  emitUpdaterEvent(noWindow, "updater:location-warning", { bundlePath: "/Volumes/Tacit" });

  // The app cannot update from where it sits, but the update is still ready;
  // overwriting the status here would hide it.
  assert.equal(getUpdaterSnapshot().status, "ready");
});

test("a fresh process reports idle", () => {
  resetUpdaterSnapshot();
  assert.deepEqual(getUpdaterSnapshot(), {
    status: "idle",
    info: null,
    downloadPercent: 0,
    errorMessage: null,
  });
});
