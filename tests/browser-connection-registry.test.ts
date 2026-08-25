import test from "node:test";
import assert from "node:assert/strict";
import { BrowserConnectionRegistry } from "../electron/browser-connection-registry";
import { CONNECTED_BROWSER_PROTOCOL_VERSION } from "../shared/browser-connection";

const identity = {
  browser: "chrome" as const,
  profileLabel: "Shreyansh — Work",
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  protocolVersion: CONNECTED_BROWSER_PROTOCOL_VERSION,
};

test("pairing is one-time and returns an install-scoped secret", () => {
  const registry = new BrowserConnectionRegistry();
  const offer = registry.beginPairing(1_000);
  const paired = registry.completePairing(offer.code, identity, 2_000);
  assert.equal(paired.connection.identity.profileLabel, identity.profileLabel);
  assert.ok(paired.token.length >= 40);
  assert.throws(
    () => registry.completePairing(offer.code, identity, 2_001),
    { code: "pairing_invalid" },
  );
});

test("expired and incompatible pairing attempts are refused", () => {
  const registry = new BrowserConnectionRegistry(100);
  const expired = registry.beginPairing(1_000);
  assert.throws(
    () => registry.completePairing(expired.code, identity, 1_101),
    { code: "pairing_invalid" },
  );
  const incompatible = registry.beginPairing(2_000);
  assert.throws(
    () => registry.completePairing(incompatible.code, { ...identity, protocolVersion: 99 as 1 }, 2_001),
    { code: "protocol_mismatch" },
  );
});

test("only an explicitly authorized tab and capability can be controlled", () => {
  const registry = new BrowserConnectionRegistry();
  const offer = registry.beginPairing();
  const paired = registry.completePairing(offer.code, identity);
  const binding = registry.authorizeTab(
    paired.connection.id,
    paired.token,
    { tabId: 17, windowId: 3, url: "https://example.com", title: "Example" },
    ["inspect", "click"],
  );
  assert.equal(
    registry.requireAuthorizedTab(paired.connection.id, paired.token, binding.id, 17, "click").id,
    binding.id,
  );
  assert.throws(
    () => registry.requireAuthorizedTab(paired.connection.id, paired.token, binding.id, 18, "click"),
    { code: "tab_unauthorized" },
  );
  assert.throws(
    () => registry.requireAuthorizedTab(paired.connection.id, paired.token, binding.id, 17, "type"),
    { code: "capability_missing" },
  );
});

test("spoofed tokens fail and revocation immediately removes access", () => {
  const registry = new BrowserConnectionRegistry();
  const offer = registry.beginPairing();
  const paired = registry.completePairing(offer.code, identity);
  const binding = registry.authorizeTab(
    paired.connection.id,
    paired.token,
    { tabId: 17, windowId: 3, url: "https://example.com", title: "Example" },
  );
  assert.throws(
    () => registry.requireAuthorizedTab(paired.connection.id, "spoofed", binding.id, 17, "inspect"),
    { code: "connection_unauthorized" },
  );
  registry.revokeTab(paired.connection.id, paired.token, binding.id);
  assert.throws(
    () => registry.requireAuthorizedTab(paired.connection.id, paired.token, binding.id, 17, "inspect"),
    { code: "tab_unauthorized" },
  );
});

test("revoking the browser connection revokes every granted tab", () => {
  const registry = new BrowserConnectionRegistry();
  const offer = registry.beginPairing();
  const paired = registry.completePairing(offer.code, identity);
  const binding = registry.authorizeTab(
    paired.connection.id,
    paired.token,
    { tabId: 7, windowId: 1, url: "https://linear.app", title: "Linear" },
  );
  registry.revokeConnection(paired.connection.id, paired.token);
  assert.throws(
    () => registry.requireAuthorizedTab(paired.connection.id, paired.token, binding.id, 7, "inspect"),
    { code: "connection_unauthorized" },
  );
});
