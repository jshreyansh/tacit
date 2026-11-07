# Claude and Codex, side by side

The two analyses of `brief.md` are `claude-analysis.md` and `codex.md`.
Each was written without reading the other. This file is written after
reading both, and the disputed Tacit facts were checked in the code
again.

**Baseline note.** Codex read the local `main` branch, which was still
0.41.0 (`539b2566`): the push updated `origin/main` (0.42.0, `a8ef6e6b`)
but not the local branch ref. What 0.42.0 added (chat modes, Always allow
kept for Tacit tools, the wallpaper, per-workdesk tasks) changes none of
the ratings below, except that Always allow on a Tacit (MCP) tool now
lasts beyond the chat.

## Where both agree, and how each ranked it

| Gap | Claude | Codex | Notes |
|---|---|---|---|
| Undo an agent's turn (checkpoints) | P0 | P0 (with line comments) | Claude Code, Conductor, Hermes and T3 Code all have it |
| Line comments in the diff, sent to the agent | P1 | P0 (with undo) | Conductor and T3 Code have it; the Codex app has review comments |
| Setup and run scripts per worktree, a Run button, ports | P1 | **P0 #1** | Conductor and Codex; Codex copies ignored files like `.env` into worktrees |
| Open a PR and see CI | P1 | P1 | Conductor, Codex, Claude desktop, T3 Code |
| One skills library across agents, with what each agent supports | P1 | P1 | Nobody shares one set across vendors; OpenCode and Antigravity get none of Tacit's skills |
| MCP and connectors managed in one place | P1 (with skills) | P1 | Plugins come after, as a P2 for Claude and later for Codex |
| OS notifications when an agent needs you | **P0** | P1 | Both found in-app dots and toasts only |
| Spend caps | P1 | P1 | Tacit shows cost and quota; nothing stops spending |
| Memory reaching every agent, and its scope made clear | P1 | P1 | See the correction below: it's editable already |
| Answer from a phone or chat app | P1 | P2 | Headless server exists; no client |
| Issue tracker to task | P2 | P1 | Conductor (GitHub, Linear) |
| Settings and history across machines | not ranked | P2 | |

Both also say the same things are **not** gaps: session history and
resume, Git basics, instructions files, the CLI and headless API, and
handing work between agents, where Tacit is ahead.

## What only one of them found

**Only Codex:**
- **Silent sandbox bypass. Checked, and it's real.** Hydra workers start
  with auto-approve unless `--no-auto-approve` is passed
  (`hydra/src/cli-commands.ts:104`). For Codex that's
  `--dangerously-bypass-approvals-and-sandbox`, and for Claude
  `--dangerously-skip-permissions` (`src/terminal/cliConfig.ts:86,108`).
  A new developer isn't told. Codex made "say what each agent may do,
  and whether it's signed in, before it starts" a P0.
- **Importing an existing setup with a preview** (added row): what of
  your skills, servers and sessions Tacit will use. Codex and Hermes have
  an importer.
- **Better competitor sources.** Codex found T3 Code's docs (they live
  in its repo, `docs/user/*.md`), Conductor's checkpoints, MCP and
  provider pages, Hermes's worktrees and checkpoints, and Claude
  desktop's PR, CI and preview flow. Where Claude's tables say `?` or `✗`
  for those, Codex's are the better ones.

**Only Claude:**
- **A worktree per agent from the dock.** Codex rated worktrees ✅
  because Hydra makes them; but an agent you add yourself starts in the
  main checkout. Both are true. For a new developer starting agents by
  hand, it's a gap.
- **Open in VS Code, Cursor or Zed.** Codex rated the in-app editor ✅.
- **Windows and Linux builds** (added row): the targets are configured,
  but only Mac is built.
- **Hooks shown, plugins later:** split out as their own P2s.

## Tacit facts the two read differently, checked again

| Row | Claude | Codex | What the code says |
|---|---|---|---|
| Memory you can see and edit | ◐, said not editable | ✅ | **Codex is right.** The Memory tab opens a memory file in the editor (`src/components/RightPanel/MemoryContent.tsx`, `onOpenFile`). The real gap is that Codex and OpenCode don't read it on their own, only through `query_memory`. |
| Worktree per task | ◐ | ✅ | Hydra does it; the dock doesn't. ◐ from a new developer's seat. |
| Checkpoints | ✗ | ◐ | Git discard and stash work on the whole worktree, and Claude's own `/rewind` works in its terminal. Nothing undoes one turn of any agent. ✗ for "undo a turn" in Tacit. |
| Sandboxing | ✗ (own) | ◐ | Tacit has none of its own, and can switch the agents' off (above). |
| Agent sign-in | ✗ | ◐ | `electron/agent-detect.ts` finds the CLI on PATH; nothing checks or shows sign-in. |
| Roles, review agent, editor | ◐ | ✅ | They exist; roles and the reviewer are reachable from the CLI and the manager, not the UI, and there's no external editor. |

## A merged ranking (Claude's proposal for you to decide)

**P0**
1. **Undo an agent's turn**, plus **line comments sent to the agent**.
   Both analysts' top item: feedback, and a way back. M, L for
   checkpoints across agents.
2. **A worktree you can run.** "In its own worktree" from the dock, a
   setup script when it's made (including ignored files like `.env`),
   and a Run button with its port. M.
3. **Say what each agent may do before it starts.** Signed in or not,
   model, folder, approval and sandbox mode, and no sandbox bypass
   without asking. M; the bypass default alone is S.
4. **OS notifications.** S, and the cheapest item on the list.

**P1:** PR and CI · skills and MCP on one screen, for every agent
including OpenCode and Antigravity · memory every agent reads, with its
scope shown · spend caps · issue tracker to task · open in your editor ·
importing your existing setup.

**P2:** phone or chat-app answers · plugins · showing hooks · settings
across machines · scheduled runs · Windows and Linux.
