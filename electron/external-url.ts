export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Identity providers that actively detect and refuse sign-in from an
 * embedded browser control (Electron's `<webview>`, in-app browsers,
 * etc.) as an anti-phishing measure — regardless of user-agent spoofing
 * or session partition. There is no supported way to make sign-in work
 * inside the webview itself, so navigation to these hosts gets redirected
 * to the user's real system browser instead (see `web-contents-created`
 * in main.ts), where it completes normally. (A cookie-capture workaround
 * for Google/YouTube was tried and removed — reading/decrypting another
 * browser's local cookie store is the same technique credential-stealing
 * malware uses, unreliable by design as Google actively hardens against
 * it, and not how legitimate apps get delegated Google access; the
 * correct replacement is a real OAuth flow, built separately per use case.)
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

