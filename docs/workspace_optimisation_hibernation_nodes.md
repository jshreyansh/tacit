# Workspace optimization: hibernating idle nodes

**Status: deferred, not started.** Written up so the design isn't lost —
build this when the trigger conditions below are actually met, not before.

## The problem

Electron gives each browser card `<webview>` its own Chromium renderer
process, and each terminal its own PTY. As a workspace accumulates many
terminals and browser cards over a long session, that adds up to real memory
pressure — a genuine concern on a base MacBook (8–16GB), not a hypothetical
one, once Tacit has real users running real workloads.

This was raised in the context of "should we migrate off Electron (e.g. to
Tauri/Rust) for performance." Conclusion: **no, not for this reason** — a
full rewrite is months of work rebuilding a mature codebase (PTY management,
the MCP bridge, session/state persistence, the API server) on a *less*
mature multi-webview foundation than Electron already provides, to fix a
problem that's solvable with a much smaller, targeted change: hibernating
nodes nobody is looking at and nothing is using.

## Why the obvious trigger (app/window focus) is wrong

The first instinct — hibernate when Tacit loses OS focus or you switch
windows/apps — is actively dangerous, not just an optimization. Terminals
often run agents doing real work *specifically while the user isn't
watching* (the entire point of background agents: let Claude keep coding
while you check Slack). Hibernating on focus loss would kill an
actively-running agent mid-task the instant the user alt-tabs away — a much
worse outcome than the memory it would save.

## The correct trigger: idle time, not visibility

Hibernate a node only when **both**:
1. It's off-screen (or its canvas isn't the active one), **and**
2. It has been genuinely idle — no agent turn in progress, sitting at a
   finished/waiting prompt — for a long grace period (**hours**, not
   minutes).

A node that's off-screen but actively running is never touched, regardless
of how long it's been off-screen. This needs the terminal's existing
running/idle/waiting-for-permission status as an input, combined with a new
per-node idle timer.

## State-fidelity limits (calibrate expectations, don't oversell "identical")

"Exactly the same when I come back" has real technical limits depending on
node type:

- **Claude/Codex/Gemini terminals**: can genuinely resume — the app already
  has session-resume plumbing for these agent types, so this comes back
  close to identical (real conversation continuity).
- **Plain shell terminals**: a fresh shell can restore the working directory
  and replay the visible scrollback text, but not live process state (env
  vars set at runtime, etc.) — looks the same, isn't the same process.
- **Browser cards**: can restore the URL and reload (the `key={identityId}`
  remount trick already used elsewhere in `BrowserCard.tsx` is the same
  mechanism needed here), but not in-page state (scroll position, form
  inputs, unsaved JS app state) — a fresh page load, not a true freeze.

## Scope, if/when this gets built

- **Off-screen+idle hibernation for terminals** (within the active canvas):
  medium — new idle-time tracking, a threshold/timer system, hibernate +
  respawn-with-resume logic (careful with the shell-vs-agent-type asymmetry
  above). A real build-test-fix cycle, not a quick patch.
- **Same for browser cards**: smaller — reuses the existing webview remount
  pattern, mostly needs to share the idle-tracking plumbing built for
  terminals.
- **Making canvas-switching itself hibernate-gracefully** — out of scope for
  a first pass. Right now switching canvases already does a blunt
  destroy-and-rebuild of every terminal (see `canvasSceneIO.ts`'s own doc
  comment, which explicitly defers this as future work because it's
  entangled with the snapshot/save pipeline). Don't bundle this in; it's a
  separate, riskier expansion.

## Why later, not now

This solves a problem being anticipated at scale, not one actually being hit
today — unlike the canvas-clutter/legibility pain, which is a real, current
daily friction. It's also not free to build correctly (real edge cases, a
genuine testing cycle). Build this when either:
- Your own usage starts actually straining your Mac's memory with many open
  tiles, or
- Real users hit it and it becomes a validated complaint, not a guess.

Until then, prioritize product/legibility work over this.
