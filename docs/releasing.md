# Releasing Tacit

macOS builds must be signed with a Developer ID certificate and notarized by
Apple. Without both, a downloaded build is refused by Gatekeeper — and on
current macOS the old right-click → Open bypass is gone, so a user has to go
into System Settings → Privacy & Security to run it at all. Most will assume
the app is broken and delete it.

## One-time setup

You need three things from your Apple Developer account:

1. **A Developer ID Application certificate**, installed in the login keychain.
   Xcode → Settings → Accounts → Manage Certificates → `+` → Developer ID
   Application. Confirm it is there:

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

2. **An app-specific password** for notarization, created at
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
   App-Specific Passwords. This is *not* your Apple ID password.

3. **Your Team ID** — the 10-character string in the certificate name, or from
   [developer.apple.com/account](https://developer.apple.com/account) →
   Membership.

## Building a release

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"

pnpm dist:mac
```

Signing identity is discovered from the keychain. Nothing is pinned in
`electron-builder.yml` on purpose — pinning a certificate name makes the build
fail outright on any machine that does not have that exact certificate.

Without those three variables set, electron-builder skips notarization and says
so. That is the correct behaviour for a local build; it is not a release.

Notarization takes a few minutes. Apple has to accept the upload, scan it, and
return a ticket, which electron-builder then staples into the bundle.

### In CI

Instead of a keychain certificate, export the `.p12` and pass it through:

```bash
export CSC_LINK="base64-encoded .p12 or a file path"
export CSC_KEY_PASSWORD="the .p12 password"
```

Store both as encrypted secrets. Never commit them.

## Verifying before you publish

Run all three. Each catches something the others do not.

```bash
APP="out/mac-arm64/Tacit.app"

# Signed by the right identity, with the hardened runtime on.
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|flags"
# Expect: Authority=Developer ID Application: …   flags=0x10000(runtime)

# Every nested binary is signed and the seal is intact.
codesign --verify --deep --strict --verbose=2 "$APP"

# The notarization ticket is stapled, so it works offline and on first launch.
xcrun stapler validate "$APP"

# What Gatekeeper itself will decide.
spctl -a -vvv -t install "$APP"
# Expect: accepted   source=Notarized Developer ID
```

The staple check is the one people skip. An app can be notarized and still fail
for a user with no network on first launch if the ticket was never stapled.

### The real test

Copy the DMG to a Mac that has never seen the source, or strip the quarantine
flag's absence by re-adding it:

```bash
xattr -w com.apple.quarantine "0081;00000000;Safari;" ~/Downloads/Tacit-*.dmg
```

A build that opens cleanly after that is a build a stranger can open.

## Publishing

`electron-builder.yml` publishes to `jshreyansh/tacit` releases. The repository
must be **public**, or release assets need authentication to download and
auto-update fails for everyone.

```bash
export GH_TOKEN="a token with repo scope"
pnpm dist:mac -- --publish always
```

## Auto-update

macOS does not use `electron-updater`'s own updater. `electron/mac-updater.ts`
is a custom implementation that fetches `latest-mac.yml` from the release,
downloads the zip with blockmap-based delta requests, verifies sha512, and swaps
the bundle with `ditto -xk` and `mv`.

Both of those preserve code signatures, and the `xattr -cr` afterwards clears
only the quarantine flag the download picked up. So the update path is already
compatible with a signed and notarized build; nothing there needs changing.

Windows and Linux go through `electron-updater` normally.

## Checklist

- [ ] Version bumped in `package.json`
- [ ] `pnpm test`, `pnpm run test:browser`, `pnpm typecheck` all pass
- [ ] Built with all three notarization variables set
- [ ] All four verification commands pass
- [ ] Opened from a quarantined copy on a clean machine
- [ ] Published to a public repository
- [ ] Update from the previous version tested end to end
