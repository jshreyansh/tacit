# Browser Profile Adoption v2

## Product contract

Chrome profiles are import sources, not bags of cookies to merge into an existing Tacit identity. Each selected Chrome profile creates one independent, persistent Tacit browser identity. The built-in `Default` identity is never an import destination. Importing all selected profiles creates one identity per source profile, and every managed browser node can switch to any imported identity.

The source remains read-only. Tacit first snapshots the required Chrome files into a private temporary directory, imports into a fresh Tacit partition, flushes it, and only then publishes the identity to renderer state. A failed import clears the fresh partition and leaves no visible identity. Re-importing the same source creates a deliberate refreshed replacement or an explicitly named additional identity; it never silently mixes state.

## Trust boundary

- The renderer sends a validated Chrome profile id and an import request. It never chooses an arbitrary Electron partition.
- The main process creates the identity id and destination partition, performs migration, and returns only metadata and counts/statuses.
- Raw cookies, passwords, tokens, encryption keys, local-storage values, and IndexedDB records never enter renderer state, logs, snapshots, capture, or IPC results.
- Chrome is never mounted as a live Electron partition and no source file is modified.
- Temporary snapshots are exact app-created paths and are removed in `finally` paths.
- Protected or incompatible state is reported as unsupported/needs-login; it is not counted as imported.

## Import categories

Every result contains a truthful status for each category (`imported`, `partial`, `empty`, `unsupported`, or `failed`) plus non-sensitive counts.

| Category | v2 behavior |
|---|---|
| Profile name, avatar/account hint | Create identity metadata and provenance from Chrome `Local State`/`Preferences`; never expose account secrets. |
| Cookies/session cookies | Decrypt portable v10/v11 values through macOS Keychain and re-save through Electron. App-bound v20 values remain unsupported. |
| Local/session storage, IndexedDB, shared storage | Migrate only through a compatibility-checked, staged adapter. Never raw-copy a live database into an active partition. If Chromium formats are incompatible, report partial/unsupported per category. |
| History, favicons, bookmarks | Import into Tacit-owned browsing metadata used for address suggestions/history UI; do not pretend Electron itself consumes Chrome's SQLite files. |
| Saved passwords | Opt-in only. Decrypt in main process after a visible macOS permission and store in Tacit's own Keychain-backed vault. Autofill is explicit; plaintext never persists or crosses IPC. If the secure vault/autofill path is not complete, report unsupported and do not read passwords. |
| Open tabs | Optional follow-up action that can create browser nodes; not required to consider an identity imported. |
| Cache and service workers | Rebuild naturally after navigation; stale caches/workers are not copied. |
| Passkeys, payment methods, extensions, device/app-bound tokens | Never copied. Explain that the relevant site may require one fresh login. |

## UX

The manager says **Import from Chrome**, lists source profiles with name/avatar/account hint where available, supports selecting profiles and **Import selected** / **Import all**, and shows batch progress followed by a result for each profile. Successful rows say which new Tacit identity was created and summarize each category. Failed rows remain retryable and do not appear in the identity list. Existing identities and Default remain unchanged.

The normal browser-node identity menu includes the newly imported identities. Selecting one reopens that managed node on the identity's persistent partition. The optional connected-tab extension stays separate and clearly labeled as a live-tab path.

## Acceptance criteria

1. Importing profile A creates identity A and writes only to A's new partition; `Default` is byte-for-byte untouched.
2. Importing profiles A and B in one action creates two isolated identities. A cookie written in A is absent from B and Default.
3. A failed profile import clears its fresh partition and does not register an identity. Other profiles in the same batch may succeed.
4. Duplicate display names are deterministically disambiguated. Provenance (`source`, source profile id/name, imported timestamp, category summary) survives snapshot save/restore; parser paths do not drop it.
5. Renderer-controlled partition names are removed from import and clear-data IPC. Main-process handlers validate identity ids/profile ids and own partition resolution.
6. Import requires Chrome to be fully quit before source snapshotting and copies SQLite WAL/SHM sidecars where relevant.
7. UI has stable busy/progress/success/error states and cannot be double-submitted by rerendering.
8. Results never include cookie values, passwords, tokens, keys, raw site-storage values, or source filesystem paths.
9. Existing browser identities, connected tabs, browser cards, snapshots, and old workspaces continue to work.
10. Unit/integration tests cover discovery metadata, identity transaction/rollback, import-all partial success, isolation, IPC validation, snapshot provenance, and protected-data reporting. Typecheck, browser tests, full tests, production build, and packaged-app smoke test pass before a DMG is handed off.

## Platform boundary

Tacit can reproduce the portable parts of a Chrome profile's browsing identity; it cannot literally become Chrome or clone proprietary Chrome Sync, extensions, passkeys, payment credentials, or device-bound sessions. The UI must call this a profile import and describe any site that still needs one login. A connected system-browser profile remains the later route for exact live Chrome state.

## Browser surface direction

Electron recommends moving away from `<webview>`. Profile Adoption v2 must keep partition ownership behind a browser-surface abstraction so managed nodes can migrate to `WebContentsView` without changing identity semantics. That surface migration is a separate risk-controlled change; profile import must not depend on raw `<webview>` APIs beyond selecting a persistent partition today.
