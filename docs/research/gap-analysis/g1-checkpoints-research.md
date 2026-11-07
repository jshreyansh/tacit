# How other tools undo an agent's turn (research for T10 / SHR-139)

Researched 30 Oct 2026 from each tool's own code (GitHub) or official docs.
Purpose: check Tacit's first T10 build against how others do it.

**Status:** all six fixes below were applied on 30 Oct, tested with unit tests on real git repos and checked live with Claude and Codex in the dev app (see SHR-139).

## What each one does

| Tool | When it saves | Where | What a restore touches | Several agents in one folder | Guards |
|---|---|---|---|---|---|
| **Claude Code** [1] | Before each prompt that starts a turn | Its own file snapshots, per session | Only files Claude's edit tools touched; bash-only changes aren't tracked. Code, conversation, or both | Other sessions' edits "normally not captured" | Keeps 100 checkpoints, about 30 days; skips symlinks and hard links |
| **Codex CLI** [2] | Each turn ("ghost commits") | Unreferenced commits from a temp index; id kept in the conversation | `git restore --source <commit> --worktree -- <subdir>`; removes only untracked files that are new since; keeps your staging ("data safety > cleanliness") | Not handled | Skips untracked files over 10 MiB and folders with 200+ untracked files; always skips `node_modules`, `.venv`, `dist`, `build`, caches; never deletes them. **Removed the whole feature in April 2026** (PR #19481, no reason given) |
| **T3 Code** [3] | Each turn; a turn's end is the next turn's rollback point | **Private git refs in the project repo**; temp index seeded from the real index; HEAD as parent to see commits | `git restore` + `git clean -fd`, scoped to the thread's folder | **Refuses file restore unless the thread has its own worktree** no other thread shares: "File restore requires an isolated worktree… Rewind the conversation without restoring files instead." | Sparse checkout, LFS, embedded repos, racy timestamps handled |
| **Conductor** [4] | Before each agent response | **Private git ref**, kept out of branch history | Reverts all code since that message **and deletes the conversation after it**, permanently | Warns: checkpoints can conflict when several chats share a workspace | No redo |
| **Hermes Agent** [5] | Once per turn, before the first file-changing tool | One shared shadow git store in `~/.hermes/checkpoints` (`GIT_DIR` + `GIT_WORK_TREE` + `GIT_INDEX_FILE`) | Takes a "pre-rollback snapshot so you can undo the undo"; a **safe mode leaves files the person edited after the agent's last write** and reverts only the agent's changes | Safe mode | Default excludes: `node_modules`, `dist`, `build`, `target`, `.venv`, caches, binaries, media, archives, logs, **`.env*`**; skips folders over 50,000 files; prunes after 7 days or 500 MB, then `git gc` |
| **OpenCode** [6] | Around each step | A separate snapshot git repo; uses the project's ignore rules | Reverts tracked snapshot state | — | Packs objects periodically |
| **Gemini CLI** [7] | When you approve a file-changing tool (off by default) | Shadow repo in `~/.gemini/history/<hash>` | Files, conversation, and re-proposes the tool call | — | — |
| **Cline** [8] | After each tool use | Shadow git repo | Files, task, or both | — | Warns about storage and speed on big repos |

## Where Tacit's first build already matches

* **Private refs in the project's own repo** (`refs/tacit/checkpoints/...`), like T3 Code and Conductor. Nothing reaches your branch, and `git push` doesn't send them.
* **A separate index**, so your staging is never touched (Codex learned this the hard way: #8214).
* **HEAD as the parent**, to notice when the agent committed (T3 Code).
* **A checkpoint per turn**, like Conductor, Claude Code and Hermes.
* **Redo**: the state before an undo is saved first (Hermes's "undo the undo"). Conductor has no redo.
* Ignored files are never saved or touched.

## Where it falls short, and the fix

1. **It rewinds the whole folder, not only the agent's own changes.** Every careful tool narrows this:
   * Claude Code only tracks files its own tools edited.
   * Hermes's safe mode keeps files you edited after the agent's last write.
   * T3 Code refuses outright when the folder is shared.

   Tacit runs several agents in one folder by default, so this matters most.
   **Fix:** undo restores only the files the undone turns changed (start → end of each turn). A file someone else changed after the turn is **kept** and listed as such, rather than overwritten.
2. **Nothing guards size.** Codex and Hermes exclude dependency, build and cache folders even when they aren't gitignored, skip huge untracked files, and skip folders that are too big. Tacit relies on `.gitignore` alone, so an unignored build folder or dataset would be hashed every turn and grow `.git`.
   **Fix:**
   * Always exclude `node_modules`, `dist`, `build`, `target`, `.venv`, `venv`, `__pycache__` and caches.
   * Skip untracked files over 10 MiB.
   * Skip checkpoints in folders over 50,000 files, and say so.
   * Excluded files are never touched on undo.
3. **Secrets can enter git objects.** Hermes always excludes `.env*`. Tacit would save an unignored `.env` into the repo's objects.
   **Fix:** always exclude `.env` and `.env.*`.
4. **The scope is the whole repo, not the agent's folder.** Codex and T3 Code limit both snapshot and restore to the agent's subfolder. In a monorepo, Tacit would rewind sibling packages.
   **Fix:** snapshot and restore only the terminal's folder.
5. **The restore mechanism.** Codex and T3 Code restore named paths (`git restore --source … --worktree -- <paths>`) and remove created files explicitly. That fits (1) and (4) better than Tacit's whole-tree `read-tree -m -u`.
   **Fix:** switch to path-based restore.
6. **Sparse checkouts.** T3 Code needed special handling and refuses one case.
   **Fix:** skip checkpoints when `core.sparseCheckout` is on, and say so.

## Kept as is, knowingly

* **Conversation rewind:** Claude Code, Conductor, Cline, Gemini and T3 Code also rewind the conversation. Tacit drives other vendors' CLIs and can't edit their conversations, so it leaves the agent a note instead. Claude's own `/rewind` still works in its terminal.
* **Retention:** 50 turns per terminal and 14 days, between Claude Code (100 / 30 days) and Hermes (7 days / 500 MB).
* **Timing at turn start:** the snapshot follows Claude's async prompt hook, flagged `late` if a tool runs first. T3 Code avoids the race by treating each turn's end as the next turn's start. The authored-paths change in (1) makes a late start much less harmful, because only files the turn touched are restored.

## Sources

1. Claude Code, Checkpointing: https://code.claude.com/docs/en/checkpointing
2. OpenAI Codex: `codex-rs/git-utils/src/ghost_commits.rs` at `61dfe0b86`; PRs #3914, #8055, #8214/#8303, #19481 (removal, 28 Apr 2026): https://github.com/openai/codex/pull/19481
3. T3 Code: `apps/server/src/vcs/GitVcsDriver.ts` (`captureCheckpoint`, `restoreCheckpoint`), `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts`: https://github.com/pingdotgg/t3code
4. Conductor, Checkpoints: https://www.conductor.build/docs/core/checkpoints
5. Hermes Agent: `tools/checkpoint_manager.py`, `hermes_cli/checkpoints.py`: https://github.com/NousResearch/hermes-agent
6. OpenCode: `packages/core/src/snapshot.ts`: https://github.com/sst/opencode
7. Gemini CLI, Checkpointing: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md
8. Cline, Checkpoints: https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx
