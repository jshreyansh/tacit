# Browser Adoption and Observation v3

Supersedes Profile Adoption v2. v2 was a data-migration plan; this is not.

## Purpose

Tacit's value is the record: the canvas already observes terminals, agents, and
the choices made between them, and that record is what makes work repeatable and
compoundable. A knowledge worker's day is not only terminals. When the browser
part of that day happens in Chrome, it is invisible, and the record has a hole in
it exactly where the work was.

The browser inside Tacit exists to close that hole. Profile adoption is not the
goal; it is the removal of the reasons to leave. Every feature below is justified
by one of two things: it makes staying cheaper than leaving, or it makes what
happens while you stay legible to the record.

The success test is a single unbroken sentence: **open the canvas, open a browser
node, switch to the profile I work as, go to the site I always use, find I am
already signed in, do the work — and afterwards Tacit knows what that work was.**
Every step of that sentence is currently broken somewhere.

## Product contract

Chrome profiles are import sources, not bags of cookies to merge into an existing
profile. Each selected Chrome profile creates one independent, persistent Tacit
browser profile. The built-in empty profile is never an import destination.
Importing all selected sources creates one profile per source, and every managed
browser node can switch to any of them.

The source remains read-only. Tacit snapshots the required Chrome files into a
private temporary directory, imports into a fresh partition, flushes it, and only
then publishes the profile to renderer state. A failed import clears the fresh
partition and leaves no visible profile. Re-importing the same source is either a
per-site re-adoption into the existing profile or an explicitly named additional
profile; it never silently mixes state.

### Vocabulary

The user-facing word is **profile**, not "identity". The UI currently glosses
"identity" every time it uses it — "identity (session/cookies)", "separate
login", "saved logins/cookies erased" — which is a reliable sign the word carries
no meaning the reader already owns. `BrowserIdentity`, `identityId`, and the
partition strings stay as internal names; only the surface changes. The apparent
collision with "Chrome profile" is the mental model, not a bug.

The built-in empty profile is renamed **Guest**. "Default" collides with Chrome's
own `Default` directory — producing a real bug today where an unnamed Chrome
profile imports as "Default 2" — and it means "signed out of everything" while
sounding like "your normal one".

## The record: two tiers

`shared/capture.ts` states a deliberate philosophy: the record holds choice
points, not activity, because "every file read and grep an agent performs is
activity; recording it produces a diary nobody re-reads." The existing
`browser_action` event carries the same rule in its doc comment: "page contents
stay in their source."

Browser observation must not violate that. Clicks, scrolls, and page text are
activity, and pouring them into the decision record would bury the choice points
that make it mineable for taste. The resolution is two tiers, which the existing
schema already anticipates — `CaptureReference` has a `kind: "event"` variant, and
the contract already says large content is referenced rather than duplicated.

**Tier 1 — the decision record (unchanged in character).** Append-only JSONL,
choice points only: navigated here, submitted this, signed in as that, decided
this. Stays small, stays readable, stays the thing you mine for how a person
works. Browser entries reference tier 2 through `input_refs` and `evidence`.

**Tier 2 — the browser activity stream (new).** A separate per-profile store
holding the raw observations: interaction events with element role and label,
and the visible text of pages worked in. Sized and pruned independently. It is
referenced from tier 1, never inlined into it. Transcripts are already handled
this way; this follows the same precedent rather than inventing one.

A consequence worth stating plainly: tier 2 is the sensitive artifact. Tier 1 can
be shared, diffed, and reasoned over; tier 2 holds page contents and must be
treated as the user's most private local data in the product.

## What is observed

Observation is **on by default for every imported profile**. The alternative —
per-node or per-site opt-in — loses precisely the work worth keeping, because the
switch gets forgotten at the moment work actually starts.

| Observed | Tier | Notes |
|---|---|---|
| Navigation (URL, title, timing) | 1 | Already shipped for managed nodes. |
| Interaction: click, submit, key commit, scroll extent | 2 | Recorded as element role plus accessible label, e.g. "clicked button: Approve". Never coordinates alone; a pixel is not knowledge. |
| Visible page text of worked-in pages | 2 | Captured on settle, not per keystroke. Deduplicated per URL and content hash. |
| Field values, passwords, payment inputs | never | Masked at the source, in the injected script, before the event leaves the page. |
| Full DOM / replayable session capture | not built | See "Not built". |

### Redaction

A small built-in category list — banking, health, password managers,
authentication pages — records tier 1 normally and **suppresses tier 2 text**, so
the record still shows that work happened and what was clicked, without holding
the contents. Those entries carry `privacy_scope: redacted`, which already exists
in the contract for this purpose.

The list is a default, not a policy: it is visible, editable, and can be emptied.
It exists because "all profiles, always" is the right ergonomic choice and this is
what makes that choice safe to live with.

Masking of credential and payment fields is not on that list and is not
configurable. It happens in the injected script, before anything is emitted.

## Trust boundary

- The renderer sends a validated Chrome profile id and an import request. It
  never chooses an Electron partition. Main creates the profile id, owns
  partition resolution, performs migration, and returns only metadata and counts.
- Raw cookies, passwords, tokens, encryption keys, and storage values never enter
  renderer state, logs, workspace snapshots, or IPC results.
- Chrome is never mounted as a live Electron partition and no source file is
  modified. Temporary snapshots are exact app-created paths, removed in `finally`.
- Source filesystem paths never appear in results. This extends to copied files:
  LevelDB's own `LOG` files embed absolute source paths and must be excluded from
  any directory copy.
- The observation script is injected as a guest `preload`. It runs with
  `contextIsolation` on and node integration off, exposes no capability to the
  page, and emits only structured, pre-masked events. This is a deliberate change
  to `will-attach-webview`, which currently deletes the guest preload outright;
  the security posture it enforces must be preserved by construction, not lost
  with it.
- Tier 2 never leaves the machine, is never included in a workspace snapshot, and
  is never sent to an agent wholesale — an agent receives scoped answers to
  queries, not the stream.

## Import categories

Every result carries a truthful per-category status (`imported`, `partial`,
`empty`, `unsupported`, `failed`) plus non-sensitive counts.

| Category | v3 behavior |
|---|---|
| Profile name, avatar, account hint | Create profile metadata and provenance. The avatar is already discovered and must actually be rendered; a Chrome directory key like `Profile 3` is never shown to a human. |
| Cookies | Decrypt portable v10/v11 through the Keychain and re-save through Electron. Read the Safe Storage password **once per batch**, not once per profile. App-bound values remain unsupported. |
| Local Storage | **Copy the LevelDB directory into the fresh partition, behind a format gate.** *Shipped.* Measured as portable: identical comparator, identical schema version, values are plain UTF-8 with no V8 serialization. This is where SPA and OIDC auth tokens live, so cookies alone do not restore a logged-in state for token-based sites. |
| IndexedDB | **Not copied.** Measured as destructive: Chrome writes a newer V8 wire format than the pinned Electron, and opening such a store wipes and rebuilds it silently, with no error raised. Reported `unsupported`. |
| Session Storage | Not copied. Keyed by per-session namespace GUIDs that mean nothing in the destination. |
| History, favicons, bookmarks | Imported into Tacit-owned browsing metadata that powers address-bar suggestions. Read-only: Tacit never becomes a second place to maintain bookmarks. |
| Cache, code cache, service workers | Not copied; they rebuild after navigation. |
| Quota manager / storage buckets | Not copied; only carries what we are not copying. |
| Chrome `Preferences` | Never copied. Electron's file of the same name is an unrelated three-key file. |
| Saved passwords | **Cut.** See "Not built". |
| Open tabs | Offered after import as canvas nodes. |
| Passkeys, payment methods, extensions, device-bound tokens | Never copied. The UI states which sites will need one fresh sign-in. |

### Measured: what cookies alone already restore

Google is a cookie session, not a token one. A cookies-only import (before site
storage shipped) signed a profile into Google and Gmail: 21 `google.com` cookies
written in one second by the import, and `__Secure-1PSIDTS` minted by Google on
the next page load from the imported `SID`. The rotating `PSIDTS` cookies are
re-issued server-side and are neither importable nor needed.

So site storage is not what unlocks Google, and the import copy must not claim
it is. Its value is the token-based sites that keep credentials in
`localStorage` rather than cookies, plus per-site app state — drafts,
preferences, last-opened — that makes a restored profile feel continuous rather
than merely authenticated.

A corollary worth stating because it looks like a bug: a Chrome profile that is
signed out of Google imports as signed out. Two of the eight profiles on the
development machine had no `PSIDTS` at all, and the first import test picked one
of them.

### The format gate

The copy proceeds only if the source MANIFEST declares LevelDB's default
`leveldb.BytewiseComparator`. That name is fixed in LevelDB's own source rather
than chosen by Chromium, so every Chromium linking LevelDB writes it for Local
Storage and comparing against it is comparing against what the destination
writes. It is also what refuses the destructive case: Chrome's IndexedDB is a
LevelDB one directory away, and it declares `idb_cmp1` — verified against real
profiles on disk, not assumed.

The gate is about the honesty of the record, not about preventing damage. An
unopenable database leaves Chromium with empty Local Storage rather than a
broken profile, which is the asymmetry against IndexedDB that makes this copy
worth doing at all. What the gate prevents is provenance reporting `imported`
for a profile that is in fact signed out.

Also excluded from the copy: `LOCK`, which belongs to whichever process opens
the database, and `LOG`/`LOG.old`, which embed absolute source paths.

When the gate refuses, the result is cookies-only with `siteStorage:
unsupported` and a stated reason.

**Not built — the schema-version half.** The design called for stamping the
destination by writing a throwaway entry and reading its version back off disk,
so the gate would stay correct across Electron upgrades without hardcoding
anything. Local Storage has been schema version 1 since M69 and both sides are
far past it, so that check has nothing to catch today. It becomes necessary the
next time Chromium changes the version, and until then a schema mismatch would
be reported as `imported` while the profile came up signed out.

Chrome must be fully quit, since LevelDB holds an exclusive lock — already
enforced once per batch for cookies. The open question of a "no webview is using
partition X" signal is resolved by ordering rather than by a signal: staging runs
before `session.fromPartition`, the only point at which no session can yet have
opened the partition.

## Profile lifecycle

### Source identity

Provenance currently stores only the Chrome directory name, which is
**positional**: `Profile 4` may be a different person next month. The durable key
is a composite fingerprint — per-profile GUID plus profile creation time, with
the directory key kept only as a hint and the account hint stored as a salted
hash, never raw. Re-scanning resolves to a match tier, and a source whose slot has
been reused resolves as **weak**, which disables re-adoption and permits only
import-as-new. Without this, a reused slot pours a different profile's cookies
into an existing one.

The account hint is discovered today and dropped before persistence. It must be
carried into provenance: it is the field that answers "which of my profiles is
this".

### Re-adopt from Chrome

Replaces v2's "incremental update", which is not implementable: Electron's cookie
objects carry no creation or update timestamp, so no per-record recency rule can
be evaluated; absence is ambiguous between logout, expiry, and never-imported; and
a login is a set of cookies plus storage, so cookie-granular merging tears
sessions.

The unit of re-adoption is a **site**. Within a site, replace wholesale; across
sites, only what the user explicitly selects; default selection empty. Sites the
user signed out of in Tacit are recorded as such at the time — an explicit cookie
removal is distinguishable from an expiry — and are suppressed from the default
proposal, requiring individual confirmation, because silently re-authenticating a
deliberate sign-out is a privacy failure, not a convenience.

Chrome-side deletions are never propagated: absence in Chrome is as ambiguous as
absence in Tacit.

**Transaction shape.** Risky work — snapshotting, Keychain access, decryption,
parsing — happens in a fresh scratch partition, so the existing create-then-commit
rollback applies unchanged and the live profile is never touched on failure.
Promotion is then a per-site clear-and-write into the live partition, journaled
per site so an interrupted promotion reports honestly which sites completed. Do
not present promotion as atomic; it is not. Re-adoption is refused while a node
is loaded on that profile, since a live page will write cookies underneath it.

### Deletion

Deleting a profile must actually erase it. `clearStorageData()` leaves the
partition directory, auth cache, and transport-security state behind, while the
confirmation copy promises data is "erased". Deletion clears storage, auth cache,
code cache and host-resolver cache, then reaps the directory at next start, and
**persists the removal before wiping** so a crash cannot resurrect a profile whose
data is already gone. Provenance does not survive deletion; a tombstone naming an
imported account is a new privacy artifact created by the delete flow.

### The orphan problem

Every legacy restore path currently resets the profile list to the built-in one,
so opening an older workspace drops every imported profile from the UI while its
partition — holding real logins — stays on disk permanently, unreachable and
unerasable. Main must own a **partition registry in userData** as the authority
for what exists on disk, diffed against the workspace at startup, surfacing
orphans for restore or erasure. Deleting must not be optional while forgetting is
silent.

Provenance parsing must also degrade per-field. It currently requires an exact
category count, so adding a category silently destroys all provenance on the next
load — including the fingerprint the whole lifecycle depends on.

## Agents and profiles

An agent working in an imported profile can do anything the user can: send mail
as them, post as them, spend their money. That is a real escalation over an
agent driving an empty browser, and it arrives the moment adoption works. So
which profile an agent acts as is a permission question, not a defaulting
question, and it is answered in two places with two different scopes.

**Global, at import: may agents work as this profile at all?** A per-profile
toggle, editable at any time in the profile manager, applying to every canvas
immediately. It restricts *agents only* — the user can always open a node on any
profile themselves. That asymmetry is the point: a personal mailbox stays one
click away for its owner and permanently out of reach for an agent.

The toggle arrives **on**. Off-by-default is the safer setting and is the one
this document originally argued for; the product decision is that a first agent
browser task hitting a permission wall is the worse failure. The mitigation is
placement rather than default: the toggle appears on the import result row, so
the choice is made while the user is already reviewing each profile, not
discovered later in a settings screen.

**Per canvas, at first use: which allowed profile is the default here?** Asked
once, the first time an agent needs a browser on a canvas — never during import.
The default is per-canvas but import is global and one-off, so asking at import
means answering a question about a canvas that does not exist yet, inside a flow
that is already heavy enough to be clicked through. Asked in place, on a canvas
that is usually one kind of work, the answer is obvious. If only one profile is
allowed, nothing is asked.

### Resolution

Most specific intent wins:

1. The agent named a profile.
2. The agent is already driving a browser node — use that node's profile, so a
   task that started in one identity stays in it.
3. The canvas default.
4. Exactly one allowed profile holds a session for the target site.
5. Guest, stated out loud.

With one refinement at (3): the canvas default wins **unless it has no session
for the site and exactly one other allowed profile does**, in which case that
profile is used and the reason is reported. Explicit intent normally beats a
heuristic, but not when following it produces the signed-out page this whole
project exists to prevent.

Whatever is chosen is visible: the node shows the profile it opened as, and the
agent states it in its reply. Silent selection is how a signed-out node reaches
a user who assumed otherwise.

### Revocation

Turning a profile off stops agents from starting **any new action** on it,
across every canvas and node, at once. Actions already in flight cannot be
recalled — that limit is stated rather than papered over with a claim of
atomicity the implementation cannot keep.

Nodes are not destroyed. Revoking means agents may no longer act as this person;
it does not mean erasing the page. The node keeps its session and becomes the
user's alone, to finish by hand or close. Destroying it would discard work and
punish the user for tightening a permission.

Agents receive a typed refusal naming the cause, so a revoked profile reports as
a stuck task rather than an inexplicable failure — the same discipline the
assignment contract applies elsewhere. On resume, the offer is to restart the
work as another profile or for the user to take it over; it is never presented
as continuing, because a workflow half-completed as one identity does not
continue as a different one.

## Staying inside

These are not polish. Each one is a mechanism that moves work out of the record.

- **Popups must open as canvas nodes.** Every window-open request is currently
  denied and handed to the system browser, so every `target="_blank"` link ejects
  the user and ends the observed session. This is the single largest hole.
- **Sign-in that cannot happen inside must round-trip.** Google, Microsoft and
  Apple sign-in are redirected to the system browser by design, because embedded
  Chromium is refused by those flows. That ejection is unavoidable, so it must be
  *closed*: an inline banner in the node offering "Sign in with Chrome", followed
  by "Re-adopt this site from Chrome" to bring the resulting session back in. This
  is the repair path for an unavoidable hole, and it is why re-adoption is a core
  step rather than a late convenience.
- **Address-bar suggestions from imported history and bookmarks.** Typing a full
  URL is friction that sends people to Chrome. New nodes must not open on a
  hardcoded search page.
- **Context menu, find-in-page, zoom, downloads, and a focus shortcut.** Their
  absence reads as broken and is individually cheap.
- **Discoverability.** The command palette matches none of "chrome", "import", or
  "profile" today.
- **Never silently change the default profile.** Importing currently reassigns it
  to whichever source happened to be last in the batch.

## Browser surface direction

**Managed nodes stay on `<webview>`.** v2 scheduled a migration to
`WebContentsView`; it is removed from this plan for three independently
sufficient reasons:

1. The canvas zooms from 0.1x to 2x. A webview is scaled visually by the
   compositor; a `WebContentsView` has no visual scale, only bounds and a zoom
   factor that reflow the page and cannot reach the low end at all. Zooming out
   would change what pages render, not merely their size.
2. Main-process identity behavior — user-agent normalization and the
   embedded-auth redirect — is gated on the contents being a webview, and would
   silently stop applying. That is an identity-semantics change, and it breaks
   sign-in.
3. Native views composite above all renderer content, so wires, drawings, labels,
   menus, toasts and the profile picker would disappear behind pages.

A fourth reason now outranks the rendering ones: **the guest `preload` is the
observation hook.** The sensor depends on an injection point that a DOM-embedded
webview provides directly.

If the surface is ever revisited, it is a standalone spike answering a product
question first — what a browser card should look like at 0.3x zoom, and what
happens to everything drawn over it. Independent of that, partition attachment
should move out of JSX and behind a surface module, and the adapter registry
should dispatch on engine rather than backend kind so two engines can coexist.

## Build order

The sensor and the comfort work share one hook — the injected script that lets a
popup become a canvas node is the script that observes a click — so they ship
together rather than in sequence.

1. **Foundation.** One profile per imported source, isolation, rollback.
   *Shipped, with outstanding defects listed below.*
2. **The page bridge.** Guest preload with a strict boundary; popups become canvas
   nodes; interaction events and masked page text flow to tier 2; tier 1 gains
   referenced browser entries. Context menu, find-in-page, zoom, downloads.
3. **Sessions that survive.** Cookies once per batch, plus gated Local Storage.
   Pre-flight for Chrome-must-quit, announced Keychain prompt, streamed
   per-profile progress, truthful failure reasons.
4. **Open tabs onto the canvas.** The receipt: import currently produces one line
   of text and no visible change.
5. **Address-bar suggestions** from imported history and bookmarks.
6. **Re-adopt from Chrome, per site** — the repair path for forced ejections.
7. **Agents and profiles.** The permission model above: the global allow-list
   and its import-row placement, the per-canvas default asked once at first use,
   the resolution cascade, `spawn_browser` gaining a profile and a tool to list
   permitted profiles, revocation, and the profile shown on the node. Ordered
   here because it is what lets an agent do the user's real work rather than
   demonstrate on a signed-out page.
8. **Recall over browsing.** Extend the existing recall layer to query tier 2:
   what was worked on, where work repeats, what an agent needs to act.

## Acceptance criteria

1. Importing profile A writes only to A's new partition; the built-in profile is
   byte-for-byte untouched. Importing A and B produces two isolated profiles, and
   a cookie written in A is absent from B — asserted against real partitions, not
   a mocked session factory.
2. A failed profile import clears its fresh partition and registers no profile;
   other profiles in the same batch may still succeed.
3. A profile whose cookies are entirely protected or expired still becomes a
   usable profile with a truthful category status, and is never destroyed.
4. Local Storage import is gated on the comparator declared by the source, a
   gate failure degrades to cookies-only with an honest status, and a copy that
   cannot finish leaves no partial database behind.
5. Duplicate names are deterministically disambiguated. Provenance, including the
   source fingerprint and account hint, survives snapshot save and restore, and
   degrades per-field rather than all-or-nothing.
6. Every partition ever created is reachable from the userData registry, and
   orphans are surfaced at startup.
7. Deleting a profile erases storage, auth cache, code cache and host-resolver
   cache, persists the removal before wiping, and reaps the directory.
8. Results never contain cookie values, passwords, tokens, keys, storage values,
   or source filesystem paths.
9. Credential and payment field values never appear in tier 2, asserted at the
   injection layer. Redacted-category sites produce tier 1 entries and no tier 2
   text.
10. A popup opens as a canvas node rather than ejecting to the system browser.
11. An agent cannot open or drive a node on a profile that is not allow-listed,
    including by naming it explicitly. Revoking a profile stops new agent
    actions on it everywhere without destroying any node, and the refusal names
    the cause. The user's own access is unaffected by the allow-list.
12. The profile an agent resolved to is visible on the node and stated in the
    agent's reply, including when it fell through to Guest.
13. Existing profiles, connected tabs, browser cards, snapshots and old
    workspaces continue to work.
14. Typecheck, browser tests, full suite, production build, and a **packaged-app
    smoke test** pass before a build is handed off. The packaged smoke test has
    never yet been run and is not closed by the green suite.

## Not built

| Thing | Why not |
|---|---|
| Saved passwords and autofill | Cookies carry existing logins; passwords matter only for new ones, and new sign-ins on the major providers are redirected to Chrome, where Chrome's own password manager already fills them. Highest liability in the plan, for the long tail Chrome handles anyway. Replaced by the sign-in round-trip. |
| Per-cookie incremental merge | No timestamps to compare, ambiguous absence, torn sessions. |
| Propagating Chrome-side deletions | Indistinguishable from never-imported; would silently sign the user out. |
| IndexedDB migration | Measured silent data loss. A record-level migration would require driving a Chromium of the source version. |
| Full replayable session capture | Deterministic replay needs stable element targeting and breaks when pages change. Re-running a workflow is done by an agent re-performing it from the record, using the existing click-by-selector and script-evaluation primitives — not by a player replaying a DOM. |
| History page, bookmark manager, bookmark editing | Tacit consumes this data for suggestions; it never becomes a second place to maintain it. |
| Background watcher on Chrome's profile directory | Holds a read handle on another app's data; every actionable case is discoverable when the manager opens. |
| Time-based staleness nagging | Trains dismissal. Prompt on an observed sign-in failure instead. |
| Auto-deleting unused profiles | They hold real credentials. Suggest, never act. |

## Outstanding defects in shipped code

- An import row can display a name the store then disambiguates, so the result
  claims a profile name that does not exist.
- A failed deletion's error renders behind the confirmation dialog's overlay, so
  the user sees the button return from busy with no visible reason.
- `resolveIdentityClearPartition` validates grammar but not length.

## Open decisions

1. **The repo currently argues against this project.** `electron/external-url.ts`
   states in comments that decrypting another browser's local cookie store is the
   technique credential-stealing malware uses, and that the correct replacement is
   a real OAuth flow. Profile adoption does exactly the disavowed thing. This is
   defensible for a user importing their own profile behind an explicit Keychain
   grant, but it must be the stated position rather than two contradictory ones in
   one codebase. It affects notarization posture and security review.
2. **Grafting a live session may sign the user out of Chrome.** Services that
   rotate refresh tokens can invalidate the original session when the same one is
   used from a second client. Untested. It must be exercised against real sites
   before Local Storage import ships, and disclosed in the import copy if it
   reproduces.
3. **Tier 2 retention.** How long the activity stream is kept, and whether it is
   pruned by age, size, or per-profile. Undecided; it determines the disk
   footprint and the blast radius.
