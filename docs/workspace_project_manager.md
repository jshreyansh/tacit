# Workspace Project Manager — giving Hydra's Lead a canvas presence

Status: **in design, not yet implemented.** Captures decisions made so far;
open questions are marked explicitly. Written as a living doc — update in
place as the design firms up, don't fork a v2 file.

## The idea in one paragraph

Right now every node on the canvas is a peer — terminals and browsers can
message each other (`emit_event`) and leave each other durable notes
(`remember`), but nothing has authority over the *shape* of the workspace
itself. The ask is a privileged role — a "workspace manager" — that you
describe things to in plain language, and it composes the canvas: spawning
terminals/browsers/notes, wiring connections between them, and (eventually)
building automations out of lightweight monitor/trigger/function nodes,
n8n-style. You connect an existing agent (Claude Code, Codex, Gemini) to
this role rather than us building a bespoke agent from scratch.

## Key discovery: this builds on Hydra, not from scratch

This codebase already has a **Lead role** in `hydra/src/roles/builtin/lead.md`:
"the human's primary conversation interface... holds system-level context,
dispatches roles based on task needs, reads every report." It already:

- Resolves to multiple underlying CLIs per role (`terminals: [{cli: claude,
  ...}, {cli: codex, ...}]` — `dev`/`qa`/`designer`/`reviewer` roles already
  do this; `AgentType` in `hydra/src/assignment/types.ts` is
  `"claude" | "codex" | "kimi" | "gemini"`, so Gemini is a first-class type,
  just not yet listed on any builtin role file).
- Has a full dispatch/decision loop (`hydra dispatch` → `hydra watch` →
  `dispatch_completed`/`dispatch_failed`/`stall_advisory`/etc.), retry
  budgets, and a file-evidence contract (`workbench.json`, `ledger.jsonl`,
  `report.md`, `result.json`) that's more rigorous than anything we'd design
  fresh in a first pass.
- Already has an explicit three-way mode-selection instinct baked into its
  own docs: work directly / `hydra spawn` one isolated worker / full
  `hydra init → dispatch → watch` for ambiguous or parallel work. That's
  effectively the same judgment call our "auto mode" PM needs to make about
  when to spawn a full node vs. just answering directly.

**Correction after reading further — dispatched workers already have canvas
presence.** When Hydra dispatches through the Tacit runtime (not the
standalone/raw-subprocess one), it calls `terminal create --parent-terminal
<id> --workflow-id <id> --assignment-id <id>` — a real terminal card gets
created in the running app, linked to its parent. `src/components/
FamilyTreeOverlay.tsx` already renders this: parent→child terminal lineage,
per-agent-type colors (claude/codex/gemini/kimi all already defined), live
status dots. So "give dispatches a body" is not the gap — they already have
one, via a spawn-lineage tree that's a separate visual grammar from this
session's `ConnectionLayer` peer-to-peer wire+pulse system.

**What's actually missing** (narrower than first thought):

- **Persistent, always-locatable Lead identity.** Today the Lead is just
  "whichever terminal you're currently talking to," not a durable role-
  designation with a fast-travel affordance back to it.
- **Continuity across swapping the underlying CLI.** Claude/Codex/Gemini
  session formats are foreign to each other — nothing bridges them today.
- **Ledger/reports aren't visible in the Memory tab.** `ledger.jsonl` and
  `report.md` are file-only; no UI surfaces them the way Memory does.
- **No MCP tool surface.** Hydra only works via raw shell commands typed by
  the Lead in its own terminal — fine for the Lead itself, but not
  queryable/composable the way MCP tools are.
- **Open question, not necessarily a gap:** should Hydra's parent→child
  dispatch tree also participate in `ConnectionLayer`'s wire+pulse system,
  or stay a separate, complementary view? Not resolved.

**Scope of this project, therefore:** don't rebuild delegation, retry,
ledger, or the spawn-tree visualization — all solid, all already built.
Build specifically: a durable Lead/workspace-manager identity that survives
CLI swaps (backed by the workspace memory scope), a mirror of Hydra's
ledger/reports into that memory scope so it's visible in the Memory tab, and
the small MCP tool surface for canvas-native asks Hydra has no concept of
(querying/wiring nodes directly, outside a formal dispatch).

## Decisions confirmed so far

- **PM is a role, not a new node type.** You designate an existing terminal
  (Claude Code, Codex, or Gemini — the agent types that can actually hold a
  Hydra role) as the workspace manager. Lazygit/Shell terminals can't hold
  it — they're not agent loops. Swapping which agent fills the role should
  be possible without losing context (see memory/continuity below).
- **One PM per workspace**, to start. Simplest mental model; revisit if it
  turns out project-scoped PMs are wanted later.
- **Modes mirror how the user already works with Claude Code in this
  session**, not a bespoke permission model:
  - **Auto** (default) — acts on judgment, doesn't ask before every step.
  - **Ask** — user-toggleable, more conservative, confirms before acting.
  - **Plan** — auto-detected when the user's phrasing sounds like "plan
    this" rather than "do this," mirrors `EnterPlanMode`.
  - Within Auto, the trust asymmetry that makes "autonomous by default"
    non-reckless: **freely create and wire new nodes without asking**
    (additive, reversible — worst case, select-and-delete). **Always
    confirm before touching a node it didn't create** — killing another
    agent's terminal, deleting a node, or crossing some cost/node-count
    threshold on a single request. This is exactly the asymmetry the
    assistant itself already operates under (free to restart a dev server,
    stops to ask before `git push --force`).
- **Monitor/trigger/function nodes are lightweight and deterministic by
  default**, not mini agents. An LLM call every time a file-watcher trigger
  fires is wasteful and slow — these should be cheap, reliable background
  processes (this codebase already has the right shape internally: a
  git-watcher, a session-watcher). The PM's real job is conducting a mix of
  *expensive* nodes (real agents, real reasoning) and *cheap* nodes
  (watchers, triggers, transforms) — the actual n8n insight is composing
  lots of cheap reliable nodes and spending intelligence only where needed.
- **Continuity lives in memory, not in any one CLI's native session
  format.** Claude Code, Codex, and Gemini each have their own
  session/resume mechanism and none understands another's — so if PM
  identity depended on that, swapping from Claude to Codex would hand the
  new agent nothing. Instead: a dedicated **workspace-level memory scope**
  (distinct from the per-worktree memory scope every terminal already gets
  via `getMemoryDirForWorktree` — the PM's job spans the whole canvas, not
  one worktree) that any of the three CLIs can be pointed at. Assigning an
  agent to the PM role means briefing it: "you are the workspace manager,
  here is your memory directory, read it to know what's already happened."
- **The PM journals continuously, not opportunistically.** The existing
  `remember` MCP tool is opt-in — a terminal calls it when it decides
  something's worth saving. For the PM, the default flips: every node it
  spawns, every wiring decision, every dispatch outcome gets written as it
  happens. That's what makes an agent-swap actually work — a fresh agent
  dropped into the role reads the journal and picks up genuinely current
  context, the way a new hire reads the project files instead of starting
  cold. Hydra's own `ledger.jsonl`/`report.md` are the natural upstream
  source for a lot of this — worth mirroring into the workspace memory
  scope's format rather than inventing a second, parallel log.
- **Form factor: a pinned "Project chat" pill, not a spatial-only node.**
  Reference: a competing canvas-of-agents app (screenshots reviewed
  2026-08-07) that pins a persistent, low-chrome chat bar at the bottom of
  the screen — always reachable regardless of canvas clutter — separate
  from the many individually-named worker terminal cards scattered around
  it. Adapted for this app:
  - The pill lives in the existing `BottomToolbar.tsx` pill row (`PILL_GLASS`
    styling, alongside Fit / Focus) — no new chrome invented, reuses what's
    already there. Shows current agent: `Project chat · Claude Code`, a
    dropdown to reassign (Claude/Codex/Gemini), a chevron to
    collapse/expand.
  - **Hard constraint: the pill is a lightweight front-end onto the exact
    same PTY/session as the PM's canvas terminal card — one identity, one
    memory scope, one continuity. Never two independently-drivable chat
    surfaces for "the same" PM** — that would immediately break the
    swap-continuity design above.
  - **Scope switch via the same drag-a-wire gesture the canvas already
    teaches for connections:** unconnected pill = default, PM reasons/acts
    at workspace scope. Drag a wire from the pill to a specific node =
    focused mode, composer now routes through a PM-privileged
    `send_prompt_to_node` scoped to just that connection instead of the
    broad path. No new interaction paradigm, reuses `connect_nodes`/
    `ConnectionLayer` directly.
  - **Keep dispatched workers visibly tied back to the PM** — the reference
    app's worker terminals (many, generically named) have no visible line
    back to its chat pill, which is a legibility gap worth not repeating.
    `FamilyTreeOverlay`'s parent→child lineage already exists for this
    (Hydra dispatches already pass `--parent-terminal`) — use it.
  - Minimize/collapse behavior for the PM's canvas card specifically:
    **explicitly deferred, not decided now** — this app already has a
    `minimized` terminal state (`buildLayoutKey` in `XyFlowCanvas.tsx`
    already serializes `t.minimized`), so it's likely close to free once
    everything else is built, but not worth resolving before then.
- **Approval-queue for existing-node mutations** — designed as a *general*
  primitive, not delete/move-specific, since Ask mode needs the same
  mechanism for every action, not just ones touching pre-existing nodes:
  - Mutating tool calls that need approval don't block — server stores the
    exact action + params as a `PendingApproval` and returns immediately;
    the PM is never left hanging waiting on the human.
  - Three coordinated UI layers, not one: an ambient toast via the existing
    `notificationStore.ts` (alert), a persistent toolbar badge/list (survives
    you missing the toast or being elsewhere — clicking an entry flies to it
    via the existing `flyToBounds`/Focus View camera primitive), and a
    spatial highlight directly on the target node itself (pulsing outline +
    inline Approve/Deny chip — this is the one that matters most given this
    app's spatial-legibility thesis).
  - On approve: the server executes the *exact stored* action, not a
    PM-issued re-request — avoids a race between "PM asked" and the
    workspace having moved on since.
  - On deny: optional freeform feedback, same shape as Hydra's own
    `hydra reset --feedback` — not a bare no.
  - The PM is woken up with the result through the same channel
    `emit_event` already uses — a new prompt injected via
    `composer-submit.ts`, no new wake-up mechanism.
  - Two deliberate simplicity choices for v1: **no "always allow this
    action type, don't ask again"** (would quietly disable Auto mode's only
    safety net), and **stale/unactioned requests default-deny on a timeout**
    (~30–60 min) rather than silently firing later against a workspace
    that's moved on.
  - Rough shape: `PendingApproval {id, requestedAt, requestedBy, actionType,
    target, params, description, status}`, a new `approvalQueueStore.ts`
    (same shape as this session's `bridgeActivityStore.ts`), routes
    `POST /node/:kind/:id/request-approval`, `POST /approval/:id/approve`,
    `POST /approval/:id/deny`.
- **MCP tool surface** — extends the existing `browser-bridge` server
  (being renamed **`tacit-bridge`**, confirmed, deferred until
  implementation — it already outgrew the "browser" name once `emit_event`/
  `remember` were added). Hydra's own CLI (`dispatch`/`watch`/`status`/...)
  stays exactly as-is; the PM, being a real terminal agent, already has
  shell access to it directly — no MCP wrapping needed there. New tools are
  specifically the canvas-native surface Hydra has no concept of:
  - **Query (any terminal, always allowed, no approval ever needed):**
    `list_nodes()`, `get_node_state(kind, id)`, `query_memory(query, scope?)`,
    `get_workspace_summary()` — the orientation call a freshly-swapped-in
    agent makes first to pick up real context.
  - **Spawn (PM-only, freely allowed in Auto — additive/reversible):**
    `spawn_terminal({type, prompt?, position?, connectTo?})` (reuses
    `createTerminalInScene` + `composer-submit.ts`), `spawn_browser(...)`
    (reuses `addBrowserCardToScene`), `spawn_note(...)` (reuses
    `createNoteInScene`). Position, if omitted, auto-placed via the
    existing `collisionResolver`.
  - **Wiring (PM-only):** `connect_nodes`, `disconnect_nodes` — freely
    allowed if the PM created that wire itself, goes through the approval
    queue if it predates the PM.
  - **Touching existing nodes (PM-only, approval queue applies):**
    `move_node`, `delete_node`, `send_prompt_to_node` (a PM-privileged
    `emit_event` variant that doesn't require an existing wire).
  - **Journal (PM-only):** `log_activity({event, detail})` — append-only,
    no slug, distinct from the curated/deduped `remember` tool — feeds the
    chronological-feed view being considered for the Memory tab. Better
    than relying on the PM's discipline to call it: **auto-mirror Hydra's
    own `ledger.jsonl`** for any workbench the PM owns straight into the
    workspace journal; `log_activity` covers everything that isn't a formal
    Hydra dispatch.
  - Gated the same way `emit_event`/`remember` already are: a live per-call
    check (is *this* terminal currently the designated workspace manager),
    not session-time tool registration.

## Open questions (still unresolved)

- **Memory tab: graph view vs. a chronological feed.** The existing Memory
  tab renders a graph (nodes/edges from `MEMORY.md` links) — right for "what
  connects to what," not obviously right for "what did the PM do, in what
  order." Does the graph serve well enough, or does the PM's journal need
  its own reverse-chronological feed view, at least for this memory type?
- Whether `spawn_terminal` for a delegated unit of real work should *also*
  register as a proper Hydra dispatch under the hood (retry/decision-loop
  machinery for free) versus being a bare canvas node — likely mirrors
  Hydra's own existing mode-selection judgment (direct work / `hydra spawn`
  / full `hydra init→dispatch→watch`), just with the canvas made to reflect
  whichever path was taken.
- Exact roadmap ordering for monitor/trigger/function node types — which
  ships first.
- Concrete spawn/cost guardrails (how many nodes-per-request before Auto
  mode's "confirm before" threshold kicks in).
- Whether `lead.md` gets edited directly to add Gemini as a third
  `terminals:` option, or whether the workspace-manager role is a distinct
  (but Lead-inspired) role file of its own.
- PM canvas-card minimize behavior — deferred, see above.
