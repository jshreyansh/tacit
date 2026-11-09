import test from "node:test";
import assert from "node:assert/strict";

import { useLocaleStore } from "../src/stores/localeStore.ts";
import { useNotificationStore } from "../src/stores/notificationStore.ts";
import { checkForUpdates, initUpdaterListeners, useUpdaterStore } from "../src/stores/updaterStore.ts";

type UpdateEventInfo = {
  version: string;
  releaseNotes: string;
  releaseDate: string;
};

type UpdaterListenerSet = {
  available?: (info: UpdateEventInfo) => void;
  progress?: (progress: { percent: number }) => void;
  downloaded?: (info: UpdateEventInfo) => void;
  error?: (error: { message: string }) => void;
  locationWarning?: (info: { bundlePath: string }) => void;
};

function resetStores() {
  useUpdaterStore.setState({
    status: "idle",
    info: null,
    downloadPercent: 0,
    errorMessage: null,
    checked: null,
  });
  useLocaleStore.setState({ locale: "en" });
  useNotificationStore.setState({ notifications: [] });
}

function installUpdaterBridge() {
  const listeners: UpdaterListenerSet = {};
  const previousWindow = globalThis.window;

  const updater = {
    check: async () => "up-to-date" as const,
    install: () => undefined,
    getVersion: async () => "0.0.0",
    onUpdateAvailable: (callback: (info: UpdateEventInfo) => void) => {
      listeners.available = callback;
      return () => {
        listeners.available = undefined;
      };
    },
    onDownloadProgress: (callback: (progress: { percent: number }) => void) => {
      listeners.progress = callback;
      return () => {
        listeners.progress = undefined;
      };
    },
    onUpdateDownloaded: (callback: (info: UpdateEventInfo) => void) => {
      listeners.downloaded = callback;
      return () => {
        listeners.downloaded = undefined;
      };
    },
    onError: (callback: (error: { message: string }) => void) => {
      listeners.error = callback;
      return () => {
        listeners.error = undefined;
      };
    },
    onLocationWarning: (callback: (info: { bundlePath: string }) => void) => {
      listeners.locationWarning = callback;
      return () => {
        listeners.locationWarning = undefined;
      };
    },
  };

  Object.assign(globalThis, {
    window: {
      tacit: {
        updater,
      },
    },
  });

  return {
    listeners,
    restore() {
      Object.assign(globalThis, { window: previousWindow });
    },
  };
}

test("initUpdaterListeners drives the download state through ready", () => {
  resetStores();
  const bridge = installUpdaterBridge();
  const cleanup = initUpdaterListeners();

  try {
    const info = {
      version: "1.2.3",
      releaseNotes: "notes",
      releaseDate: "2026-04-29T00:00:00.000Z",
    };

    bridge.listeners.available?.(info);
    assert.deepEqual(useUpdaterStore.getState(), {
      status: "downloading",
      info,
      downloadPercent: 0,
      errorMessage: null,
      checked: null,
    });

    bridge.listeners.progress?.({ percent: 42 });
    assert.equal(useUpdaterStore.getState().downloadPercent, 42);

    bridge.listeners.downloaded?.(info);
    assert.deepEqual(useUpdaterStore.getState(), {
      status: "ready",
      info,
      downloadPercent: 100,
      errorMessage: null,
      checked: null,
    });
  } finally {
    cleanup();
    bridge.restore();
  }
});

test("location warnings notify in the active locale and cleanup unsubscribes listeners", () => {
  resetStores();
  useLocaleStore.setState({ locale: "zh" });
  const bridge = installUpdaterBridge();
  const cleanup = initUpdaterListeners();

  try {
    bridge.listeners.locationWarning?.({ bundlePath: "/Applications/Tacit.app" });
    const [notification] = useNotificationStore.getState().notifications;
    assert.equal(notification?.type, "warn");
    assert.equal(
      notification?.message,
      "自动更新已禁用：请将 Tacit 移动到 /Applications 目录以接收更新。",
    );

    bridge.listeners.error?.({ message: "download failed" });
    assert.equal(useUpdaterStore.getState().status, "error");
    assert.equal(useUpdaterStore.getState().errorMessage, "download failed");

    cleanup();
    assert.equal(bridge.listeners.available, undefined);
    assert.equal(bridge.listeners.progress, undefined);
    assert.equal(bridge.listeners.downloaded, undefined);
    assert.equal(bridge.listeners.error, undefined);
    assert.equal(bridge.listeners.locationWarning, undefined);
  } finally {
    bridge.restore();
    useLocaleStore.setState({ locale: "en" });
    useNotificationStore.setState({ notifications: [] });
  }
});

function withCheck(check: () => Promise<string>) {
  const bridge = installUpdaterBridge();
  (globalThis.window as unknown as { tacit: { updater: { check: unknown } } }).tacit.updater.check = check;
  return bridge;
}

test("a check that finds nothing newer says so, and ends Checking", async () => {
  resetStores();
  const bridge = withCheck(async () => "up-to-date");
  try {
    const pending = checkForUpdates();
    assert.equal(useUpdaterStore.getState().status, "checking");
    await pending;
    assert.equal(useUpdaterStore.getState().status, "idle");
    assert.equal(useUpdaterStore.getState().checked, "up-to-date");
  } finally {
    bridge.restore();
  }
});

test("a check that couldn't finish, or threw, says it couldn't check", async () => {
  for (const check of [async () => "skipped", async () => Promise.reject(new Error("offline"))]) {
    resetStores();
    const bridge = withCheck(check);
    try {
      await checkForUpdates();
      assert.equal(useUpdaterStore.getState().status, "idle");
      assert.equal(useUpdaterStore.getState().checked, "failed");
    } finally {
      bridge.restore();
    }
  }
});

test("a newer version found during the check is left to its events, and clears an old result", async () => {
  resetStores();
  useUpdaterStore.setState({ checked: "up-to-date" });
  const bridge = withCheck(async () => {
    bridge.listeners.available?.({ version: "9.9.9", releaseNotes: "", releaseDate: "" });
    return "newer";
  });
  const cleanup = initUpdaterListeners();
  try {
    await checkForUpdates();
    assert.equal(useUpdaterStore.getState().status, "downloading");
    assert.equal(useUpdaterStore.getState().checked, null);
  } finally {
    cleanup();
    bridge.restore();
  }
});

test("initUpdaterListeners is a no-op without the preload updater bridge", () => {
  resetStores();
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: {} });

  try {
    const cleanup = initUpdaterListeners();
    assert.equal(useUpdaterStore.getState().status, "idle");
    cleanup();
  } finally {
    Object.assign(globalThis, { window: previousWindow });
  }
});
