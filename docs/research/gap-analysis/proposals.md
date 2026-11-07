# Proposals from the gap analysis (P0 and P1)

Source: `comparison.md` (Claude's and Codex's analyses merged). Each item
says what it helps with, what Tacit has today (from the code), what we'd
build, and its size. Existing Linear issues are named where they overlap.
Nothing here is filed yet.

## P0: a new developer hits these on day one

### G1 · Undo an agent's turn

**Helps with:** an agent breaks something or goes the wrong way. Today
getting back means knowing git, which only resets the whole worktree, or
knowing that Claude alone has `/rewind` in its own terminal. With undo, a
bad turn costs one click, so people let agents try things.

**Today:**
- Tacit knows when each turn starts and ends: telemetry keeps
  `turn_started_at` per terminal (`electron/telemetry-service.ts:1131`).
- The Git panel can discard or stash the whole worktree
  (`src/components/RightPanel/GitContent.tsx`, `electron/git-info.ts`).
- `electron/snapshot-history.ts` saves the canvas layout, not files;
  `electron/session-fork.ts` forks a conversation, not files.
- Nothing saves file state per turn.

**Plan:**
1. At each turn start, the main process saves the worktree's files
   (tracked and untracked, not ignored) as a git commit under a private
   ref (`refs/tacit/checkpoints/<terminal>/<n>`), using a temporary index,
   so the branch, index and stash are untouched. Keep the last N.
2. "Undo last turn" on the tile, and a list of turns in the Git panel. It
   shows which files will change, then restores them.
3. Tell the agent in its terminal that its last turn was undone.
4. Refuse, and say why, when another agent is working in the same folder.
5. Two narrow IPC handlers keyed by terminal id (list, restore); the main
   process works out the folder, the renderer never passes a path.

**Limits:** doesn't undo effects outside the folder (databases, installs,
pushes); the confirm says so. **Size:** M.

### G2 · Comment on a diff line and send it to the agent

**Helps with:** reviewing is the main job when agents write the code.
Today you read the diff, then type "in foo.ts line 42, …" into the
terminal by hand. Pointing at the line is how reviewers work on GitHub,
Conductor and T3 Code.

**Today:** `src/components/RightPanel/DiffContent.tsx` shows the diff,
read-only. Sending text to an agent exists: the composer
(`src/components/ComposerBar.tsx`, `composerTarget.ts`) pastes into an
agent's terminal using each agent's settings in `src/terminal/cliConfig.ts`.

**Plan:**
1. Click or drag over lines in the diff to add a comment.
2. Comments collect as a draft review you can edit.
3. "Send to <agent>" sends one message: for each comment, `file:lines`,
   the quoted lines and the comment. The default target is the agent in
   that worktree; a picker if there are several.
4. Sent comments are marked and kept until the diff changes.

**Related:** SHR-44 (record manual interventions). **Size:** M.

### G3 · An agent in its own worktree, from the dock

**Helps with:** two agents in one folder overwrite each other's files and
mix their changes into one diff. Running agents side by side is Tacit's
point, but the safe way, a worktree each, is automatic only for Hydra
workers.

**Today:** Hydra workers get worktrees. `tacit worktree` and the file tree
make them by hand (`headless-runtime/worktree-control.ts`). An agent added
from the dock (`src/toolbar/dockEntries.tsx`) starts in the project folder.
Worktree labels on tiles have bugs (SHR-97, SHR-98).

**Plan:**
1. New agent: "Same folder" or "Own worktree", remembered per project.
   Own worktree makes branch `tacit/<short-name>` from the current HEAD.
2. The manager's `spawn_terminal` gets the same option.
3. When the agent is done or the tile closes: Merge, Open PR (G8), Keep
   or Discard. Discard shows uncommitted changes, then removes the
   worktree and branch.
4. Fix SHR-97 and SHR-98 along the way.

**Size:** M.

### G4 · Setup script and copied files for a new worktree

**Helps with:** a fresh worktree has no `node_modules`, no `.env`, nothing
built. The agent's first command fails, or it spends a turn installing,
or the developer sets it up by hand every time.

**Today:** none. Worktree creation is a plain `git worktree add`.

**Plan:**
1. A project file in the repo (name to decide) with `setup` (a command),
   `copy` (ignored files to copy from the main checkout, such as `.env*`)
   and `run` (G5). Editable in Settings, so nobody has to know the file.
2. Setup runs in a visible shell tile when a worktree is made; failures
   show, they aren't swallowed.
3. Copied files are listed by name only, never put in prompts or logs.
4. The file comes from the repo, so a cloned repo could run commands: ask
   once per project before the first run.

**Size:** S–M.

### G5 · Run button with a port and a preview

**Helps with:** the agent says it's done and you want to see it. Today:
open a terminal, `cd` into the worktree, start the dev server, find the
port, and avoid clashing with another worktree's server.

**Today:** shell terminals and browser nodes exist
(`electron/pty-manager.ts`, `src/browser/browserNodeCommands.ts`). Nothing
ties a worktree to a dev server or a port.

**Plan:**
1. Run on a worktree or tile opens a shell tile beside it running `run`,
   with `PORT` set to a free port Tacit picked.
2. When the port answers, open a browser node at `localhost:PORT`, wired
   to that worktree.
3. Stop and restart; one run per worktree.

**Size:** M. G3, G4 and G5 together are Codex's P0 #1.

### G6 · Show what an agent may do before it starts; no silent bypass

**Helps with:** two day-one failures. An agent that isn't signed in fails
inside its terminal with a vendor error. And Hydra workers run with every
approval and sandbox switched off, without the developer being told.
People need to trust the tool before leaving agents unattended.

**Today:**
- `electron/agent-detect.ts` finds each CLI and its version (SHR-55).
  Sign-in isn't checked.
- `src/terminal/cliConfig.ts` defines `autoApproveArgs`: Claude
  `--dangerously-skip-permissions`, Codex
  `--dangerously-bypass-approvals-and-sandbox`.
- `hydra/src/cli-commands.ts:104` sets `autoApprove: true` unless
  `--no-auto-approve` is passed.
- Chat nodes already have modes and approval cards
  (`electron/manager-chat/chat-modes.ts`, `drivers.ts`).
- Related: SHR-123 (model or account failures, M3), SHR-99 (Google
  sign-in refused for an agent CLI).

**Plan:**
1. (S, first) Auto-approve becomes a visible choice: asked once on the
   first Hydra run, explaining what it turns off. Tiles running in bypass
   show a badge.
2. An Agents section in Settings: per agent, installed, version, signed in
   as whom, and a Sign in button that opens a terminal running its login.
3. On a new agent tile: model, folder, approval mode, sandbox mode, in one
   line.

**Unknown:** whether each CLI can report its account without prompting.
**Size:** step 1 S; steps 2–3 M.

### G7 · System notifications

**Helps with:** agent turns take minutes. The developer switches to the
editor or browser, and an agent waiting for approval sits idle until they
happen to look back.

**Today:** no system notification anywhere in `electron/` or `src/`. In
the app only: the completion glow (`src/components/CompletionGlow.tsx`),
toasts (`src/stores/notificationStore.ts`) and Needs you
(`src/tasks/useTasksNeedingYou.ts`). Telemetry already works out each
terminal's status (`derived_status`, `electron/telemetry-service.ts`).

**Plan:**
1. The main process watches for: waiting on approval or input, turn
   finished, a task in Needs you.
2. If Tacit isn't focused, show a macOS notification (agent, workdesk, one
   line), once per turn.
3. Clicking it focuses Tacit, switches workdesk and focuses that tile.
4. Dock badge with the count waiting on you. On/off per kind in Settings.

**Size:** S.

## P1: noticed within a week

### G8 · Open a PR and see CI

**Helps with:** work isn't done until it's a PR with green checks. Today
you commit and push in Tacit, then go to GitHub to open the PR and watch
CI, and copy failing logs back to the agent by hand.

**Today:** commit, push and branches in `GitContent.tsx`,
`src/hooks/useGitStatus.ts`, `electron/git-info.ts`. No PR or checks.

**Plan:**
1. Detect `gh` and whether it's signed in; say how to fix it if not.
2. "Open PR" on a branch: title and body filled from the commits (or
   written by the agent), base branch, draft toggle.
3. A PR row in the Git panel: link, state and checks, refreshed while open.
4. A failing check has "Send to agent": the failed log, trimmed, sent to
   that worktree's agent.
5. IPC handlers take a worktree id, not a command.

**Size:** M, GitHub only to start.

### G9 · Skills in one place, for every agent (SHR-84, SHR-89)

**Helps with:** developers already have skills in `~/.claude/skills` or
`~/.codex/skills`. Switch agent in Tacit and they're gone, and no screen
shows what each agent has. Tacit's own skills reach only Claude and Codex.
No competitor shares skills across vendors, so this would be new.

**Today:** `electron/skill-manager.ts` copies Tacit's bundled skills into
`~/.claude/skills` and `~/.codex/skills` at each start, tracked in
`.tacit-skills.json`. `electron/slash-commands.ts` finds slash commands.
Nothing for OpenCode or Antigravity; no UI. Planned as T9 in M3.

**Plan:**
1. A Skills panel: every skill found, where it lives (global or project,
   which agent's folder), and which agents can see it.
2. "Available to all agents": one copy in a Tacit folder, linked into
   each agent's skills folder; agents that can't load skills are marked.
3. Add a skill from a folder or a git URL.

**Unknown:** OpenCode's and Antigravity's skill folders. **Size:** M.

### G10 · Connectors (MCP) in one place (SHR-90)

**Helps with:** connecting Linear, a database or docs means a different
config file per agent. Add once in Tacit and every agent has it.

**Today:** Tacit adds its own MCP server to each agent at launch through
the adapter registry (SHR-50). Other servers are whatever each CLI already
has. No UI.

**Plan:**
1. List the servers each agent already has, read-only.
2. Add a server once (command or URL, env, global or project). It's
   passed to each agent at launch through the adapter registry, like
   Tacit's own, without editing the user's files.
3. Per-agent status: connected, failed, needs sign-in.

**Size:** M.

### G11 · Memory that every agent reads

**Helps with:** Tacit has workdesk memory, but only Claude reads it on its
own; Codex and OpenCode only if they think to call `query_memory`. Switch
agent and you lose what the project learned, and you can't tell what an
agent will remember.

**Today:** `electron/memory-service.ts` reads Claude's project memory,
`electron/memory-notes.ts` the workdesk notes, `query_memory` is served by
`electron/api-server.ts`. The Memory tab
(`src/components/RightPanel/MemoryContent.tsx`) shows the files and opens
them for editing.

**Plan:**
1. At launch, give every agent a short memory index (titles, one line
   each, where to read more), through the adapter registry so the repo
   isn't touched.
2. The Memory tab shows "what <agent> sees".
3. "Save to memory" on a message or selected text.

**Size:** M.

### G12 · Spend caps (SHR-110)

**Helps with:** several agents spend fast, and the manager can start
more. A daily ceiling makes it safe to leave things running.

**Today:** `electron/usage-collector.ts` works out cost from the agents'
local logs; `src/components/UsagePanel.tsx` shows it;
`electron/worker-admission.ts` caps how many workers run (SHR-39). Nothing
stops spending.

**Plan:**
1. A daily budget per workdesk, and overall, in Settings.
2. Warn at 80%.
3. At 100% the manager and Hydra can't start workers (admission refuses,
   with the reason); running agents get a Needs you, they aren't killed.
4. Labelled as an estimate; on subscription plans show tokens and quota.

**Size:** S–M.

### G13 · Start a task from an issue

**Helps with:** work starts from an issue. Today you copy the text into a
prompt, and nothing goes back when it's done.

**Today:** tasks store links, including GitHub issues
(`electron/pin-store.ts`, `tacit pin add --link-type github_issue`). No
fetching, no status back.

**Plan:**
1. New task from an issue URL: GitHub through `gh`; Linear to decide.
2. Optionally start an agent in its own worktree (G3), branch named after
   the issue.
3. When the PR opens or the task is done, offer to comment on the issue.
   Never automatic.

**Size:** M.

### G14 · Open in your editor

**Helps with:** most developers edit and debug in their own editor.

**Today:** the built-in editor; the main process can reveal in Finder and
open paths (`electron/main.ts`, `shell.showItemInFolder`, `shell.openPath`).

**Plan:** find installed editors (VS Code, Cursor, Zed, JetBrains); "Open
in…" on a file (at its line), a tile (its folder) and a worktree;
remember the default. The IPC handler takes an editor id and a path inside
an open project (fits SHR-103).

**Size:** S.

### Import your existing setup

Proposed to fold into G6 (agents found, signed in) and G9/G10 (skills and
servers you already have), rather than its own ticket.

## Filed in Linear (30 Oct), milestone M1

| Item | Issue | Sub-issues |
|---|---|---|
| G1 Undo a turn | T10 · SHR-139 | SHR-140 … SHR-144 (started first) |
| G2 Diff line comments | T11 · SHR-145 | — |
| G3 Own worktree | T12 · SHR-146 | SHR-155, SHR-156, SHR-97, SHR-98 |
| G4 Worktree setup | T13 · SHR-147 | SHR-157, SHR-158, SHR-159 |
| G5 Run and preview | T14 · SHR-148 | SHR-160, SHR-161 |
| G6 Agent permissions, no silent bypass | T15 · SHR-149 | SHR-162, SHR-163, SHR-164 |
| G7 System notifications | T16 · SHR-150 | — |
| G8 PR and CI | T17 · SHR-151 | SHR-165, SHR-166, SHR-167 |
| G9, G10 Skills and connectors | T9 · SHR-84 (moved from M3) | SHR-89, SHR-90, SHR-91 |
| G11 Memory for every agent | T18 · SHR-152 | — |
| G12 Spend caps | SHR-110 (moved from M3) | — |
| G13 Issue to task | T19 · SHR-153 | — |
| G14 Open in your editor | T20 · SHR-154 | — |
