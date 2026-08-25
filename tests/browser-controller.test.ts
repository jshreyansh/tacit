import test from "node:test";
import assert from "node:assert/strict";
import {
  BrowserController,
  resolveBrowserNodeBinding,
  type BrowserBackendAdapter,
} from "../src/browser/browserController";
import { normalizeBrowserNodeBinding } from "../shared/browser-controller";
import type { BrowserCardData } from "../src/stores/browserCardStore";

function card(patch: Partial<BrowserCardData> = {}): BrowserCardData {
  return {
    id: "browser-1",
    url: "https://example.com",
    title: "Example",
    x: 0,
    y: 0,
    w: 800,
    h: 600,
    identityId: "identity-default",
    ...patch,
  };
}

test("legacy cards resolve to the managed backend without mutating their snapshot", () => {
  const legacy = card();
  assert.deepEqual(resolveBrowserNodeBinding(legacy), {
    kind: "managed",
    engine: "legacy-webview",
    identityId: "identity-default",
  });
  assert.equal(legacy.backend, undefined);
});

test("controller validates requests before invoking an adapter", async () => {
  let calls = 0;
  const adapter: BrowserBackendAdapter = {
    kind: "managed",
    capabilities: new Set(["navigate"]),
    async execute() {
      calls += 1;
      return { ok: true };
    },
  };
  const controller = new BrowserController();
  controller.register(adapter);
  const result = await controller.execute(card(), "navigate", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_request");
  assert.equal(calls, 0);
});

test("missing capabilities fail clearly before execution", async () => {
  const controller = new BrowserController();
  controller.register({
    kind: "managed",
    capabilities: new Set(["inspect"]),
    async execute() { throw new Error("must not run"); },
  });
  const result = await controller.execute(card(), "click", { selector: "button" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "capability_missing");
    assert.match(result.error.message, /click/);
  }
});

test("controller routes a valid action through the matching backend", async () => {
  const controller = new BrowserController();
  controller.register({
    kind: "managed",
    capabilities: new Set(["inspect"]),
    async execute(_card, binding, request) {
      assert.equal(binding.kind, "managed");
      assert.equal(request.action, "read");
      return { text: "hello" };
    },
  });
  const result = await controller.execute(card(), "read");
  assert.deepEqual(result, {
    ok: true,
    backend: "managed",
    capability: "inspect",
    data: { text: "hello" },
  });
});

test("eval is explicitly negotiated as a non-portable escape hatch", async () => {
  const controller = new BrowserController();
  controller.register({
    kind: "managed",
    capabilities: new Set(["non_portable_eval"]),
    async execute() { return 42; },
  });
  const result = await controller.execute(card(), "eval", { script: "6 * 7" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.capability, "non_portable_eval");
});

test("malformed persisted backend bindings fall back to the safe managed identity", () => {
  assert.deepEqual(
    normalizeBrowserNodeBinding(
      { kind: "connected-tab", connectionId: "spoof", tabBindingId: "" },
      "identity-safe",
    ),
    {
      kind: "managed",
      engine: "legacy-webview",
      identityId: "identity-safe",
    },
  );
});
