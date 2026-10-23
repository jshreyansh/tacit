import fs from "node:fs";
import path from "node:path";

/**
 * Where Tacit puts the instructions agents read in a project folder.
 *
 * One copy, in AGENTS.md: Codex, OpenCode and Antigravity read it, and so
 * does Claude Code, but only when no CLAUDE.md is in the folder or any
 * folder above it (measured on 23 Oct 2026 with Claude Code 2.1.309, Codex
 * 0.163.0, OpenCode 2.0.29 and Antigravity 1.3.3). So CLAUDE.md gets one
 * line, `@AGENTS.md`, which Claude Code expands into the file's text, rather
 * than a second copy that can drift from the first.
 *
 * Projects set up before this kept the full text in both files; writing
 * moves them to this layout.
 */

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
export type InstructionFileName = typeof AGENTS_FILE | typeof CLAUDE_FILE;

/** A `## ` section Tacit owns in AGENTS.md, replaced whole when it changes. */
export interface InstructionSection {
  heading: string;
  /** Headings this section was written under before, replaced by it. */
  formerHeadings?: string[];
  /** The whole section, starting with its `## ` heading line. */
  text: string;
}

export type SectionStatus = "missing" | "outdated" | "current";

export const CLAUDE_IMPORT_HEADING = "Shared Agent Instructions";

const CLAUDE_IMPORT_SECTION = `## ${CLAUDE_IMPORT_HEADING}

The instructions for agents in this folder are in AGENTS.md, which Codex,
OpenCode and Antigravity read directly. Claude Code reads it through this
import:

@AGENTS.md
`;

export type InstructionWriteStatus = "created" | "appended" | "updated" | "unchanged";

export interface InstructionFileResult {
  fileName: InstructionFileName;
  filePath: string;
  status: InstructionWriteStatus;
}

function headingsOf(section: InstructionSection): string[] {
  return [section.heading, ...(section.formerHeadings ?? [])];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each `## <heading>` section in `content`, up to the next `## ` heading. */
export function findSectionRanges(
  content: string,
  headings: readonly string[],
): Array<{ start: number; end: number }> {
  const pattern = new RegExp(`^## (?:${headings.map(escapeRegExp).join("|")})[ \\t]*$`, "gm");
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    const next = content.indexOf("\n## ", start + match[0].length);
    ranges.push({ start, end: next === -1 ? content.length : next + 1 });
  }
  return ranges;
}

function normalizeSection(section: string): string {
  return section.trim().replace(/\s+$/gm, "");
}

export function sectionStatus(content: string | null, section: InstructionSection): SectionStatus {
  if (content === null) return "missing";
  const ranges = findSectionRanges(content, headingsOf(section));
  if (ranges.length === 0) return "missing";
  if (ranges.length > 1) return "outdated";
  const current = content.slice(ranges[0].start, ranges[0].end);
  return normalizeSection(current) === normalizeSection(section.text) ? "current" : "outdated";
}

/**
 * `content` with every section under `headings` taken out. Only the blank
 * lines where a section was cut out are tidied; the rest is left as it was.
 */
export function removeSections(content: string, headings: readonly string[]): string {
  const ranges = findSectionRanges(content, headings);
  if (ranges.length === 0) return content;
  const pieces: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    pieces.push(content.slice(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(content.slice(cursor));
  const kept = pieces
    .map((piece, i) => {
      // Trim only the edges a section was cut from.
      let trimmed = i > 0 ? piece.trimStart() : piece;
      if (i < pieces.length - 1) trimmed = trimmed.trimEnd();
      return trimmed;
    })
    .filter((piece) => piece.trim() !== "");
  if (kept.length === 0) return "";
  const joined = kept.join("\n\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** `content` with the section written once: in place of its first copy, or at the end. */
export function upsertSection(content: string, section: InstructionSection): string {
  const ranges = findSectionRanges(content, headingsOf(section));
  const text = section.text.trim() + "\n";
  if (ranges.length === 0) {
    return content.trim() ? `${content.trimEnd()}\n\n${text}` : text;
  }
  const before = content.slice(0, ranges[0].start);
  const after = removeSections(content.slice(ranges[0].end), headingsOf(section));
  const rest = after.trim() ? `\n${after.trimStart()}` : "";
  return `${before}${text}${rest}`;
}

/** Whether CLAUDE.md already pulls in AGENTS.md (`@AGENTS.md` on a line of its own, outside code). */
export function claudeImportsAgentsFile(content: string | null): boolean {
  if (content === null) return false;
  let inCode = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (!inCode && /^\s*@(\.\/)?AGENTS\.md\s*$/.test(line)) return true;
  }
  return false;
}

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface InstructionsState {
  /**
   * missing: Tacit's text is in neither file, so the project never opted in.
   * outdated: some of it is there, but a section is missing or old, CLAUDE.md
   * doesn't import AGENTS.md, or CLAUDE.md still holds a copy of the text.
   */
  status: SectionStatus;
  agentsExists: boolean;
  claudeExists: boolean;
}

/** Read-only: how far `dir` is from having `sections` in the layout above. */
export function checkInstructions(dir: string, sections: readonly InstructionSection[]): InstructionsState {
  const agents = readIfPresent(path.join(dir, AGENTS_FILE));
  const claude = readIfPresent(path.join(dir, CLAUDE_FILE));
  const allHeadings = sections.flatMap(headingsOf);
  const anywhere =
    (agents !== null && findSectionRanges(agents, allHeadings).length > 0) ||
    (claude !== null && findSectionRanges(claude, allHeadings).length > 0);
  const state = { agentsExists: agents !== null, claudeExists: claude !== null };
  if (!anywhere) return { status: "missing", ...state };

  const current =
    sections.every((section) => sectionStatus(agents, section) === "current") &&
    claudeImportsAgentsFile(claude) &&
    findSectionRanges(claude ?? "", allHeadings).length === 0;
  return { status: current ? "current" : "outdated", ...state };
}

function writeFile(
  dir: string,
  fileName: InstructionFileName,
  before: string | null,
  after: string,
  added: boolean,
): InstructionFileResult {
  const filePath = path.join(dir, fileName);
  if (before === after) return { fileName, filePath, status: "unchanged" };
  fs.writeFileSync(filePath, after);
  const status: InstructionWriteStatus =
    before === null || before.trim() === "" ? "created" : added ? "appended" : "updated";
  return { fileName, filePath, status };
}

/**
 * Writes `sections` into AGENTS.md (each replacing its old copy), and makes
 * CLAUDE.md import AGENTS.md, taking out any copy of the same sections it
 * held. Everything else in both files is left as it was.
 */
export function writeInstructions(
  dir: string,
  sections: readonly InstructionSection[],
): InstructionFileResult[] {
  const allHeadings = sections.flatMap(headingsOf);

  const agentsBefore = readIfPresent(path.join(dir, AGENTS_FILE));
  let agents = agentsBefore ?? "";
  for (const section of sections) agents = upsertSection(agents, section);
  const agentsHadText = findSectionRanges(agentsBefore ?? "", allHeadings).length > 0;

  const claudeBefore = readIfPresent(path.join(dir, CLAUDE_FILE));
  const claudeHadText = findSectionRanges(claudeBefore ?? "", allHeadings).length > 0;
  let claude = claudeHadText ? removeSections(claudeBefore ?? "", allHeadings) : claudeBefore ?? "";
  if (!claudeImportsAgentsFile(claude)) {
    claude = upsertSection(claude, { heading: CLAUDE_IMPORT_HEADING, text: CLAUDE_IMPORT_SECTION });
  }

  return [
    writeFile(dir, AGENTS_FILE, agentsBefore, agents, !agentsHadText),
    writeFile(dir, CLAUDE_FILE, claudeBefore, claude, !claudeHadText),
  ];
}
