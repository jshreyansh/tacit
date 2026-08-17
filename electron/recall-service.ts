import fs from "node:fs";
import path from "node:path";
import { detectHarnessText, detectLegacyAppText } from "../shared/capture";
import type { CaptureEntry, CaptureNodeRef } from "../shared/capture";
import {
  recall,
  type RecallDoc,
  type RecallHit,
  type RecallQuery,
} from "../shared/recall";

/**
 * Makes the decision record and the workspace journal readable.
 *
 * Both were write-only: the record had no reader at all, and the journal was
 * only ever surfaced as "the ten most recent entries" — fine for picking up
 * where someone left off, useless for "have I done this before".
 *
 * Loaded fresh when the files change rather than watched, because the manager
 * asks a handful of times a session and a full parse of a year of record is
 * milliseconds (see the note in shared/recall.ts on why this is not a vector
 * store). A cache keyed on mtime keeps repeated questions cheap without going
 * stale after the agent writes something new.
 */
export class RecallService {
  private cache: { docs: RecallDoc[]; signature: string } | null = null;

  constructor(
    private readonly recordDir: string,
    /** Resolves the workspace journal directory for the active canvas. */
    private readonly journalDir: () => string | null,
  ) {}

  query(q: RecallQuery, now = Date.now()): RecallHit[] {
    return recall(this.load(), q, now);
  }

  /**
   * Compact orientation for a manager that has just been handed the role.
   *
   * Deliberately not "the last N entries": a fresh holder needs to know what
   * this workspace is FOR before it needs to know what happened most recently.
   * So — what the user has been asking for, what got abandoned, and only then
   * the latest journal notes.
   */
  digest(limits = { asks: 8, abandoned: 5, notes: 5 }): string {
    const docs = this.load();
    const lines: string[] = [];

    const asks = docs
      .filter((d) => d.origin === "record" && d.kind === "prompt" && !d.source)
      .slice(-limits.asks)
      .reverse();
    if (asks.length) {
      lines.push("What the user has been asking for (most recent first):");
      for (const a of asks) lines.push(`  - ${a.summary}`);
    }

    const abandoned = this.findAbandoned(docs).slice(-limits.abandoned).reverse();
    if (abandoned.length) {
      lines.push("", "Tried and dropped — worth not repeating:");
      for (const a of abandoned) lines.push(`  - ${a}`);
    }

    const notes = docs.filter((d) => d.origin === "journal").slice(-limits.notes).reverse();
    if (notes.length) {
      lines.push("", "Recent journal notes:");
      for (const n of notes) lines.push(`  - ${n.summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Nodes created and then closed shortly after.
   *
   * This is the signal that exists nowhere else — a transcript records what was
   * tried, never what was given up on. Derived at read time rather than stored,
   * so the writer stays dumb and the threshold can change without a migration.
   */
  private findAbandoned(docs: RecallDoc[], withinMs = 5 * 60 * 1000): string[] {
    const spawned = new Map<string, RecallDoc>();
    const out: string[] = [];
    for (const doc of docs) {
      if (doc.origin !== "record") continue;
      const node = doc.nodes[0];
      if (!node) continue;
      if (doc.kind === "spawn") spawned.set(node, doc);
      else if (doc.kind === "close") {
        const start = spawned.get(node);
        if (!start) continue;
        const lived = new Date(doc.at).getTime() - new Date(start.at).getTime();
        if (lived >= 0 && lived <= withinMs) {
          const secs = Math.round(lived / 1000);
          // Only the detail, not the whole summary — that already begins with
          // the node id this line opens with.
          const detail = start.summary.includes(" — ")
            ? ` (${start.summary.split(" — ").slice(1).join(" — ")})`
            : "";
          out.push(`${node} — opened and closed after ${secs}s${detail}`);
        }
        spawned.delete(node);
      }
    }
    return out;
  }

  private load(): RecallDoc[] {
    const files = this.listFiles();
    const signature = files.map((f) => `${f.path}:${f.mtimeMs}`).join("|");
    if (this.cache?.signature === signature) return this.cache.docs;

    const docs: RecallDoc[] = [];
    for (const file of files) {
      try {
        if (file.kind === "record") docs.push(...readRecordFile(file.path));
        else docs.push(...readJournalFile(file.path));
      } catch {
        // One unreadable file must not cost the whole history.
      }
    }
    docs.sort((a, b) => a.at.localeCompare(b.at));
    this.cache = { docs, signature };
    return docs;
  }

  private listFiles(): Array<{ path: string; mtimeMs: number; kind: "record" | "journal" }> {
    const out: Array<{ path: string; mtimeMs: number; kind: "record" | "journal" }> = [];
    const scan = (dir: string | null, kind: "record" | "journal", ext: string) => {
      if (!dir) return;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith(ext)) continue;
          // The journal index lists the notes; surfacing it as a note of its
          // own puts "# Memory Index" in every digest.
          if (kind === "journal" && name.toLowerCase() === "memory.md") continue;
          const p = path.join(dir, name);
          out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs, kind });
        }
      } catch {
        // Directory may not exist yet — an empty history, not an error.
      }
    };
    scan(this.recordDir, "record", ".jsonl");
    scan(this.journalDir(), "journal", ".md");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** One line of prose describing an entry, for a reader rather than a parser. */
function summarize(entry: CaptureEntry): string {
  switch (entry.kind) {
    case "prompt":
      return entry.text ? entry.text.replace(/\s+/g, " ").slice(0, 220) : "(empty prompt)";
    case "spawn":
      return `opened ${entry.node}${entry.detail ? ` — ${entry.detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
    case "wire":
      return `connected ${entry.from} to ${entry.to} (${entry.origin})`;
    case "unwire":
      return `disconnected ${entry.from} from ${entry.to}`;
    case "close":
      return `closed ${entry.node}`;
    case "rename":
      return `renamed ${entry.node} to "${entry.title}"`;
    case "manager":
      return entry.node ? `${entry.node} became the workspace manager` : "workspace manager unassigned";
    case "topology":
      return `canvas: ${entry.terminals} terminals, ${entry.browsers} browsers, ${entry.notes} notes, ${entry.wires.length} wires`;
  }
}

function nodesOf(entry: CaptureEntry): CaptureNodeRef[] {
  switch (entry.kind) {
    case "spawn":
    case "close":
    case "rename":
      return [entry.node];
    case "wire":
    case "unwire":
      return [entry.from, entry.to];
    case "prompt":
      return [entry.actor];
    case "manager":
      return entry.node ? [entry.node] : [];
    case "topology":
      return [];
  }
}

function readRecordFile(filePath: string): RecallDoc[] {
  const docs: RecallDoc[] = [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let entry: CaptureEntry;
    try {
      entry = JSON.parse(line) as CaptureEntry;
    } catch {
      return; // a truncated tail is normal on a hard kill
    }
    const summary = summarize(entry);
    const nodes = nodesOf(entry);
    docs.push({
      id: `${path.basename(filePath)}#${i}`,
      at: entry.at,
      kind: entry.kind,
      origin: "record",
      // Node refs join the searchable text so "what happened with browser-4"
      // works as a plain question, not only as a structural filter.
      text: `${summary} ${nodes.join(" ")}`,
      nodes,
      actor: entry.kind === "prompt" ? entry.actor : undefined,
      // Re-derived rather than trusted: everything recorded before prompts
      // carried an author has no source field, and those entries are exactly
      // the noise the digest must not present as things the user asked for.
      source:
        entry.kind === "prompt"
          ? (entry.source ??
            (entry.text && detectHarnessText(entry.text)
              ? "harness"
              : entry.text && detectLegacyAppText(entry.text)
                ? "app"
                : undefined))
          : undefined,
      summary,
    });
  });
  return docs;
}

/** Journal notes carry name/description front matter; the body is the detail. */
function readJournalFile(filePath: string): RecallDoc[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const front = fm?.[1] ?? "";
  const body = (fm?.[2] ?? raw).trim();
  const description =
    /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ??
    body.split("\n", 1)[0] ??
    path.basename(filePath);

  let at = new Date(fs.statSync(filePath).mtime).toISOString();
  // The manager names journal files with an ISO stamp; prefer it over mtime,
  // which a copy or a sync would rewrite.
  const stamped = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(filePath));
  if (stamped) at = `${stamped[1]}T${stamped[2]}:${stamped[3]}:${stamped[4]}.000Z`;

  return [
    {
      id: path.basename(filePath),
      at,
      kind: "note",
      origin: "journal",
      text: `${description} ${body}`,
      nodes: [...new Set(body.match(/(?:terminal|browser|note):[\w-]+/g) ?? [])],
      summary: description,
    },
  ];
}
