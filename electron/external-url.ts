export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Identity providers' sign-in hosts, which browser nodes send to the system
 * browser. Google refuses sign-in in embedded Chromium on purpose. Presenting
 * nodes as Chrome (browser-chrome-identity.ts) was tried and Google still
 * refused (21 Oct 2026), so these leave until browser nodes run on a real
 * Chrome (SHR-130). TACIT_BROWSER_SIGNIN_IN_APP=1 keeps them in the node, for
 * testing.
 */
const EMBEDDED_AUTH_BLOCKED_HOSTS = [
  "accounts.google.com",
  "accounts.youtube.com",
  "login.microsoftonline.com",
  "login.live.com",
  "login.windows.net",
  "appleid.apple.com",
  "login.yahoo.com",
];

export function isEmbeddedAuthBlockedUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return EMBEDDED_AUTH_BLOCKED_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

