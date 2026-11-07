# Where Tacit falls short as a developer tool (Claude's analysis)

As of 30 Oct 2026, against `main` at 0.42.0 (`a8ef6e6b`). Written from the
brief in `brief.md`, without reading `codex.md`.

**How the sources went:** browsing worked. Claude Code, Codex, Conductor,
Hermes Agent, OpenClaw and Herdr come from their official docs. **T3 Code's
docs site wasn't reachable by search**, so its cells come from its GitHub
README, plus two third-party pages marked as such. Many T3 Code and
Conductor cells are `?` for that reason.

**Herdr** turned out to be herdr.dev: a terminal multiplexer for coding
agents (a background server, a sidebar of agents with their status, agents
messaging each other with `hc`, SSH machines in one sidebar). Apache 2.0.
It says outright "No plugin system".

**One thing frames most of the Extensibility table.** Tacit runs the real
agent CLIs in terminals. So a developer's own Claude Code or Codex skills,
MCP servers, hooks, plugins and slash commands **already work inside a
Tacit terminal**, because the CLI loads them. The gap isn't "they don't
work"; it's that Tacit doesn't show, manage or share them. Cells marked
`ⁱ` mean the feature comes from the underlying agent CLI, with no UI of the
tool's own. That's an inference from how those tools work, not something
their docs state. It applies to Conductor, T3 Code and Herdr too.

## 1. Summary

1. **No undo for an agent's changes.** Claude Code, Conductor and T3 Code
   let you rewind to before a turn. In Tacit, a bad turn means `git`
   by hand. This is the most likely day-one scare.
2. **Parallel agents share one checkout by default.** Tacit has worktrees
   (Hydra makes one per worker, and you can make one by hand), but a new
   agent from the dock starts in the main folder. Conductor, Codex app,
   Claude Code and T3 Code all give each task its own worktree, which is
   the whole point of running agents side by side.
3. **No OS notifications.** "Needs you" is an amber dot inside the window.
   With the window behind your editor, you won't know an agent is
   waiting. Codex, Claude Code, Hermes and OpenClaw all reach you outside
   the app. Small to fix.
4. **Review stops at the diff.** Tacit shows the diff and can commit and
   push, but you can't comment on a line and send it back to the agent,
   open a PR, or see CI. Conductor does all three; it's its core loop.
5. **Skills, plugins and MCP servers: not shown, not managed, not shared.**
   Tacit installs its own seven skills into Claude and Codex, and its own
   MCP server into every agent. There's no screen listing the skills,
   plugins and MCP servers you have, no way to add one once for every
   agent, and OpenCode and Antigravity get none of it. Nobody else does
   "one set for every agent" either. Claude Code and Codex share the
   SKILL.md format, and Hermes follows the agentskills.io standard, so
   this is a real opening, not catch-up.
6. **No setup or run scripts per worktree.** Conductor and the Codex app
   run a setup script (install, copy `.env`) when a worktree is made, and
   a Run button for the dev server. Without it, every new worktree is a
   manual setup.
7. **Memory is Claude's folder, read-only in the UI.** The Memory tab
   reads `~/.claude/projects/<id>/memory`, plus a per-workdesk folder for
   the manager. You can't edit it there, and Codex and OpenCode only reach
   it through Tacit's `query_memory` tool.
8. **Nothing runs without the laptop, and nothing reaches your phone.**
   There's a headless server, but no scheduled runs, cloud runs or phone
   approvals. Claude Code, Codex, Hermes, OpenClaw and T3 Code all have
   some form of it.
9. **No spend caps.** Tacit shows cost and quota well, but nothing stops
   a runaway worker. This is SHR-110, parked in M3.
10. **Tacit is ahead on cross-vendor work:** different agents on one
    canvas, wires and hand-offs between them, browser nodes with your
    real logins, and a full record of what happened. None of the seven
    does all of that.

**Legend:** `✅` has it, `◐` partly, `✗` no, `?` couldn't verify. `ⁱ` means
it comes from the underlying agent CLI (inferred). Numbers in brackets
point to Sources.

## 2. Tables

### Extensibility

| Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
|---|---|---|---|---|---|---|---|---|
| 1. Skills | ◐ seven bundled skills (`skills/skills/`) linked into `~/.claude/skills` and `~/.codex/skills` by `electron/skill-manager.ts` (`installSkillLinks`); yours work ⁱ but aren't shown | ✅ [21] | ✅ [1] | ✅ agent writes its own; agentskills.io [50] | ✅ [60] | ✗ ⁱ [70] | ◐ ⁱ | ◐ ⁱ |
| 2. One set shared by every agent | ◐ only Tacit's own bundle, Claude and Codex only; OpenCode and Antigravity get none (`electron/skill-manager.ts`) | ✗ one agent; plugin directory shared with ChatGPT [21] | ✗ one agent | n/a (one agent) | n/a | ✗ | ? | ? |
| 3. Plugins, with a way to install them | ✗ (Tacit registers itself as a Claude plugin, `registerClaudePlugin` in `electron/skill-manager.ts`, but has no plugins of its own) | ✅ skills, MCP and hooks in one directory [21] | ✅ plugins and marketplaces [2] | ✅ [50] | ✅ ClawHub [60] | ✗ "No plugin system" [70] | ? | ? |
| 4. MCP server management | ◐ its own `tacit` server put into each agent (`shared/agent-adapters.ts`, `tacit-bridge/src/mcp-server.ts`); yours work ⁱ, no UI to add or sign in | ✅ [23] | ✅ [3] | ✅ [53] | ? | ✗ | ? | ? (third-party page mentions an MCP route [82]) |
| 5. Hooks | ◐ installs its own telemetry hooks (`electron/skill-manager.ts`, `CODEX_HOOK_EVENTS`); no hooks of yours | ✅ [22] | ✅ [4] | ? | ✅ with cron and webhooks [60] | ✗ | ? | ? |
| 6. Slash commands, saved prompts | ✅ the chat's slash menu lists skills (`electron/slash-commands.ts`, `src/components/SlashCommandMenu.tsx`) | ✅ [33] | ✅ [5] | ? | ? | ✗ | ? | ? |
| 7. Custom agents or roles | ◐ Hydra roles (dev, reviewer, qa, designer, janitor, lead), from the CLI only (`tacit workflow list-roles`) | ✅ [24] | ✅ [6] | ✅ subagents [50] | ✅ multi-agent routing [60] | ◐ agents start helpers [70] | ? | ? |
| 8. Model and provider choice | ✅ four agent CLIs, model chip per chat (`src/toolbar/chat/ComposerSettings.tsx`); OpenCode reaches any provider | ◐ OpenAI models | ◐ Anthropic, plus Bedrock and Vertex [17] | ✅ any endpoint [50] | ✅ [60] | ✅ any CLI agent [70] | ✅ Claude Code, Codex, Cursor, OpenCode [40] | ✅ six agents [80] |
| 9. Scripting: CLI, API, headless | ✅ `cli/tacit.ts`, `headless-runtime/`, `server/Dockerfile` | ✅ `codex exec`, SDK [31] | ✅ headless, Agent SDK [7] | ✅ CLI [50] | ✅ [60] | ✅ `hc` CLI and socket API [70] | ✅ API [40] | ◐ `npx t3`, `t3 service` [80] |

### Code workflow

| Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
|---|---|---|---|---|---|---|---|---|
| 1. Worktree per task, made and cleaned up | ◐ Hydra workers get `.worktrees/workbench-*` (`electron/agent-folder-trust.ts`), cleaned by `tacit workflow cleanup`; by hand in `src/components/ProjectTree.tsx`; a dock agent starts in the main checkout | ✅ one per chat [26] | ✅ [8] | ? | ? | ✗ | ✅ one per workspace [40] | ✅ `.t3-worktrees/<thread>` [81, unofficial] |
| 2. Diff review, line comments to the agent | ◐ Diff tab (`src/components/RightPanel/DiffContent.tsx`), no comments | ? | ◐ visual diff review in the desktop app [8]; comments unverified | ✗ | ? | ✗ | ✅ [41] | ◐ per-turn diff panel [81, unofficial] |
| 3. Commit, push, open a PR | ◐ stage, commit, amend, push, pull, stash (`electron/preload.ts` `git:*`, `src/components/RightPanel/GitContent.tsx`); no PR | ✅ [26] | ✅ the agent does it [17] | ? | ? | ✗ | ✅ [42] | ◐ "source control" [80] |
| 4. PR status and CI; fixing a check | ✗ | ◐ GitHub review [27] | ◐ GitHub Actions, Code Review [16] | ? | ? | ✗ | ✅ Checks tab [44] | ? |
| 5. Checkpoints, undo a turn | ✗ (`electron/session-fork.ts` forks a Claude conversation, not files; snapshot history is the canvas layout) | ? | ✅ [9] | ? | ? | ✗ | ✅ code and chat [46] | ✅ [81, unofficial] |
| 6. Setup and run scripts per worktree | ✗ | ✅ local environments [26] | ? | ? | ? | ✗ | ✅ setup, run, archive [43] | ? |
| 7. Comparing parallel agents' work | ◐ `tacit workflow merge` (Hydra, CLI only) | ? | ◐ a lead agent merges subagents' work [17] | ◐ parallel subagents [50] | ? | ✗ | ◐ parallel agents [40] | ? |
| 8. Editor or IDE | ◐ in-app editor (`src/components/FileEditorDrawer.tsx`, Monaco); no "Open in VS Code / Cursor" | ✅ IDE extension [20] | ✅ VS Code, JetBrains [17] | ✗ | ✗ | ✗ | ? | ◐ editor reported [80] |
| 9. A review agent | ◐ bundled `code-review` skill (`skills/skills/code-review`), Hydra reviewer role | ✅ `/review`, GitHub [27] | ✅ [16] | ? | ? | ✗ | ? | ? |
| 10. Issue tracker to task | ✗ (tasks are local: `electron/pin-store.ts`) | ◐ GitHub [27] | ◐ Slack and GitHub Actions to PR [17] | ? | ? | ✗ | ✅ Linear issue to workspace [45] | ? |

### Context and memory

| Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
|---|---|---|---|---|---|---|---|---|
| 1. Instructions files | ✅ offers to add AGENTS.md with CLAUDE.md importing it (`electron/project-instructions.ts`, `src/components/RightPanel/InstructionsPrompt.tsx`) | ✅ [20] | ✅ reads AGENTS.md too [10] | ? | ? | ◐ AGENTS.md for its own settings [70] | ◐ ⁱ | ◐ ⁱ |
| 2. Memory you can see and edit | ◐ Memory tab reads Claude's memory folders and a per-workdesk one for the manager (`electron/memory-service.ts`); agents write with `remember`/`log_activity` (`electron/memory-notes.ts`) and read with `query_memory`; not editable in the UI | ✅ [32] | ✅ auto memory [10] | ✅ [52] | ✅ [60] | ✗ | ? | ? |
| 3. Session history: browse, search, resume | ✅ `electron/session-search-index.ts`, `src/components/SessionsPanel.tsx`, resume in `src/terminal/TerminalTile.tsx` | ✅ | ✅ | ✅ full-text cross-session [50] | ✅ [60] | ◐ panes come back, agents don't resume [70] | ? | ? |
| 4. Handing context between agents | ✅ wires and hand-offs (`electron/wire-send.ts`, `electron/wire-mailbox.ts`, `hand_off` in `tacit-bridge/src/mcp-server.ts`) | ◐ subagents [24] | ◐ subagents [6] | ◐ subagents [50] | ◐ routing [60] | ✅ `hc send` [70] | ? | ? |
| 5. Attachments and @-mentions | ✅ in chat (`electron/manager-chat/chat-attachments.ts`, `shared/chat-attachments.ts`) | ✅ | ✅ | ? | ? | ✗ | ? | ? |
| 6. Context usage, compaction | ◐ usage ring in chat (`src/toolbar/chat/LongRunning.tsx`); compaction is the agent's ⁱ | ✅ | ✅ [7] | ? | ? | ✗ | ? | ? |
| 7. Codebase search for the agent | ◐ ⁱ (Tacit's own search is for you: `electron/search-handlers.ts`) | ✅ | ✅ | ✅ tools [50] | ? | ◐ ⁱ | ◐ ⁱ | ◐ ⁱ |
| 8. Settings and history across devices | ✗ (`electron/usage-sync.ts` syncs usage only) | ✅ cloud, mobile [30] | ✅ web, mobile, teleport [14] | ◐ via the gateway [55] | ✅ [60] | ◐ SSH machines in one sidebar [70] | ? (Conductor Cloud announced [40]) | ◐ web and mobile apps [80] |

### Control and safety

| Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
|---|---|---|---|---|---|---|---|---|
| 1. Permission modes, lasting allowlists | ◐ in chat: approval cards, mode kept per agent, Always allow written to the folder (`electron/manager-chat/drivers.ts` `alwaysRules`, `electron/manager-chat/chat-modes.ts`); in a terminal it's the agent's own ⁱ | ✅ [25] | ✅ [12] | ✅ [54] | ✅ tool policies [61] | ✗ | ◐ agent modes [40] | ◐ permission modes reported [82] |
| 2. Sandboxing | ✗ own; the agent's ⁱ | ✅ [25] | ✅ [11] | ✅ Docker, SSH, Modal and more [50] | ✅ Docker, Podman, SSH [61] | ✗ | ? | ? |
| 3. Usage, cost, caps | ◐ cost and quota (`electron/usage-collector.ts`, `src/components/UsagePanel.tsx`, `electron/quota-fetcher.ts`), worker-count cap (`electron/worker-admission.ts`); no spend cap | ? | ✅ cost view [13] | ? | ? | ✗ | ? | ? |
| 4. Notifications | ◐ in-app only: amber dots and toasts (`src/stores/notificationStore`); no OS notification or sound anywhere in `electron/` or `src/` | ✅ [29] | ✅ bell, hooks [4] | ✅ via messaging [55] | ✅ channels [60] | ◐ sidebar and sounds [70] | ? | ? |
| 5. Remote or mobile | ◐ headless server with webhooks (`headless-runtime/`, `headless-runtime/notification-transport.ts`, `server/Dockerfile`); no phone or chat-app access | ✅ [30] | ✅ Remote Control, mobile, Slack [14] | ✅ 15+ messaging platforms [55] | ✅ channels, iOS and Android nodes [60] | ◐ SSH [70] | ? | ✅ iOS, Android, web [80] |
| 6. Runs without the laptop | ◐ headless runtime only; no schedules | ✅ automations, cloud [28] | ✅ cloud scheduled tasks [15] | ✅ cron [50] | ✅ cron, webhooks [60] | ◐ local background server [70] | ? | ◐ background service [80] |
| 7. Secrets kept out | ✅ masked in transcripts, the record and tile titles (`electron/transcript-keeper.ts`, `electron/run-tracker.ts`) | ? | ◐ deny rules for files [12] | ? | ? | ✗ | ? | ? |
| 8. Audit record | ✅ `~/.tacit/record` (`electron/capture-service.ts`, `electron/record-nodes.ts`), with export | ◐ session logs | ◐ transcripts | ◐ | ◐ | ✗ | ? | ? |
| 9. Agent sign-in and accounts | ✗ agents sign in in their own terminal (`src/components/LoginButton.tsx` is Tacit's own account) | ✅ | ✅ | ✅ | ✅ | ✗ | ? | ✗ "installed and signed in first" [80] |

## 3. Added rows

| Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
|---|---|---|---|---|---|---|---|---|
| (added) Several vendors' agents side by side, working together | ✅ canvas, manager, wires (`electron/wire-*.ts`) | ✗ | ✗ | ✗ | ◐ | ◐ side by side, messaging [70] | ◐ side by side [40] | ◐ side by side [80] |
| (added) A browser the agent drives, signed in as you | ✅ browser nodes with Chrome profiles (`electron/browser-profile-sync.ts`, `electron/chrome-login-watch.ts`) | ◐ [20] | ✅ Chrome [17] | ✅ tools [50] | ✅ | ✗ | ? | ? |
| (added) Tasks that say when an agent needs you | ✅ Tasks, Needs you (`src/tasks/`) | ✗ | ✗ | ✗ | ✗ | ◐ status per agent [70] | ◐ todos in Checks [44] | ? |
| (added) Windows and Linux | ◐ targets configured (`electron-builder.yml`), only Mac is built and released | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ Mac only [40] | ✅ [80] |

## 4. Ranked gaps

**P0: a new developer hits it on day one**

1. **Undo an agent's turn.**
   - *Who has it:* Claude Code [9], Conductor [46], T3 Code [81].
   - *Tacit today:* nothing for files. `electron/session-fork.ts` forks a Claude conversation only.
   - *Smallest useful version:* at each turn start (Tacit already sees `turn_started` in `electron/telemetry-service.ts`), save the worktree's state as a git ref, without touching the index or branch. Then add "Undo this turn" on the tile, which restores files to that ref after showing what will change.
   - *Effort:* M.
2. **A worktree per agent, by default.**
   - *Who has it:* Conductor [40], Codex [26], Claude Code [8], T3 Code [81].
   - *Tacit today:* Hydra does it for workers; `tacit worktree create` and `ProjectTree.tsx` do it by hand; the dock doesn't.
   - *Smallest useful version:* "New agent → in its own worktree" in the dock and the manager's `spawn_terminal`, with a branch name from the first prompt. "Done" offers merge, PR or discard, then removes the worktree.
   - *Effort:* M.
3. **OS notifications when an agent needs you or finishes.**
   - *Who has it:* Codex [29], Claude Code [4], Hermes and OpenClaw (by message).
   - *Tacit today:* in-app dots and toasts only.
   - *Smallest useful version:* an Electron `Notification` from main when telemetry's `derived_status` turns to attention or a turn ends with the window unfocused. Clicking it focuses the tile. Add a Settings toggle and a dock badge count.
   - *Effort:* S.

**P1: noticed within a week**

4. **Line comments in the diff, sent back to the agent.**
   - *Who has it:* Conductor [41].
   - *Tacit today:* `DiffContent.tsx` shows the diff only.
   - *Smallest useful version:* comment on a line, then "Send to agent" posts `file:line` plus the comment to that worktree's agent through the existing composer path.
   - *Effort:* M.
5. **Open a PR and see CI.**
   - *Who has it:* Conductor [42][44], Codex [26].
   - *Tacit today:* commit and push in `GitContent.tsx`.
   - *Smallest useful version:* "Open PR" through `gh pr create`. A PR row shows `gh pr checks`, and a failing check has "Send log to agent".
   - *Effort:* M.
6. **Skills and connectors: one screen, shared by every agent.** This is the owner's example, and SHR-84 (T9), parked in M3.
   - *Who has it:* nobody across agents. Claude Code [1][2], Codex [21] and Hermes [50] each have it for themselves.
   - *Tacit today:* its own seven skills, linked into Claude and Codex only; its own MCP server in each agent.
   - *Smallest useful version:*
     - A Skills panel listing what each agent already has: `~/.claude/skills`, `~/.codex/skills`, the shared `~/.agents/skills` and a project's `.agents/skills`.
     - "Add once" puts a skill in one Tacit folder and links it into every agent, OpenCode included. The SKILL.md format is shared, so this mostly means linking.
     - The same for MCP servers: one list, written into each agent's config.
   - *Effort:* M for skills, M for MCP.
7. **Setup and run scripts per worktree.**
   - *Who has it:* Conductor [43], Codex [26].
   - *Tacit today:* none.
   - *Smallest useful version:* `setup` and `run` in a small file in the repo. Setup runs when a worktree is made; Run opens a shell tile running the dev server, with its port shown.
   - *Effort:* S–M.
8. **Memory you can edit, and that every agent reads.**
   - *Who has it:* Claude Code [10], Codex [32], Hermes [52].
   - *Tacit today:* a view of Claude's folder plus `query_memory`.
   - *Smallest useful version:* edit and delete in the Memory tab. Workdesk memory goes into the agents' instructions at start, as a short index pointing at the files, for Codex and OpenCode as well as Claude.
   - *Effort:* M.
9. **Answer from your phone.**
   - *Who has it:* Claude Code [14], Codex [30], T3 Code [80], Hermes [55], OpenClaw [60].
   - *Tacit today:* a headless server with webhooks.
   - *Smallest useful version:* send Needs you to one chat app (Telegram or Slack) with the question and choices, and route the reply back the way `tacit task ask` answers already go.
   - *Effort:* M.
10. **Open in your editor.**
    - *Who has it:* most.
    - *Tacit today:* the in-app Monaco editor.
    - *Smallest useful version:* "Open in VS Code / Cursor / Zed" on a file, tile and worktree.
    - *Effort:* S.
11. **Spend caps.**
    - *Who has it:* unclear for most.
    - *Tacit today:* cost and quota views, worker-count cap. SHR-110 is in M3.
    - *Smallest useful version:* a per-workdesk daily budget from `usage-collector.ts`. When it's crossed, the manager can't spawn and running workers get a Needs you.
    - *Effort:* S–M.

**P2: nice to have**

12. **Plugins** that bundle skills, MCP and hooks.
    - *Who has it:* Claude Code [2], Codex [21], OpenClaw [60].
    - *Smallest useful version:* after #6, read Claude's and Codex's plugin files and show them. Don't build Tacit's own format yet.
    - *Effort:* M.
13. **Your own hooks.**
    - *Who has it:* Claude Code [4], Codex [22].
    - *Smallest useful version:* show the hooks each agent has (they already run in its terminal ⁱ), and keep Tacit's own telemetry hooks clearly marked.
    - *Effort:* S.
14. **Issue tracker to task.**
    - *Who has it:* Conductor (Linear) [45].
    - *Smallest useful version:* start a task from a Linear or GitHub issue URL, and post status back on done.
    - *Effort:* M.
15. **Scheduled and unattended runs.**
    - *Who has it:* Claude Code [15], Codex [28], Hermes and OpenClaw (cron).
    - *Smallest useful version:* scheduled prompts for the headless runtime.
    - *Effort:* L.
16. **Tacit's own sandbox.**
    - *Who has it:* Claude Code [11], Codex [25], Hermes [50], OpenClaw [61].
    - *Smallest useful version:* none for now. Show which sandbox mode each agent is in, and leave the sandboxing to the agents.
    - *Effort:* S (display only).
17. **Agent sign-in status.**
    - *Who has it:* the single-agent tools.
    - *Smallest useful version:* a row per agent in Settings showing whether it's installed, which account it's signed in as, and a sign-in button that opens a terminal running its login.
    - *Effort:* S.
18. **Windows and Linux builds.**
    - *Who has it:* most, but not Conductor.
    - *Effort:* L, plus SHR-122 must be fixed first for Windows.

## 5. Where Tacit is ahead

- Agents from different vendors on one canvas, with a manager, wires,
  hand-offs and waiting on each other. Others run agents side by side
  (Conductor, T3 Code, Herdr), but only Herdr lets them talk, and only as
  terminal messages.
- Browser nodes signed in as you, which agents can drive.
- A full local record of what happened, with secrets masked, and export.
- Tasks with steps, owners and Needs you, answered back into the worker's
  terminal.

## 6. Unknowns

- **T3 Code:** its docs site never came up in search. Worktrees,
  checkpoints and the diff panel come from an unofficial docs mirror [81],
  and permission modes from a third-party guide [82].
- **Conductor:** MCP, skills, hooks, notifications, usage and Cloud
  weren't covered in the pages I could reach.
- **Codex app:** inline diff comments and checkpoints weren't confirmed in
  the pages fetched, though worktrees, setup scripts, commit, push and PR
  were [26].
- **Claude Code desktop:** whether diff review takes line comments wasn't
  confirmed.
- **Usage caps:** not checked for any tool except Claude Code's cost view.
- **OpenClaw:** MCP support wasn't covered on the pages fetched.
- Cells marked `ⁱ` are inferred from the tool running the agent's own CLI.

## 7. Sources

Claude Code (code.claude.com, fetched 30 Oct 2026)
1. https://code.claude.com/docs/en/skills
2. https://code.claude.com/docs/en/plugins/overview
3. https://code.claude.com/docs/en/mcp
4. https://code.claude.com/docs/en/hooks
5. https://code.claude.com/docs/en/commands
6. https://code.claude.com/docs/en/sub-agents
7. https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/overview, https://code.claude.com/docs/en/interactive-mode
8. https://code.claude.com/docs/en/worktrees, https://code.claude.com/docs/en/desktop
9. https://code.claude.com/docs/en/checkpointing
10. https://code.claude.com/docs/en/memory
11. https://code.claude.com/docs/en/sandboxing
12. https://code.claude.com/docs/en/permission-modes, https://code.claude.com/docs/en/permissions
13. https://code.claude.com/docs/en/costs
14. https://code.claude.com/docs/en/remote-control, https://code.claude.com/docs/en/mobile, https://code.claude.com/docs/en/slack
15. https://code.claude.com/docs/en/routines
16. https://code.claude.com/docs/en/code-review, https://code.claude.com/docs/en/github-actions
17. https://code.claude.com/docs/en/overview

Codex (developers.openai.com, which redirects to learn.chatgpt.com/docs)
20. https://learn.chatgpt.com/docs
21. https://learn.chatgpt.com/docs/skills-and-plugins
22. https://developers.openai.com/codex/hooks
23. https://developers.openai.com/codex/extend/mcp
24. https://developers.openai.com/codex/agent-configuration/subagents
25. https://developers.openai.com/codex/sandboxing, https://developers.openai.com/codex/agent-approvals-security
26. https://learn.chatgpt.com/docs/environments/git-worktrees
27. https://developers.openai.com/codex/code-review, https://developers.openai.com/codex/third-party/github
28. https://developers.openai.com/codex/automations
29. https://developers.openai.com/codex/notifications
30. https://developers.openai.com/codex/mobile, https://developers.openai.com/codex/remote-connections
31. https://developers.openai.com/codex/non-interactive-mode, https://developers.openai.com/codex/codex-sdk
32. https://developers.openai.com/codex/customization/memories
33. https://developers.openai.com/codex/reference/slash-commands

Conductor
40. https://conductor.build/docs
41. https://conductor.build/docs/reference/diff-viewer
42. https://www.conductor.build/docs/guides/review-and-merge
43. https://www.conductor.build/docs/reference/scripts
44. https://www.conductor.build/docs/reference/checks
45. https://www.conductor.build/docs/guides/issue-to-pr
46. https://www.conductor.build/docs/troubleshooting/issues

Hermes Agent
50. https://hermes-agent.nousresearch.com/docs/
51. https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
52. https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
53. https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
54. https://hermes-agent.nousresearch.com/docs/user-guide/security
55. https://hermes-agent.nousresearch.com/docs/user-guide/messaging/

OpenClaw
60. https://docs.openclaw.ai
61. https://docs.openclaw.ai/gateway/sandboxing

Herdr
70. https://herdr.dev (repos under https://github.com/herdrdev)

T3 Code
80. https://github.com/pingdotgg/t3code (README)
81. https://mintlify.wiki/pingdotgg/t3code/guides/git-workflow (unofficial mirror of its docs)
82. https://braindetox.kr/en/posts/t3_code_multi_agent_manager.html (third-party guide)
