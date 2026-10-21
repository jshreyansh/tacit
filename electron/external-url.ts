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

/**
 * Google's own sign-in pages, where someone types or picks an account. The rest
 * of accounts.google.com is the bookkeeping a signed-in browser passes through
 * without a page: ServiceLogin?passive, CheckCookie, SetSID, RotateCookiesPage.
 * Gmail and the account page hop through those to refresh a session that's
 * still good, and sending such a hop out cut the node off from a session it had
 * (SHR-132: an imported profile "showing Google's sign-in" days later). A hop
 * that finds no session redirects to one of these, and that's sent out then.
 */
const GOOGLE_SIGN_IN_PAGE = /^\/(v3\/signin|signin|InteractiveLogin|AddSession|AccountChooser)(\/|$)/i;
const GOOGLE_ACCOUNT_HOSTS = ["accounts.google.com", "accounts.youtube.com"];

export function isEmbeddedAuthBlockedUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const matches = (host: string) => hostname === host || hostname.endsWith(`.${host}`);
    if (GOOGLE_ACCOUNT_HOSTS.some(matches)) return GOOGLE_SIGN_IN_PAGE.test(pathname);
    return EMBEDDED_AUTH_BLOCKED_HOSTS.some(matches);
  } catch {
    return false;
  }
}

