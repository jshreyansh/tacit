<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.png">
  <img src="docs/logo-light.png" width="96" alt="Tacit">
</picture>

# Tacit

**Your terminals, your agents, and your browser — on one infinite canvas.**

[![GitHub release](https://img.shields.io/github/v/release/jshreyansh/tacit)](https://github.com/jshreyansh/tacit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)]()

</div>

<br>

Tacit spreads your terminals across an infinite spatial canvas — no tabs, no split panes. Drag them around, zoom in to focus, zoom out to see everything at once.

It organises work in a **Project → Worktree → Terminal** hierarchy that mirrors how you actually use git. Add a project and Tacit finds its worktrees. Create a worktree from the terminal and it appears on the canvas immediately.

Alongside the terminals sit **browser nodes** signed in with your own imported Chrome profiles, and **typed connections** that record what one node has to do with another — so the reasoning behind a piece of work survives somewhere other than a transcript.

> **New here?** Read the [**User Guide**](./docs/user-guide.md) — every interaction, every shortcut, and the non-obvious tricks.

---

## Quick start

**Download** — grab the latest build from [Releases](https://github.com/jshreyansh/tacit/releases).

> [!IMPORTANT]
> **Apple Silicon Macs — pick the file with `arm64` in its name.**
> Files without `arm64` are Intel builds. They run under Rosetta 2, but panning and zooming the canvas will lag. To check after installing: open **Activity Monitor**, find Tacit, and read the **Kind** column — it should say **Apple**.

**Build from source** — this workspace uses `pnpm`, and `pnpm-lock.yaml` is the canonical lockfile.

```bash
git clone https://github.com/jshreyansh/tacit.git
cd tacit
pnpm install
pnpm dev
```

**Install the CLI** — after launching, go to Settings → General → Command line interface and click Register. This puts `tacit`, `hydra`, and `browse` on your PATH.

Registration also installs Tacit's skills and lifecycle hooks for Claude and Codex. For Codex 0.129.0 and newer, Tacit writes the hook trust state into `~/.codex/config.toml` so the generated hooks stay trusted and keep emitting terminal lifecycle and telemetry events.

---

## What it does

### Canvas

Infinite canvas — pan, zoom, arrange freely. Double-click a title bar to zoom-to-fit. Drag to reorder, box-select many at once, and annotate the canvas itself with the Free Canvas tool so sketches and grouping lines live beside the work. Save the whole layout to a workspace file.

### Coding agents

First-class support for **Claude Code**, **Codex**, **Kimi**, **Gemini**, and **OpenCode**.

- **Glance at a tile and know what it's doing** — a status dot says whether the agent is thinking, waiting on you, idle, or done
- **Pick up where you left off** — close and reopen an agent terminal without losing the conversation
- **Review changes in place** — inline diff cards show an agent's edits without leaving the canvas

### Browser nodes

Import your Chrome profiles and browse inside the canvas, signed in as yourself. Cookies and site storage are copied once, read-only, and never leave the machine.

Each profile decides for itself whether agents may drive it. Pages visited in a browser node are recorded locally so an agent can be asked about them later — and Settings → Browser shows exactly how much has been recorded, with one button to erase it.

### Typed connections

Draw a wire between two nodes and say what it means: *controls*, *sends replies to*, *writes to*, *hands off to*, *feeds context to*. Some wires run — an agent's answer delivered into a chat page, or appended to a note. Others are recorded and drawn but do nothing yet, and are marked so you can tell which is which at a glance.

### Sessions

Every past Claude and Codex conversation in your projects, organised as projects → worktrees → sessions. Click a row to replay it or jump to the running terminal. Worktrees show live git status.

### Git

Commit history, diff viewer, and live status in the sidebar, so checking what changed never means leaving the canvas.

### Terminals

Shell, lazygit, and tmux terminals sit beside agents on the same canvas. Star the ones you return to (<kbd>⌘</kbd><kbd>F</kbd>) and cycle just those with <kbd>⌘</kbd><kbd>]</kbd> / <kbd>⌘</kbd><kbd>[</kbd>; <kbd>⌘</kbd><kbd>G</kbd> chooses whether you are cycling all terminals, starred ones, or whole worktrees. Custom titles, per-agent CLI overrides, and your preferred size are remembered.

### Usage tracking

What you are spending on Claude and Codex, across projects, broken down by model, with quota meters for the 5-hour and 7-day limits. Sign in to sync across devices.

### Settings

Downloadable monospace fonts · dark and light themes · rebindable shortcuts · adjustable contrast · English and Chinese · in-app auto-update.

---

## CLI

Both CLIs ship with the app. Register them from Settings to use them in any terminal.

### tacit

<details>
<summary>Full command reference</summary>

```
Usage: tacit <group> <command> [args]

Groups:
  project        add | list | remove | rescan
  worktree       list | create | remove
  terminal       create | list | status | output | destroy | set-title
  workflow       Lead-driven Hydra workflow over HTTP (init / dispatch / watch …)
  telemetry      get | events
  pin            add | list | show | update | rm
  browser        add | list | update | rm
  diff           <worktree-path> [--summary]
  state          dump full canvas state as JSON

Common shapes:
  project add <path>
  worktree create --repo <path> --branch <name> [--from <ref>]
  terminal create --worktree <path> --type <claude|codex|shell|…>
          [--prompt <text>] [--parent-terminal <id>] [--auto-approve]
  terminal output <id> [--lines N]              # default 50
  telemetry get --terminal <id>
  telemetry get --workflow <id> --repo <path>
  pin add --title <t> [--body <b>] [--link <url>] [--link-type <type>]

Flags:
  --json    Machine-readable output for any command
```

</details>

```bash
tacit project add ~/my-repo
tacit terminal create --worktree ~/my-repo --type claude --prompt "Audit the auth flow and fix the root cause"
tacit terminal status <id>
tacit telemetry get --terminal <id>
tacit diff ~/my-repo --summary
```

To dispatch a Claude or Codex task, start a fresh terminal with `tacit terminal create --prompt "..."`. `tacit terminal input` is not a supported dispatch path.

<br>

<div align="center">
<img src="docs/hydra-icon.png" width="80" alt="Hydra" />

### hydra
</div>

<br>

Hydra is Tacit's orchestration toolkit for Lead-driven workflows and isolated direct workers. It coordinates **git worktrees**, **assignment and run file contracts**, and the **telemetry truth layer** without taking control away from the agent sessions themselves.

One main terminal owns the workbench, reads the codebase, and decides what happens at each decision point. Worker terminals stay autonomous. Workbench state lives in repo-local `.hydra/workbenches/`, and the contract is on disk: `inputs/intent.md`, `dispatches/<dispatchId>/intent.md`, `report.md`, `result.json`, and `ledger.jsonl`. Terminal prose is advisory; a validated `result.json` is the machine gate.

Role-driven workflows target **Claude and Codex** through the Hydra role registry. If you only need one isolated worker without a Lead-driven DAG, use `hydra spawn`.

The design is inspired by [Anthropic's harness design research](https://www.anthropic.com/engineering/harness-design-long-running-apps) on long-running agent orchestration, adapted for terminal agents where each process is already isolated. For the theory, see [Harness Design from a Distribution Perspective](harness-design-essay.md).

#### Getting started

Run `hydra init-repo` in your project, or click **Enable Hydra** in the worktree header, to sync the Hydra instructions into `CLAUDE.md` / `AGENTS.md`. Then either talk to your main agent or drive the workflow yourself:

> *Write a PRD or describe your requirements, then tell the agent:*
>
> *"Read the Hydra skill. Choose the right mode and complete this task autonomously, based on the PRD in `docs/prd/auth-redesign.md`."*

The main agent should pick the lightest path that fits:

- **Stay in the current agent** — simple or local work, no orchestration overhead
- **`hydra spawn`** — one isolated worker, when the task is clear and self-contained
- **`hydra init` + `dispatch` + `watch`** — a Lead-driven workflow for ambiguous, risky, parallel, or multi-step work

```bash
hydra init-repo

hydra init --intent "Add OAuth login" --repo .

hydra dispatch --workbench <id> --dispatch dev --role dev \
  --intent "Implement OAuth login and the tests that cover it" --repo .

hydra watch --workbench <id> --repo .

hydra dispatch --workbench <id> --dispatch review --role reviewer \
  --intent "Independent review of the OAuth change" \
  --depends-on dev --repo .

hydra watch --workbench <id> --repo .
hydra complete --workbench <id> --repo .
```

Role files choose the CLI, model, and reasoning profile. The caller chooses the `role`; Hydra resolves the terminal from that role's definition. Roles resolve project-first: `<repo>/.hydra/roles/<name>.md`, then `~/.hydra/roles/<name>.md`, then the built-ins.

<details>
<summary>Full command reference</summary>

```
Usage: hydra <command> [options]

Lead-driven workbench:
  init        Create a workbench context
  dispatch    Dispatch a unit of work into a workbench
  watch       Wait until a decision point is reached
  redispatch  Re-run an eligible/reset dispatch
  approve     Mark a dispatch output as approved
  reset       Reset a dispatch (and downstream by default) for rework
  ask         Ask a completed dispatch a follow-up question via session resume
  merge       Merge completed parallel dispatch branches
  complete    Mark a workbench as completed
  fail        Mark a workbench as failed

Inspection:
  status      Show structured workbench + assignment state
  ledger      Show workbench event log
  list        List direct spawned agents (pass --workbenches for workbenches)
  list-roles  Show available role definitions

Housekeeping:
  spawn      Create one direct isolated worker terminal
  cleanup    Clean up workbench state or direct spawned workers
  init-repo  Sync Hydra instructions into CLAUDE.md and AGENTS.md
```

</details>

<details>
<summary>Example commands</summary>

```bash
# Repo setup
hydra init-repo

# Start a Lead-driven workbench
hydra init --intent "fix the login bug" --repo .

# Dispatch a unit of work and wait for the decision point
hydra dispatch --workbench <id> --dispatch dev --role dev \
  --intent "Fix the login bug and add regression coverage" --repo .
hydra watch --workbench <id> --repo .

# Ask a completed dispatch a follow-up without re-running it
hydra ask --workbench <id> --dispatch dev \
  --message "Why did you change the session validation path?" --repo .

# Send a dispatch back for rework
hydra reset --workbench <id> --dispatch dev \
  --feedback "The fix regressed the refresh-token path. Rework it." --repo .
hydra redispatch --workbench <id> --dispatch dev --repo .

# Direct isolated worker
hydra spawn --task "investigate the flaky CI failure" --repo .

# Inspection
hydra status --workbench <id> --repo .
hydra ledger --workbench <id> --repo .
hydra list --workbenches --repo .
hydra list-roles --repo .

# Cleanup
hydra cleanup --workbench <id> --repo . --force
hydra cleanup <agent-id> --force
```

</details>

Workbenches advance on validated `result.json` evidence inside `.hydra/workbenches/`. The telemetry truth layer supplies real-time `turn_state`, `last_meaningful_progress_at`, `derived_status`, and session attachment data, used by both the UI and Hydra's watch, retry, and health-check paths.

**Typical workflow:** write a PRD → run `hydra init-repo` once → let the Lead choose direct work, `spawn`, or `init`/`dispatch`/`watch` → monitor with `hydra watch` or the canvas → read `report.md` before approving, resetting, or completing. See the [Hydra Orchestration Guide](docs/hydra-orchestration.md) for control-plane details and the [Panoramic Flowchart](docs/hydra-panorama-flow.md) for the state and file model.

---

## Find your way around

A map of where each feature lives. Every shortcut is rebindable in **Settings → Shortcuts** (Windows and Linux use <kbd>Alt</kbd> in place of <kbd>⌘</kbd>).

**Discovery — when you don't know where something is**

| Shortcut | Surface | What it's for |
|---|---|---|
| <kbd>⌘</kbd><kbd>P</kbd> | Command Palette | Run any in-app action by name |
| <kbd>⌘</kbd><kbd>K</kbd> | Global Search | Files, terminals, sessions, branches, commits, memory |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>J</kbd> | Hub | Live terminals, recent activity, waypoints, pinned items |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>/</kbd> | Status Digest | The 3–5 most relevant signals across the canvas |

**Canvas navigation**

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>E</kbd> | Toggle focus — zoom into the focused terminal, or out to fit |
| <kbd>⌘</kbd><kbd>0</kbd> · <kbd>⌘</kbd><kbd>1</kbd> · <kbd>⌘</kbd><kbd>=</kbd> · <kbd>⌘</kbd><kbd>-</kbd> | Zoom: fit · 100% · in · out |
| <kbd>⌘</kbd><kbd>]</kbd> / <kbd>⌘</kbd><kbd>[</kbd> | Next / previous terminal (or worktree / starred — see <kbd>⌘</kbd><kbd>G</kbd>) |
| <kbd>⌘</kbd><kbd>G</kbd> | Cycle focus level (terminal → worktree → starred) |
| <kbd>⌘</kbd><kbd>F</kbd> | Star / unstar the focused terminal |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>1</kbd>–<kbd>9</kbd> · <kbd>⌥</kbd><kbd>1</kbd>–<kbd>9</kbd> | Save / recall a spatial waypoint (per project, 9 slots) |
| <kbd>⌥</kbd><kbd>\`</kbd> | Pan to whichever terminal produced output most recently |
| <kbd>V</kbd> · <kbd>H</kbd> · <kbd>Space</kbd>(hold) | Select tool · Hand tool · Temporary pan |

**Multi-canvas**

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>]</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>[</kbd> | Next / previous canvas |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>N</kbd> | Canvas Manager (rename, reorder, switch) |

**Terminals**

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>T</kbd> · <kbd>⌘</kbd><kbd>D</kbd> | New / close terminal in the focused worktree |
| <kbd>⌘</kbd><kbd>;</kbd> | Open composer, or inline-rename the focused terminal |

**Panels and overlays**

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>/</kbd> | Right panel (Files / Diff / Git / Memory) |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>U</kbd> | Usage dashboard |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>H</kbd> | Sessions overlay |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>T</kbd> | Snapshot history |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd> | Activity heatmap |

**Workspace**

| Shortcut | Action |
|---|---|
| <kbd>⌘</kbd><kbd>O</kbd> | Add project |
| <kbd>⌘</kbd><kbd>S</kbd> · <kbd>⌘</kbd><kbd>⇧</kbd><kbd>S</kbd> | Save / save-as a workspace file |
| <kbd>⌘</kbd><kbd>,</kbd> | Settings |

---

## Built with

<table>
<tr><td><b>Desktop</b></td><td>Electron</td></tr>
<tr><td><b>Frontend</b></td><td>React · TypeScript</td></tr>
<tr><td><b>Terminal</b></td><td>xterm.js (WebGL) · node-pty</td></tr>
<tr><td><b>State</b></td><td>Zustand</td></tr>
<tr><td><b>Styling</b></td><td>Tailwind CSS · Geist</td></tr>
<tr><td><b>Auth & sync</b></td><td>Supabase</td></tr>
<tr><td><b>Build</b></td><td>Vite · esbuild</td></tr>
</table>

**Acknowledgements** — [lazygit](https://github.com/jesseduffield/lazygit) is integrated as a built-in terminal type for visual git management on the canvas.

---

## Roadmap

Tacit is growing from a local desktop tool into a cloud-native development platform.

### Cloud runtime

Move execution off your machine. Spin up agents on remote runtimes with full git, toolchain, and dependency support, while the canvas stays the single pane of glass.

- **Hosted agent execution** — delegate Claude, Codex, and other agent tasks to cloud workers
- **Persistent remote sessions** — close your laptop; the agents keep working
- **Parallel cloud workers** — scale Hydra workflows beyond local terminals

### Automated pipeline

- **Intent → Plan → Implement → Review → Merge**, automated end to end
- **Continuous loop** — agents plan, implement, self-review, and iterate until the result meets acceptance criteria
- **Pipeline as code** — reusable templates for bug triage, feature work, migrations, refactors
- **Human checkpoints** — approval gates at any stage

---

## Licence and credits

MIT — see [LICENSE](LICENSE).

Tacit began as a fork of [TermCanvas](https://github.com/blueberrycongee/termcanvas) by blueberrycongee and is distributed under the same licence. The upstream copyright notice is preserved in [LICENSE](LICENSE), and the original project READMEs are kept verbatim in [`docs/upstream/`](docs/upstream/).
