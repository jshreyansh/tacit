import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CaptureEvent, CaptureNodeRef } from "../shared/capture";
import { maskSecrets } from "../shared/secret-mask";
import type { WebReadProvenance } from "./web-read-tracker";

/**
 * Writing the notes agents share: the workspace journal (`log_activity`, the
 * manager's notes for whoever holds the role next) and a project's memory
 * (`remember`), in the folder and format the Memory tab reads
 * (electron/memory-service.ts). Each note says who wrote it and whether web
 * content could have shaped it (SHR-63), and the same goes into the record.
 * The API server checks who may write and where; this writes.
 */

export interface JournalProvenance extends WebReadProvenance {
  node: CaptureNodeRef;
  harness: string | null;
  session: string | null;
  /** The open context (run) the note was written in. */
  context: string | null;
}

export type ProjectNoteType = "project" | "feedback" | "reference";

/**
 * A project memory note, named by its title, so writing the same name again
 * replaces it. The provenance is the latest writer's.
 */
export function writeProjectNote(
  memoryDir: string,
  note: { name: string; description: string; type: ProjectNoteType; body: string },
  provenance: JournalProvenance,
): { filePath: string; fileName: string } {
  const slug = slugify(note.name);
  const fileName = `${note.type}_${slug}.md`;
  const filePath = path.join(memoryDir, fileName);
  const content = `---\nname: ${slug}\ndescription: ${note.description}\ntype: ${note.type}\n${provenanceFrontmatter(provenance)}---\n\n${note.body}\n`;
  fs.writeFileSync(filePath, content, "utf-8");
  updateMemoryIndex(memoryDir, fileName, note.description);
  return { filePath, fileName };
}

/**
 * One journal entry, in a file of its own: append-only, with nothing to
 * dedupe against, so modification order is chronological order (what the
 * workspace summary and memory query assume).
 */
export function writeJournalEntry(
  memoryDir: string,
  entry: { event: string; detail: string },
  provenance: JournalProvenance,
  now = new Date(),
): { filePath: string; fileName: string } {
  const fileName = `activity_${now.toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}.md`;
  const filePath = path.join(memoryDir, fileName);
  const content = `---\nname: ${slugify(entry.event)}\ndescription: ${entry.event}\ntype: project\n${provenanceFrontmatter(provenance)}---\n\n${entry.detail}\n`;
  fs.writeFileSync(filePath, content, "utf-8");
  updateMemoryIndex(memoryDir, fileName, entry.event);
  return { filePath, fileName };
}

/** The record's entry for a note just written. */
export function journalWriteEvent(
  provenance: JournalProvenance,
  note: { tool: "log_activity" | "remember"; scope: "workspace" | "project"; title: string; file: string },
): CaptureEvent {
  return {
    kind: "journal_write",
    by: provenance.node,
    ...note,
    session: provenance.session,
    tainted: provenance.tainted,
    taint_sources: provenance.taint_sources,
    last_web_read_at: provenance.last_web_read_at,
  };
}

/**
 * The provenance lines for a note's frontmatter, so whoever reads the note
 * later can see who wrote it and whether web content could have shaped it.
 * Values are kept to one line, and URLs masked as in the record.
 */
export function provenanceFrontmatter(provenance: JournalProvenance): string {
  const oneLine = (value: string) => maskSecrets(value.replace(/[\r\n]+/g, " "));
  const sources = provenance.taint_sources
    .map((read) => (read.kind === "browser" ? `${read.source} ${read.action ?? ""}${read.url ? ` ${read.url}` : ""}` : read.source))
    .join("; ");
  const lines = [
    `author: ${provenance.node}`,
    `harness: ${provenance.harness ?? "unknown"}`,
    `context: ${provenance.context ?? "none"}`,
    `tainted: ${provenance.tainted}`,
    ...(provenance.tainted ? [`tainted_by: ${oneLine(sources)}`] : []),
    ...(provenance.last_web_read_at ? [`last_web_read_at: ${provenance.last_web_read_at}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/** Lowercase, filesystem-safe slug — `name` is LLM-supplied and becomes a
 * filename, so this also closes off path traversal. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "note";
}

/** Appends (or, if already present, replaces in place) the index line for
 * `fileName` in this memory directory's MEMORY.md, so re-calling remember
 * with the same name updates the index instead of duplicating it. */
function updateMemoryIndex(memoryDir: string, fileName: string, description: string): void {
  const indexPath = path.join(memoryDir, "MEMORY.md");
  const line = `- [${description}](${fileName})`;
  let existing = "";
  try {
    existing = fs.readFileSync(indexPath, "utf-8");
  } catch {
    existing = "# Memory Index\n";
  }

  const linkPattern = new RegExp(`^-\\s*\\[.*\\]\\(${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\).*$`, "m");
  const next = linkPattern.test(existing)
    ? existing.replace(linkPattern, line)
    : `${existing.trimEnd()}\n${line}\n`;

  fs.writeFileSync(indexPath, next, "utf-8");
}
