/**
 * What the app is told about a project's agent instructions, and the result
 * of setting them up (electron/project-instructions.ts).
 */

export type InstructionFileName = "AGENTS.md" | "CLAUDE.md";

/** Whether git tracks the file (a change shows up in the next commit), ignores it, or neither; null outside a git repo. */
export type InstructionFileGit = "tracked" | "ignored" | "untracked" | null;

export interface ProjectInstructionFile {
  name: InstructionFileName;
  exists: boolean;
  git: InstructionFileGit;
}

export type ProjectInstructionsStatus =
  | {
      /** Never offered for the home folder, or a folder holding it: every agent under it would read them. */
      offered: false;
      reason: "home";
    }
  | {
      offered: true;
      /** missing: never set up. outdated: set up, but old or in the old layout. */
      status: "missing" | "outdated" | "current";
      /** Whether the multi-agent (Hydra) section is included: only where git is, or already there. */
      workflows: boolean;
      files: ProjectInstructionFile[];
    };

export type SetUpProjectInstructionsResult =
  | {
      ok: true;
      changed: boolean;
      files: Array<{
        fileName: InstructionFileName;
        status: "created" | "appended" | "updated" | "unchanged";
      }>;
    }
  | { ok: false; error: string };
