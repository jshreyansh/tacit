import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  AGENTS_FILE,
  CLAUDE_FILE,
  checkInstructions,
  findSectionRanges,
  writeInstructions,
  type InstructionSection,
} from "../shared/agent-instructions";
import type {
  InstructionFileGit,
  ProjectInstructionsStatus,
  SetUpProjectInstructionsResult,
} from "../shared/project-instructions";
import { HYDRA_INSTRUCTIONS } from "../hydra/src/init";
import { PIN_INSTRUCTIONS } from "./pin-instructions";

const execFileAsync = promisify(execFile);

/**
 * The instructions Tacit offers to add to a project, so agents there know
 * its commands. Tasks and Notes work in any folder; the multi-agent (Hydra)
 * section only where git is, since its workers each get a git branch. Older
 * versions of Tacit added it to folders without git too; setting up such a
 * folder takes it out. Both are written to AGENTS.md, with CLAUDE.md
 * importing it (shared/agent-instructions.ts).
 *
 * Checking only reads. Nothing is written until the person says yes.
 */

/** Whether `dir` is the home folder or holds it (`/`, `/Users`). */
export function holdsHomeFolder(dir: string, homeDir = os.homedir()): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(homeDir));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Refuses anything but an absolute path to an existing folder. */
function requireFolder(dir: unknown): string {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("Agent instructions need an absolute folder path");
  }
  const resolved = path.resolve(dir);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a folder: ${resolved}`);
  }
  return resolved;
}

async function git(dir: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd: dir, timeout: 10_000 });
    return true;
  } catch (err) {
    // git exits 1 or 128 for "no": not a repo, not tracked, not ignored.
    // Anything else (git missing, a timeout) is a real failure.
    const code = (err as { code?: unknown }).code;
    if (code === 1 || code === 128) return false;
    throw err;
  }
}

async function isInGitRepo(dir: string): Promise<boolean> {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]);
}

async function fileGitState(dir: string, fileName: string): Promise<Exclude<InstructionFileGit, null>> {
  if (await git(dir, ["ls-files", "--error-unmatch", "--", fileName])) return "tracked";
  if (await git(dir, ["check-ignore", "-q", "--", fileName])) return "ignored";
  return "untracked";
}

function hasSection(dir: string, section: InstructionSection): boolean {
  const headings = [section.heading, ...(section.formerHeadings ?? [])];
  return [AGENTS_FILE, CLAUDE_FILE].some((fileName) => {
    try {
      return findSectionRanges(fs.readFileSync(path.join(dir, fileName), "utf-8"), headings).length > 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

async function sectionsFor(dir: string): Promise<{
  sections: InstructionSection[];
  withdrawn: InstructionSection[];
  inGit: boolean;
}> {
  const inGit = await isInGitRepo(dir);
  return inGit
    ? { sections: [HYDRA_INSTRUCTIONS, PIN_INSTRUCTIONS], withdrawn: [], inGit }
    : { sections: [PIN_INSTRUCTIONS], withdrawn: [HYDRA_INSTRUCTIONS], inGit };
}

export async function checkProjectInstructions(
  dir: unknown,
  homeDir = os.homedir(),
): Promise<ProjectInstructionsStatus> {
  const folder = requireFolder(dir);
  if (holdsHomeFolder(folder, homeDir)) return { offered: false, reason: "home" };

  const { sections, withdrawn, inGit } = await sectionsFor(folder);
  const state = checkInstructions(folder, sections, withdrawn);
  return {
    offered: true,
    status: state.status,
    workflows: inGit,
    removesWorkflows: withdrawn.some((section) => hasSection(folder, section)),
    files: [
      { name: AGENTS_FILE, exists: state.agentsExists, git: inGit ? await fileGitState(folder, AGENTS_FILE) : null },
      { name: CLAUDE_FILE, exists: state.claudeExists, git: inGit ? await fileGitState(folder, CLAUDE_FILE) : null },
    ],
  };
}

export async function setUpProjectInstructions(
  dir: unknown,
  homeDir = os.homedir(),
): Promise<SetUpProjectInstructionsResult> {
  const folder = requireFolder(dir);
  if (holdsHomeFolder(folder, homeDir)) {
    return {
      ok: false,
      error: "Tacit doesn't add agent instructions to your home folder: every agent started anywhere under it would read them.",
    };
  }
  try {
    const { sections, withdrawn } = await sectionsFor(folder);
    const files = writeInstructions(folder, sections, withdrawn);
    return {
      ok: true,
      changed: files.some((file) => file.status !== "unchanged"),
      files: files.map(({ fileName, status }) => ({ fileName, status })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
