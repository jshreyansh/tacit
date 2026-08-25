export const CONNECTED_BROWSER_PROTOCOL_VERSION = 1;

export type ConnectedBrowserFamily = "chrome" | "edge" | "brave";

export type BrowserCapability =
  | "inspect"
  | "navigate"
  | "click"
  | "type"
  | "press_key"
  | "select"
  | "scroll"
  | "screenshot"
  | "upload"
  | "download";

export const PORTABLE_BROWSER_CAPABILITIES: readonly BrowserCapability[] = [
  "inspect",
  "navigate",
  "click",
  "type",
  "press_key",
  "select",
  "scroll",
  "screenshot",
  "upload",
  "download",
] as const;

export interface ConnectedBrowserIdentity {
  browser: ConnectedBrowserFamily;
  profileLabel: string;
  extensionId: string;
  protocolVersion: typeof CONNECTED_BROWSER_PROTOCOL_VERSION;
}

export interface ConnectedTabDescriptor {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
}

export interface ConnectedTabBinding {
  id: string;
  connectionId: string;
  tab: ConnectedTabDescriptor;
  capabilities: BrowserCapability[];
  authorizedAt: string;
  revokedAt: string | null;
}

export interface ConnectedBrowserConnection {
  id: string;
  identity: ConnectedBrowserIdentity;
  connectedAt: string;
  revokedAt: string | null;
}

