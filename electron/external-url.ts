export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Identity providers' sign-in hosts. These used to be sent to the system
 * browser on the belief that embedded browsers can never sign in; the real
 * reason Google refused was that browser nodes didn't look like Chrome
 * (no Google Chrome brand, no Sec-CH-UA hints). They now present as the
 * Chrome they're built from (browser-chrome-identity.ts), and sign-in stays
 * in the node (SHR-130). The list remains for the fallback,
 * TACIT_BROWSER_SIGNIN_EXTERNAL=1, which sends these to the system browser.
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

