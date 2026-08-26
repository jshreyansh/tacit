# Browser profile adoption decision

## Decision

Tacit will use a staged hybrid model:

1. **Tacit identity with one-time session import** — an isolated, persistent browser identity owned by Tacit. On macOS, the user can select a local Chrome profile, quit Chrome, and import its portable login cookies once. Tacit decrypts them through Chrome Safe Storage and immediately re-encrypts them in the destination Electron session; raw values never reach renderer state, snapshots, capture, or logs.
2. **Connected tab (optional)** — a browser extension connects one explicitly selected tab from Chrome, Edge, or Brave when a live system-browser tab is specifically useful.
3. **System-browser OAuth handoff** — app-owned OAuth opens in the system browser and returns through a secure callback where a provider supports it.

Tacit will not mount, mutate, or concurrently reuse a live system-browser profile. The first import slice is cookies only: saved passwords and browsing history are not read. Chromium app-bound (`v20`) cookies are deliberately skipped rather than bypassing their protection.

## Why

Google's OAuth policy prohibits directing authorization requests to a developer-controlled embedded user-agent. Changing a user agent or replacing `<webview>` with another embedded Electron surface does not remove that policy boundary. Electron also recommends moving away from `<webview>` because of its stability architecture.

A one-time cookie import provides the lowest-friction normal experience: browser nodes stay signed in using Tacit-owned storage without requiring an extension action for every tab. Chrome must be closed during the database copy, and only a validated profile directory can be selected. The connected-tab extension remains useful for sites whose sessions cannot be ported or when the user explicitly wants to control the live Chrome tab.

## Feasibility and risk

| Path | Existing login | Corruption risk | Google sign-in | Automation | Recommendation |
|---|---:|---:|---:|---:|---|
| Tacit persistent identity + one-time cookie import | Yes, for portable sessions | Low | Existing session reused where portable | Strong | Primary onboarding path |
| Connected Chrome tab | Yes | Low | Yes, login stays in Chrome | Strong | Optional live-tab path |
| Connected Edge tab | Yes | Low | Yes, login stays in Edge | Strong | Same Chromium extension adapter |
| Connected Brave tab | Yes | Low | Yes, login stays in Brave | Strong | Same adapter; test Brave-specific policy |
| Safari tab | Yes | Low | Yes | Separate extension/runtime APIs | Later adapter, not first prototype |
| Limited bookmark/history import | Partial | Medium | Not applicable | Weak | Consider later with preview/rollback |
| Saved-password import | Potentially | High | Not applicable | N/A | Deferred; Electron exposes no supported importer |
| Direct raw cookie DB copy | Potentially | High | Fragile | N/A | Rejected; cookies are decrypted and re-saved individually instead |
| Direct live profile reuse | Yes | Critical | Unreliable | Fragile | Rejected |

## Permission experience

The first browser-import flow should say exactly what happens:

1. Tacit lists user-visible Chrome profile names and the currently selected Tacit identity.
2. The user quits Chrome and chooses **Import sessions**.
3. macOS may ask for Keychain access to Chrome Safe Storage.
4. Tacit reports only imported/skipped/failed counts and refreshes browser nodes using that identity.
5. The source Chrome profile is never written to and the temporary database copy is deleted.

The optional connected-tab flow continues to show a short-lived pairing code, explicit per-tab approval, requested capabilities, and revocation controls.

Sensitive form values are redacted from the capture record. Uploads, downloads, and any non-portable debugging operation require separate visible permission.

## Prototype boundary

`browser-profile-import.ts` implements the app-owned import slice:

- validated Chrome-root/profile-directory discovery;
- Chrome-closed enforcement before copying the database;
- macOS Chrome Safe Storage key retrieval without renderer exposure;
- v10/v11 decryption with schema-24 host authentication;
- explicit rejection of app-bound v20 data;
- per-cookie re-encryption by Electron's destination session;
- count-only results and exact temporary-directory cleanup.

`BrowserConnectionRegistry` separately implements the optional live-tab slice:

- expiring, one-use pairing offers;
- protocol and browser/profile identity checks;
- a high-entropy install-scoped connection token;
- explicit per-tab and per-capability authorization;
- constant-time token verification;
- tab-level and whole-browser revocation;
- rejection of stale, spoofed, cross-tab, and missing-capability requests.

The registry intentionally contains no API for profile paths, cookies, passwords, or arbitrary unselected tabs.

## Migration and rollback

Existing Tacit identities and their `persist:identity-*` partitions remain the destination. Import writes cookies through Electron's supported session API and refreshes existing managed cards; it never mounts or modifies the Chrome source. Connecting a system tab creates a separate backend binding and never converts an identity partition.

Rollback is deletion-only: deleting a Tacit identity clears its imported sessions through the existing partition wipe. Revoking an extension connection removes only the live-tab backend. Chrome remains untouched in both cases.

## Sources

- [Electron `<webview>` warning](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
