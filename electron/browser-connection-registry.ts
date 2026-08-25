import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CONNECTED_BROWSER_PROTOCOL_VERSION,
  PORTABLE_BROWSER_CAPABILITIES,
  type BrowserCapability,
  type ConnectedBrowserConnection,
  type ConnectedBrowserIdentity,
  type ConnectedTabBinding,
  type ConnectedTabDescriptor,
} from "../shared/browser-connection";

interface PendingPairing {
  code: string;
  expiresAt: number;
}

interface ConnectionSecret {
  connection: ConnectedBrowserConnection;
  token: string;
}

export interface PairingOffer {
  code: string;
  expiresAt: string;
}

export interface PairingResult {
  connection: ConnectedBrowserConnection;
  token: string;
}

export class BrowserConnectionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BrowserConnectionError";
  }
}

/**
 * Security boundary for the connected-system-browser prototype.
 *
 * It deliberately knows nothing about browser profile files or cookies. An
 * extension proves a one-time pairing code, receives an install-scoped secret,
 * and must then grant individual tabs before any action can be dispatched.
 */
export class BrowserConnectionRegistry {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly connections = new Map<string, ConnectionSecret>();
  private readonly bindings = new Map<string, ConnectedTabBinding>();

  constructor(private readonly pairingTtlMs = 5 * 60_000) {}

  beginPairing(now = Date.now()): PairingOffer {
    this.sweep(now);
    const code = randomBytes(12).toString("base64url");
    const expiresAt = now + this.pairingTtlMs;
    this.pending.set(code, { code, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  completePairing(
    code: string,
    identity: ConnectedBrowserIdentity,
    now = Date.now(),
  ): PairingResult {
    this.sweep(now);
    const pending = this.pending.get(code);
    if (!pending) {
      throw new BrowserConnectionError("Pairing code is invalid or expired", "pairing_invalid");
    }
    if (identity.protocolVersion !== CONNECTED_BROWSER_PROTOCOL_VERSION) {
      throw new BrowserConnectionError("Browser connector protocol is incompatible", "protocol_mismatch");
    }
    if (!identity.extensionId.trim() || !identity.profileLabel.trim()) {
      throw new BrowserConnectionError("Browser and profile must be identified", "identity_invalid");
    }
    this.pending.delete(code); // one use, including after a successful proof
    const connection: ConnectedBrowserConnection = {
      id: randomUUID(),
      identity: {
        ...identity,
        extensionId: identity.extensionId.trim(),
        profileLabel: identity.profileLabel.trim(),
      },
      connectedAt: new Date(now).toISOString(),
      revokedAt: null,
    };
    const token = randomBytes(32).toString("base64url");
    this.connections.set(connection.id, { connection, token });
    return { connection, token };
  }

  authorizeTab(
    connectionId: string,
    token: string,
    tab: ConnectedTabDescriptor,
    requestedCapabilities: readonly BrowserCapability[] = PORTABLE_BROWSER_CAPABILITIES,
    now = Date.now(),
  ): ConnectedTabBinding {
    this.requireConnection(connectionId, token);
    if (!Number.isInteger(tab.tabId) || !Number.isInteger(tab.windowId) || !tab.url) {
      throw new BrowserConnectionError("A concrete browser tab must be selected", "tab_invalid");
    }
    const allowed = new Set(PORTABLE_BROWSER_CAPABILITIES);
    const capabilities = [...new Set(requestedCapabilities)].filter((capability) =>
      allowed.has(capability),
    );
    const binding: ConnectedTabBinding = {
      id: randomUUID(),
      connectionId,
      tab: { ...tab },
      capabilities,
      authorizedAt: new Date(now).toISOString(),
      revokedAt: null,
    };
    this.bindings.set(binding.id, binding);
    return binding;
  }

  requireAuthorizedTab(
    connectionId: string,
    token: string,
    bindingId: string,
    tabId: number,
    capability: BrowserCapability,
  ): ConnectedTabBinding {
    this.requireConnection(connectionId, token);
    const binding = this.bindings.get(bindingId);
    if (
      !binding ||
      binding.connectionId !== connectionId ||
      binding.tab.tabId !== tabId ||
      binding.revokedAt
    ) {
      throw new BrowserConnectionError("This tab is not authorized", "tab_unauthorized");
    }
    if (!binding.capabilities.includes(capability)) {
      throw new BrowserConnectionError(
        `The connected tab did not grant ${capability}`,
        "capability_missing",
      );
    }
    return binding;
  }

  revokeTab(connectionId: string, token: string, bindingId: string, now = Date.now()): void {
    this.requireConnection(connectionId, token);
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.connectionId !== connectionId) return;
    binding.revokedAt = new Date(now).toISOString();
  }

  revokeConnection(connectionId: string, token: string, now = Date.now()): void {
    const secret = this.requireConnection(connectionId, token);
    secret.connection.revokedAt = new Date(now).toISOString();
    for (const binding of this.bindings.values()) {
      if (binding.connectionId === connectionId && !binding.revokedAt) {
        binding.revokedAt = secret.connection.revokedAt;
      }
    }
  }

  private requireConnection(connectionId: string, token: string): ConnectionSecret {
    const secret = this.connections.get(connectionId);
    if (!secret || secret.connection.revokedAt || !safeEqual(secret.token, token)) {
      throw new BrowserConnectionError("Browser connection is not authorized", "connection_unauthorized");
    }
    return secret;
  }

  private sweep(now: number): void {
    for (const [code, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(code);
    }
  }
}

function safeEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

