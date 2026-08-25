import test from "node:test";
import assert from "node:assert/strict";
import { BrowserConnectionRegistry } from "../electron/browser-connection-registry";
import { ConnectedBrowserBroker } from "../electron/connected-browser-broker";
import { CONNECTED_BROWSER_PROTOCOL_VERSION } from "../shared/browser-connection";

function connectedBrowser(commandTimeoutMs = 200) {
  const registry = new BrowserConnectionRegistry();
  const offer = registry.beginPairing();
  const paired = registry.completePairing(offer.code, {
    browser: "chrome",
    profileLabel: "Work",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    protocolVersion: CONNECTED_BROWSER_PROTOCOL_VERSION,
  });
  const binding = registry.authorizeTab(
    paired.connection.id,
    paired.token,
    { tabId: 12, windowId: 4, url: "https://example.com", title: "Example" },
    ["inspect", "navigate"],
  );
  return {
    registry,
    broker: new ConnectedBrowserBroker(registry, commandTimeoutMs),
    connectionId: paired.connection.id,
    token: paired.token,
    binding,
  };
}

test("dispatches only to the owning browser and settles the caller", async () => {
  const fixture = connectedBrowser();
  const result = fixture.broker.execute(
    fixture.binding.id,
    "navigate",
    { url: "https://linear.app" },
  );
  const command = await fixture.broker.poll(fixture.connectionId, fixture.token, 0);
  assert.equal(command?.tabId, 12);
  assert.equal(command?.action, "navigate");
  fixture.broker.settle(fixture.connectionId, fixture.token, command!.commandId, {
    ok: true,
    data: { url: "https://linear.app" },
  });
  assert.deepEqual(await result, { url: "https://linear.app" });
});

test("spoofed and stale command settlements are rejected", async () => {
  const first = connectedBrowser();
  const secondOffer = first.registry.beginPairing();
  const second = first.registry.completePairing(secondOffer.code, {
    browser: "edge",
    profileLabel: "Personal",
    extensionId: "ponmlkjihgfedcbaponmlkjihgfedcba",
    protocolVersion: CONNECTED_BROWSER_PROTOCOL_VERSION,
  });
  const result = first.broker.execute(first.binding.id, "read", {});
  const command = await first.broker.poll(first.connectionId, first.token, 0);
  assert.throws(
    () => first.broker.settle(first.connectionId, "spoofed", command!.commandId, { ok: true }),
    { code: "connection_unauthorized" },
  );
  assert.throws(
    () => first.broker.settle(second.connection.id, second.token, command!.commandId, { ok: true }),
    /stale|another connection/,
  );
  first.broker.settle(first.connectionId, first.token, command!.commandId, { ok: true });
  await result;
  assert.throws(
    () => first.broker.settle(first.connectionId, first.token, command!.commandId, { ok: true }),
    /stale|another connection/,
  );
});

test("disconnect revokes tabs and rejects work already in flight", async () => {
  const fixture = connectedBrowser();
  const result = fixture.broker.execute(fixture.binding.id, "read", {});
  await fixture.broker.poll(fixture.connectionId, fixture.token, 0);
  fixture.broker.revokeConnection(fixture.connectionId, fixture.token);
  await assert.rejects(result, /disconnected/);
  assert.equal(fixture.registry.listAuthorizedTabsForApp().length, 0);
  assert.throws(
    () => fixture.registry.requireAuthorizedTabForApp(fixture.binding.id, "inspect"),
    { code: "tab_unauthorized" },
  );
});

test("timed-out commands are removed instead of being delivered later", async () => {
  const fixture = connectedBrowser(15);
  await assert.rejects(
    fixture.broker.execute(fixture.binding.id, "read", {}),
    /timeout/,
  );
  assert.equal(await fixture.broker.poll(fixture.connectionId, fixture.token, 0), null);
});
