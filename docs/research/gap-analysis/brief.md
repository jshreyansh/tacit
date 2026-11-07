# Brief: where Tacit falls short as a developer tool

Two analysts do this independently: Claude (writes `claude-analysis.md`; `claude.md` would load as a CLAUDE.md on this Mac) and Codex
(writes `codex.md`), both in this folder. The owner then merges them side
by side. Same brief, same table, so the two line up row for row.

## The question

Tacit is a desktop canvas for running several coding agents (Claude Code,
Codex, OpenCode, Antigravity), terminals and browsers side by side, with
a manager agent, tasks and notes, wires between agents, and a record of
what happened. Compared with the tools below, **which basics does a
developer trying Tacit for the first time expect and not find?**

Judge from the point of view of **a new developer picking Tacit up**, not
the owner's own habits. Rank a gap by how much its absence hurts on day
one.

## Compare against

| Tool | Which product |
|---|---|
| Codex | OpenAI Codex: the CLI, the desktop app and Codex cloud |
| Claude Code | Anthropic's CLI, desktop app and web |
| Hermes Agent | Nous Research's open-source agent |
| OpenClaw | The open-source personal agent (formerly Clawdbot / Moltbot) |
| Herdr | Confirm which product this is and say what you found |
| Conductor | conductor.build: parallel Claude Code / Codex agents in worktrees, Mac app |
| T3 Code | T3's open-source GUI for coding agents |

If a tool turns out to be something other than described, say so and use
what it actually is.

## Areas (all four, nothing else)

1. **Extensibility:** skills, plugins, MCP and connectors, hooks,
   commands, how they're shared across agents.
2. **Code workflow:** worktrees, reviewing diffs, commits and PRs,
   checkpoints and undo, running and previewing, CI.
3. **Context and memory:** project instructions, memory, session history
   and search, resuming, handing context between agents.
4. **Control and safety:** permissions and approvals, sandboxing, spend
   and usage limits, notifications, remote and mobile access.

The owner's own examples: a universal skills section that every agent can
use, and plugins. Tacit already has memory at the workdesk level; check
what it actually does.

## Rules

- **Tacit claims come from the code**, not the docs or the README: cite a
  file path (`src/...`, `electron/...`, `cli/...`). The repo is
  `/Users/openclaw/tacit`, branch `main` at 0.42.0. If something exists
  only in docs or on a branch, it's not shipped.
- **Competitor claims come from their official docs, repo or changelog**,
  with a link in Sources. If you can't check it, mark it `?` and say why.
  If you couldn't browse at all, say so at the top.
- As of **30 Oct 2026**. Note when a source is older than six months.
- **Read-only.** Change no code, create no tasks, pins or Linear issues.
  Write only your own output file.
- **Don't read the other analyst's file** until yours is finished.

## Output: `claude.md` or `codex.md`

1. **Summary:** at most 10 bullets, the biggest gaps first.
2. **Tables, one per area.** Rows are the features below, in this order;
   columns are the tools. Each cell: `✅` has it, `◐` partly, `✗` no,
   `?` couldn't verify, plus a source number. The Tacit cell gives a file
   path, or `✗`.

   | Feature | Tacit | Codex | Claude Code | Hermes | OpenClaw | Herdr | Conductor | T3 Code |
   |---|---|---|---|---|---|---|---|---|

3. **Added rows:** features you think belong that aren't listed, in the
   same table format, marked as added.
4. **Ranked gaps.** P0 = a new developer hits it on day one and may give
   up; P1 = noticed within a week; P2 = nice to have. For each: the gap,
   who has it, what Tacit has today (with file paths), the smallest
   useful version for Tacit, and effort (S / M / L).
5. **Where Tacit is ahead:** short.
6. **Unknowns:** what you couldn't verify.
7. **Sources:** numbered.

## Rows

**Extensibility**
1. Skills (reusable instruction packs the agent loads when relevant)
2. One set of skills and connectors shared by every agent in the tool
3. Plugins or extensions that bundle commands, skills, hooks and servers; a way to install them
4. MCP server management: add, remove, sign in, per project or global
5. Hooks: run your own scripts on agent events (before a tool, after an edit, at the end of a turn)
6. Custom slash commands or saved prompts
7. Custom agents or roles (subagent definitions)
8. Choice of model and provider: API keys, other providers, local models
9. Scripting the tool itself: CLI, API or SDK, headless runs

**Code workflow**
1. An isolated worktree per task or agent, created and cleaned up by the tool
2. Diff review with line comments sent back to the agent
3. Commit, push and open a PR from the app
4. PR status and CI checks in the app; fixing a failing check
5. Checkpoints: undo or rewind an agent's changes
6. Setup and run scripts per worktree: dev server, preview, ports
7. Comparing or merging what parallel agents did on the same task
8. Opening the work in an editor or IDE, or editing in the app
9. A review agent for a diff or a PR
10. Issue tracker to task: GitHub Issues or Linear in, status out

**Context and memory**
1. Project instructions files (AGENTS.md, CLAUDE.md): created, edited, shared across agents
2. Memory that persists across sessions, which you can see and edit
3. Session history: browse, search, resume
4. Handing context or results from one agent to another
5. Attaching files, images and URLs to a prompt; @-mentioning files
6. Context window usage shown; compaction
7. Codebase search or indexing available to the agent
8. Settings and history carried across devices

**Control and safety**
1. Permission modes and per-tool approvals, with allowlists that persist
2. Sandboxed execution: limits on files and network
3. Usage and cost shown; limits and spend caps
4. Notifications when an agent needs you or finishes
5. Remote or mobile access: watch and answer from a phone or chat app
6. Runs that continue without the laptop: background, scheduled or cloud
7. Secrets: kept out of prompts, logs and screens
8. An audit record of what the agents did
9. Signing in to and switching accounts for the agent CLIs
