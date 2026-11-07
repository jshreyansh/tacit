# Undo when an agent runs in a parent folder of several repos (T10 follow-up)

Researched 31 Oct 2026 from each tool's current code (shallow clones of
`main`) or official docs. Prompted by the T10 hand test: the project was
opened at `~/scratch`, which isn't a git repo, and the agent edited files in
`~/scratch/undo-hand`, which is. Tacit took no checkpoints, so there was no
Undo button.

## What each tool does

| Tool | Agent's folder not in git | Repos inside the agent's folder |
|---|---|---|
| **Claude Code** [1] | Works: checkpoints are file snapshots, not git | Works for files its edit tools changed, in any folder. Files changed only by shell commands aren't tracked |
| **Codex CLI** [2] | No checkpoints (ghost commits needed a repo). The feature was removed in April 2026 | Not handled |
| **Cline** (4.x SDK) [3] | No checkpoints: `rev-parse --is-inside-work-tree` must be true. Picks them up if `git init` runs mid-session | A nested repo is saved as a gitlink (its commit only), so its edits aren't captured. Cline 3.x renamed nested `.git` folders to `.git_disabled` during snapshots. That code is gone, and its changelog lists bugs with leftovers |
| **OpenCode** [4] | No snapshots: enabled only when the project's VCS is git | Snapshot scoped to the agent's folder inside its repo |
| **T3 Code** [5] | No checkpoints: `isGitCheckpointable(cwd)` must be true | Not handled. A thread is bound to one repo or worktree |
| **Conductor** [6] | Not possible: a workspace is "a separate, git-backed copy of a project" | Not possible: "1 project contains 1 repository" |
| **Gemini CLI** [7] | Works: a shadow repo in `~/.gemini/history/<hash>` with the folder as its work tree | A nested repo becomes a gitlink in the shadow repo, so its files aren't saved. No special handling |
| **Hermes Agent** [8] | Works: one shared shadow store, any folder. Skips `/` and the home folder as too broad | **The only one that handles it:** before each file-tool write it walks up from the file to the nearest project marker (`.git`, `package.json`, …) and checkpoints that folder. Shell commands checkpoint the agent's folder instead, where nested repos are "not captured" and rollback of them is refused |

## What this means

* **No one captures nested repos from a parent folder.** Five of the eight
  (Codex, Cline, OpenCode, T3 Code, Conductor) need the agent's folder to be
  in git, as Tacit does. The two with a shadow store for any folder (Gemini,
  Hermes) still skip what's inside a nested repo. Hermes says so: "Recursive
  capture of nested repositories is not supported."
* **Hermes gets around it only for its own file tools,** because it runs the
  tools and can checkpoint before each write. Tacit doesn't run the tools;
  it would need the agent's PreToolUse hook to wait until the snapshot is
  saved. Claude and Codex's Bash edits carry no file path, so they would
  still be missed. Claude Code avoids git entirely, but only tracks its own
  edit tools.

## Workdesks with several folders

In Tacit a workdesk can hold several projects (folders), mixing repos and
plain folders. But **each agent runs in exactly one of them**: its terminal's
folder is one project or one worktree, and checkpoints are kept per agent,
scoped to that folder. So undo is per agent, not per workdesk:

| Agent's folder | Undo today |
|---|---|
| A repo, or a worktree of one | Works (worktrees tested) |
| A subfolder of a repo (a monorepo package) | Works, scoped to that subfolder |
| One repo with several agents in it | Works. Each agent undoes only its own changes, and snapshots in one repo run one at a time |
| Several repos in one workdesk, one agent in each | Works. Each agent's undo stays in its own repo |
| A plain folder, no git anywhere | No undo, and only the tile menu says why |
| A parent folder with repos inside | No undo, and only the tile menu says why |
| Files an agent edits outside its own folder (another project in the workdesk, by full path) | Not saved, not undone. The sheet's last note says so in general terms |

How others handle several folders:

* **Cline** lets one task work across all the folders of a VS Code
  multi-root workspace, and so **turns checkpoints off** there: "Checkpoints
  are disabled in multi-root workspace mode. Cline displays a warning when
  this happens." [9]
* **Conductor** allows one repo per project: "1 project contains 1
  repository." [6]
* **T3 Code and OpenCode** give each thread one folder, and checkpoint it
  only if it's in git. [4, 5]
* **Claude Code and Cursor** save copies of the files the agent edits, so
  they work across folders, but only for their own edit tools. [1, 10]

Tacit is already in the safe position. Because an agent never spans folders,
a workdesk with several repos needs no limit and no special handling. The
gaps are the two kinds of folder with no undo, and edits made outside the
agent's own folder.

## How this machine is used

Claude sessions on this machine, by the folder they ran in (from
`~/.claude/projects`, 31 Oct):

| Folder | Sessions |
|---|---|
| A git repo | 119 |
| The home folder `~` (too broad to checkpoint anyway; Hermes skips it too) | 7 |
| `~/scratch` (the hand test) | 2 |
| `~/tacit test` (empty) | 1 |
| Folder since deleted | 36 |

The installed Tacit has only ever opened `~/tacit`, which is a repo. Apart
from the hand test, the parent-folder case hasn't come up.

## Recommendation

1. **Now (small):** say why there's no Undo, where the button would be. When
   the agent's folder isn't in git but has repos inside, the tile and the tab
   show: "Undo works inside a git repo. Open `undo-hand` as its own project
   to get undo for it." Today only the tile's right-click menu says "Undo
   needs git", and the tab view says nothing.
2. **Not now:** capturing nested repos. Build it only if parent-folder use
   shows up. If it does, follow Hermes:
   * snapshot the repo of each file the agent is about to edit, from the
     PreToolUse hook, before the tool runs;
   * snapshot the repos it touched in its last turn when a new turn starts,
     which also covers shell edits there;
   * show one undo per repo.

## Sources

1. Claude Code, Checkpointing: https://code.claude.com/docs/en/checkpointing
2. Codex: see `g1-checkpoints-research.md` (PR #19481, removal on 28 Apr 2026)
3. Cline `a6507a6`: `sdk/packages/core/src/hooks/checkpoint-hooks.ts` (`ensureGitRepository`, the gitlink note in the untracked index); `CHANGELOG.md` 3.69.0 ("prevent silent `.git_disabled` leftovers"): https://github.com/cline/cline
4. OpenCode `bf544cd`: `packages/core/src/snapshot.ts` (`enabled = () => location.vcs?.type === "git"`): https://github.com/sst/opencode
5. T3 Code `eef35b02`: `apps/server/src/orchestration-v2/CheckpointService.ts` (`isGitCheckpointable`): https://github.com/pingdotgg/t3code
6. Conductor, Workspaces and branches: https://www.conductor.build/docs/concepts/workspaces-and-branches
7. Gemini CLI `6814e00`: `packages/core/src/services/gitService.ts` (`GIT_DIR` shadow repo, `GIT_WORK_TREE` = project root): https://github.com/google-gemini/gemini-cli
8. Hermes Agent `c419cf7c`: `tools/checkpoint_manager.py` (`get_working_dir_for_path`, `_gitlink_paths`, `ensure_checkpoint`); `agent/tool_executor.py` (`_ensure_file_checkpoint`); `website/docs/user-guide/checkpoints-and-rollback.md` ("Nested Git repositories"): https://github.com/NousResearch/hermes-agent
9. Cline, Multi-root workspaces: https://docs.cline.bot/features/multiroot-workspace
10. Cursor, Checkpoints: https://cursor.com/docs/agent/chat/checkpoints
