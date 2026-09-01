/**
 * The correction the user makes with one click, and whether it survives.
 *
 * An override only earns its keep if it outlives the session it was made in —
 * being asked to point at ChatGPT's message box again tomorrow is worse than
 * never having been asked, because the first time it read as teaching and the
 * second reads as the app forgetting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { overrideForUrl } from "../shared/chat-delivery.ts";

function installBrowserGlobals() {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900,
      innerWidth: 1440,
      localStorage,
      addEventListener() {},
      removeEventListener() {},
      termcanvas: undefined,
    },
  });
}

async function freshStore() {
  installBrowserGlobals();
  const mod = await import("../src/stores/chatInputOverrideStore.ts");
  mod.useChatInputOverrideStore.getState().hydrate([]);
  const workspace = await import("../src/stores/workspaceStore.ts");
  workspace.useWorkspaceStore.setState({
    workspacePath: null,
    dirty: false,
    lastSavedAt: null,
    lastDirtyAt: null,
  });
  return { ...mod, workspace };
}

test("pointing at a box records it against the host, not the page", async () => {
  const { useChatInputOverrideStore } = await freshStore();
  const host = useChatInputOverrideStore
    .getState()
    .remember("https://chatgpt.com/c/68f0-4ab2?model=gpt-5", "#prompt-textarea");
  assert.equal(host, "chatgpt.com");
  assert.deepEqual(useChatInputOverrideStore.getState().overrides, [
    { host: "chatgpt.com", selector: "#prompt-textarea" },
  ]);
});

test("the override is what the delivery script will look for on that host", async () => {
  const { useChatInputOverrideStore } = await freshStore();
  useChatInputOverrideStore.getState().remember("https://gemini.google.com/app", ".ql-editor");
  const { overrides } = useChatInputOverrideStore.getState();
  // A different conversation on the same host resolves to the same box.
  assert.equal(overrideForUrl("https://gemini.google.com/app/9f2c", overrides), ".ql-editor");
  assert.equal(overrideForUrl("https://chatgpt.com/", overrides), undefined);
});

test("pointing again replaces the old box rather than stacking a second one", async () => {
  const { useChatInputOverrideStore } = await freshStore();
  const store = useChatInputOverrideStore.getState();
  store.remember("https://chatgpt.com/", "#old-box");
  store.remember("https://chatgpt.com/", "#new-box");
  assert.deepEqual(useChatInputOverrideStore.getState().overrides, [
    { host: "chatgpt.com", selector: "#new-box" },
  ]);
});

test("a URL with no host saves nothing and says so", async () => {
  const { useChatInputOverrideStore } = await freshStore();
  assert.equal(useChatInputOverrideStore.getState().remember("about:blank", "#box"), null);
  assert.equal(useChatInputOverrideStore.getState().remember("", "#box"), null);
  assert.equal(useChatInputOverrideStore.getState().overrides.length, 0);
});

test("remembering and forgetting both mark the workspace for saving", async () => {
  const { useChatInputOverrideStore, workspace } = await freshStore();
  useChatInputOverrideStore.getState().remember("https://chatgpt.com/", "#box");
  assert.equal(workspace.useWorkspaceStore.getState().dirty, true);

  workspace.useWorkspaceStore.setState({ dirty: false, lastDirtyAt: null });
  useChatInputOverrideStore.getState().forget("CHATGPT.COM");
  assert.equal(workspace.useWorkspaceStore.getState().dirty, true);
  assert.equal(useChatInputOverrideStore.getState().overrides.length, 0);
});

test("forgetting a host that was never corrected changes nothing", async () => {
  const { useChatInputOverrideStore, workspace } = await freshStore();
  useChatInputOverrideStore.getState().forget("example.com");
  assert.equal(workspace.useWorkspaceStore.getState().dirty, false);
});

test("overrides survive a workspace round trip", async () => {
  installBrowserGlobals();
  const registry = await import("../src/stores/canvasRegistryStore.ts");
  const scene = registry.useCanvasRegistryStore.getState().canvases[0].scene;
  const { readWorkspaceSnapshot } = await import("../src/snapshotBridge.ts");

  const document = {
    version: 3,
    activeCanvasId: "canvas-a",
    canvases: [{ id: "canvas-a", name: "Default", createdAt: 1, scene }],
    identities: [{ id: "identity-default", name: "Guest", createdAt: 1 }],
    activeIdentityId: "identity-default",
    chatInputOverrides: [
      { host: "chatgpt.com", selector: "#prompt-textarea" },
      // Junk a hand-edited or older file could carry, and a duplicate host
      // whose later entry is the correction that should win.
      { host: "", selector: "#nothing" },
      { host: "gemini.google.com" },
      { host: "CHATGPT.COM", selector: "#corrected" },
    ],
  };

  const restored = readWorkspaceSnapshot(JSON.parse(JSON.stringify(document)));
  assert.ok(restored && "workspace" in restored && restored.workspace);
  assert.deepEqual(restored.workspace!.chatInputOverrides, [
    { host: "chatgpt.com", selector: "#corrected" },
  ]);
});

test("a workspace saved before overrides existed loads without the field", async () => {
  installBrowserGlobals();
  const registry = await import("../src/stores/canvasRegistryStore.ts");
  const scene = registry.useCanvasRegistryStore.getState().canvases[0].scene;
  const { readWorkspaceSnapshot } = await import("../src/snapshotBridge.ts");

  const restored = readWorkspaceSnapshot({
    version: 3,
    activeCanvasId: "canvas-a",
    canvases: [{ id: "canvas-a", name: "Default", createdAt: 1, scene }],
    identities: [{ id: "identity-default", name: "Guest", createdAt: 1 }],
    activeIdentityId: "identity-default",
  });
  assert.ok(restored && "workspace" in restored && restored.workspace);
  assert.equal("chatInputOverrides" in restored.workspace!, false);
});
