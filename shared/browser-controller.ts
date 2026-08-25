import type {
  BrowserCapability,
  ConnectedBrowserFamily,
} from "./browser-connection";

export type BrowserBackendKind = "managed" | "connected-tab";

export type BrowserNodeBinding =
  | {
      kind: "managed";
      /** Compatibility engine; replaceable without changing canvas identity. */
      engine: "legacy-webview";
      identityId: string;
    }
  | {
      kind: "connected-tab";
      connectionId: string;
      tabBindingId: string;
      browser: ConnectedBrowserFamily;
      profileLabel: string;
    };

export type BrowserControllerCapability =
  | BrowserCapability
  | "non_portable_eval";

export type BrowserActionName =
  | "navigate"
  | "read"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "eval";

export interface BrowserActionRequest {
  action: BrowserActionName;
  params: Record<string, unknown>;
}

export type BrowserActionResult =
  | {
      ok: true;
      backend: BrowserBackendKind;
      capability: BrowserControllerCapability;
      data: unknown;
    }
  | {
      ok: false;
      backend: BrowserBackendKind;
      capability: BrowserControllerCapability;
      error: {
        code: "backend_unavailable" | "capability_missing" | "invalid_request" | "execution_failed";
        message: string;
        retryable: boolean;
      };
    };

export function managedBrowserBinding(identityId: string): BrowserNodeBinding {
  return { kind: "managed", engine: "legacy-webview", identityId };
}

export function normalizeBrowserNodeBinding(
  value: unknown,
  fallbackIdentityId: string,
): BrowserNodeBinding {
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (
      candidate.kind === "managed" &&
      candidate.engine === "legacy-webview" &&
      typeof candidate.identityId === "string" &&
      candidate.identityId
    ) {
      return managedBrowserBinding(candidate.identityId);
    }
    if (
      candidate.kind === "connected-tab" &&
      typeof candidate.connectionId === "string" && candidate.connectionId &&
      typeof candidate.tabBindingId === "string" && candidate.tabBindingId &&
      (candidate.browser === "chrome" || candidate.browser === "edge" || candidate.browser === "brave") &&
      typeof candidate.profileLabel === "string" && candidate.profileLabel
    ) {
      return {
        kind: "connected-tab",
        connectionId: candidate.connectionId,
        tabBindingId: candidate.tabBindingId,
        browser: candidate.browser,
        profileLabel: candidate.profileLabel,
      };
    }
  }
  return managedBrowserBinding(fallbackIdentityId);
}

export function capabilityForBrowserAction(
  action: BrowserActionName,
): BrowserControllerCapability {
  switch (action) {
    case "read": return "inspect";
    case "eval": return "non_portable_eval";
    default: return action;
  }
}

export function isBrowserActionName(value: unknown): value is BrowserActionName {
  return (
    value === "navigate" ||
    value === "read" ||
    value === "back" ||
    value === "forward" ||
    value === "reload" ||
    value === "click" ||
    value === "eval"
  );
}

export function validateBrowserActionRequest(
  action: BrowserActionName,
  params: unknown,
): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return "browser action params must be an object";
  }
  const values = params as Record<string, unknown>;
  if (action === "navigate" && (typeof values.url !== "string" || !values.url)) {
    return "navigate requires a url";
  }
  if (action === "click" && (typeof values.selector !== "string" || !values.selector)) {
    return "click requires a selector";
  }
  if (action === "eval" && (typeof values.script !== "string" || !values.script)) {
    return "eval requires a script";
  }
  return null;
}
