# Browser profile adoption decision

## Decision

Tacit will use a staged hybrid model:

1. **Tacit identity** — an isolated, persistent browser identity owned by Tacit for repeatable automation and sites that permit embedded use.
2. **Connected tab** — a browser extension connects one explicitly selected tab from Chrome, Edge, or Brave, preserving the user's existing login without copying credentials.
3. **System-browser OAuth handoff** — app-owned OAuth opens in the system browser and returns through a secure callback where a provider supports it.

Tacit will not mount, mutate, or concurrently reuse a live system-browser profile. Limited import is deferred until the hybrid path proves insufficient; passwords and raw authentication cookies are not import targets.

## Why

Google's OAuth policy prohibits directing authorization requests to a developer-controlled embedded user-agent. Changing a user agent or replacing `<webview>` with another embedded Electron surface does not remove that policy boundary. Electron also recommends moving away from `<webview>` because of its stability architecture.

A connected-tab extension keeps authentication inside the user's actual browser. Chromium's extension debugger API can attach to a chosen tab for inspection and automation, while native messaging provides an allowlisted extension-to-app channel. This gives Tacit useful control without reading the profile database.

## Feasibility and risk

| Path | Existing login | Corruption risk | Google sign-in | Automation | Recommendation |
|---|---:|---:|---:|---:|---|
| Tacit persistent identity | No initial reuse | Low | Provider-dependent | Strong | Keep for isolated/repeatable work |
| Connected Chrome tab | Yes | Low | Yes, login stays in Chrome | Strong | First profile-adoption path |
| Connected Edge tab | Yes | Low | Yes, login stays in Edge | Strong | Same Chromium extension adapter |
| Connected Brave tab | Yes | Low | Yes, login stays in Brave | Strong | Same adapter; test Brave-specific policy |
| Safari tab | Yes | Low | Yes | Separate extension/runtime APIs | Later adapter, not first prototype |
| Limited bookmark/history import | Partial | Medium | Not applicable | Weak | Consider later with preview/rollback |
| Cookie/password import | Potentially | High | Fragile and policy-sensitive | N/A | Rejected |
| Direct live profile reuse | Yes | Critical | Unreliable | Fragile | Rejected |

## Permission experience

The first connected-browser flow should say exactly what happens:

1. Tacit shows **Connect your browser** and a short-lived pairing code.
2. The extension identifies the browser and user-visible profile label. It does not send passwords or cookie databases.
3. The user opens the extension on a tab and chooses **Connect this tab to Tacit**.
4. Tacit shows the tab title, URL, browser/profile, and requested capabilities before binding it to a canvas node.
5. A persistent indicator appears in both the browser and Tacit while the tab is connected or recording.
6. **Disconnect tab** revokes one tab. **Forget browser** revokes every tab and the install secret.

Sensitive form values are redacted from the capture record. Uploads, downloads, and any non-portable debugging operation require separate visible permission.

## Prototype boundary

`BrowserConnectionRegistry` implements the security-critical first slice:

- expiring, one-use pairing offers;
- protocol and browser/profile identity checks;
- a high-entropy install-scoped connection token;
- explicit per-tab and per-capability authorization;
- constant-time token verification;
- tab-level and whole-browser revocation;
- rejection of stale, spoofed, cross-tab, and missing-capability requests.

The next browser-foundation ticket wires this registry to an MV3 extension and native-messaging host, wraps current `<webview>` cards behind the same controller, and exposes connected tabs as a second backend. The registry intentionally contains no API for profile paths, cookies, passwords, or arbitrary unselected tabs.

## Migration and rollback

Existing Tacit identities and their `persist:identity-*` partitions stay unchanged during the transition. Existing cards remain legacy managed-browser nodes. Connecting a system tab creates a new backend binding; it never converts or overwrites an identity partition.

Rollback is therefore deletion-only: revoke the connection token, remove the native-messaging registration/extension, and leave all existing Tacit browser data untouched. Deleting a Tacit identity continues to clear only its Tacit-owned partition.

## Sources

- [Electron `<webview>` warning](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
