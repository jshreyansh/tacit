/**
 * Tacit's memory: what every agent on a workdesk should know, whichever CLI
 * it runs, kept by Tacit rather than by any one agent.
 *
 * ## Scopes
 *
 * - **you**: your preferences and conventions, in every workdesk. Agents
 *   can propose a note here, but it waits for your approval: a bad note in
 *   this scope reaches every agent everywhere.
 * - **workdesk**: its goals, decisions, who's on what, and the handover
 *   brief the manager keeps current. Any agent may add; the manager curates
 *   the handover.
 * - **folder**: facts and how-tos about one repository, shared by all its
 *   worktrees and every CLI.
 * - **worktree**: working notes for one branch.
 *
 * ## Alongside each CLI's own memory
 *
 * Claude Code and Codex keep their own memory, untouched. Tacit reads it
 * (never writes it) so an agent on another CLI gets what Claude learned,
 * and leaves it out of Claude's own brief, which Claude already loads. The
 * rule is that a CLI's memory plus Tacit's is never worse than the CLI's
 * alone, and that Tacit's alone is enough to swap the agent for another.
 *
 * ## Notes
 *
 * Plain markdown files with a small frontmatter, one note per file, named
 * by a slug so writing the same name again updates it. Old facts are marked
 * outdated (with what replaced them), not deleted. Notes shaped by web
 * content wait for approval and never reach a brief before it.
 *
 * Everything in this file is pure; electron/memory-store.ts does the files.
 */

export const MEMORY_SCOPES = ["you", "workdesk", "folder", "worktree"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ["preference", "decision", "howto", "fact", "reference", "event", "handover"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryStatus = "active" | "pending" | "outdated";

/** Why a note waits for approval. */
export type PendingReason = "web" | "you-scope";

export interface MemoryNote {
  /** Slug, unique within its scope's folder; also the file name. */
  name: string;
  scope: MemoryScope;
  kind: MemoryKind;
  /** One line: what this note is. */
  description: string;
  body: string;
  /** "you", "terminal:<id>", or the CLI whose own memory it came from ("claude-memory"). */
  author: string;
  /** The CLI that wrote it (claude, codex…), when an agent did. */
  harness: string | null;
  created: string;
  updated: string;
  status: MemoryStatus;
  pendingReason: PendingReason | null;
  /** Web pages or other outside content shaped it. */
  tainted: boolean;
  /** The note this one replaced. */
  supersedes: string | null;
  /** The note that replaced this one, when outdated. */
  replacedBy: string | null;
  /** Where it came from: sessions, files, pages. */
  sources: string[];
  /** Read from a CLI's own memory (read-only), not written to Tacit's. */
  native: string | null;
  filePath?: string;
}

export interface MemoryDraft {
  name: string;
  kind: MemoryKind;
  description: string;
  body: string;
  author: string;
  harness?: string | null;
  tainted?: boolean;
  sources?: string[];
  /** A note in the same scope this one replaces; it is marked outdated. */
  replaces?: string | null;
}

/** Lowercase, filesystem-safe; also closes off path traversal in agent-given names. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/, "");
  return slug || "note";
}

/**
 * The folder name Claude Code files a project under in ~/.claude/projects:
 * every character that isn't a letter or digit becomes "-" (so
 * `/a/b/.wt/x` is `-a-b--wt-x`).
 */
export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** The older kinds `remember` took, mapped to the new ones. */
export function kindFromLegacyType(type: string | null | undefined): MemoryKind | null {
  switch (type) {
    case "project":
      return "fact";
    case "feedback":
    case "user":
      return "preference";
    case "reference":
      return "reference";
    default:
      return (MEMORY_KINDS as readonly string[]).includes(type ?? "") ? (type as MemoryKind) : null;
  }
}

// ---------------------------------------------------------------------------
// The file format

const encode = (value: string) => JSON.stringify(value);

export function serializeNote(note: MemoryNote): string {
  const lines = [
    `name: ${note.name}`,
    `description: ${encode(note.description.replace(/[\r\n]+/g, " ").trim())}`,
    `scope: ${note.scope}`,
    `kind: ${note.kind}`,
    `status: ${note.status}`,
    ...(note.pendingReason ? [`pending_reason: ${note.pendingReason}`] : []),
    `author: ${encode(note.author)}`,
    `harness: ${encode(note.harness ?? "")}`,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
    `tainted: ${note.tainted}`,
    ...(note.supersedes ? [`supersedes: ${note.supersedes}`] : []),
    ...(note.replacedBy ? [`replaced_by: ${note.replacedBy}`] : []),
    ...(note.sources.length ? [`sources: ${JSON.stringify(note.sources)}`] : []),
  ];
  return `---\n${lines.join("\n")}\n---\n\n${note.body.trim()}\n`;
}

function frontmatterValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

/**
 * Reads a note written by Tacit, or a note from a CLI's own memory (Claude
 * Code's files have `name`, `description` and `type`, at the top or in a
 * `metadata:` block). Null for text with no frontmatter.
 */
export function parseNote(
  text: string,
  defaults: { scope: MemoryScope; fileName: string; mtime?: string; native?: string | null },
): MemoryNote | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fallbackName = slugify(defaults.fileName.replace(/\.md$/i, ""));
  const now = defaults.mtime ?? new Date(0).toISOString();
  if (!match) {
    if (!defaults.native) return null;
    return {
      name: fallbackName,
      scope: defaults.scope,
      kind: "fact",
      description: text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 120) ?? fallbackName,
      body: text.trim(),
      author: defaults.native,
      harness: null,
      created: now,
      updated: now,
      status: "active",
      pendingReason: null,
      tainted: false,
      supersedes: null,
      replacedBy: null,
      sources: [],
      native: defaults.native,
    };
  }
  const fm = match[1];
  const get = (key: string): string | null => {
    const top = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    if (top && top[1].trim()) return frontmatterValue(top[1]);
    const nested = fm.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.+)$`, "m"));
    return nested ? frontmatterValue(nested[1]) : null;
  };
  const status = get("status");
  const sourcesRaw = get("sources");
  let sources: string[] = [];
  if (sourcesRaw) {
    try {
      const parsed = JSON.parse(sourcesRaw);
      if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      sources = [];
    }
  }
  const pending = get("pending_reason");
  const scope = get("scope");
  return {
    name: slugify(get("name") ?? fallbackName),
    scope: (MEMORY_SCOPES as readonly string[]).includes(scope ?? "") ? (scope as MemoryScope) : defaults.scope,
    kind: kindFromLegacyType(get("kind") ?? get("type")) ?? "fact",
    description: get("description") ?? fallbackName,
    body: match[2].trim(),
    author: get("author") ?? defaults.native ?? "unknown",
    harness: get("harness") || null,
    created: get("created") ?? now,
    updated: get("updated") ?? get("modified") ?? now,
    status: status === "pending" || status === "outdated" ? status : "active",
    pendingReason: pending === "web" || pending === "you-scope" ? pending : null,
    tainted: get("tainted") === "true",
    supersedes: get("supersedes"),
    replacedBy: get("replaced_by"),
    sources,
    native: defaults.native ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writing: update, don't append

export type WritePlan =
  | { action: "skip"; reason: "unchanged" | "duplicate"; existing: MemoryNote }
  | { action: "add" | "update"; note: MemoryNote; outdated: MemoryNote | null };

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * What writing `draft` into a scope that holds `existing` does:
 * - the same name updates that note in place (keeping when it was created);
 * - the same text as another live note is a repeat, and is skipped;
 * - `replaces` marks the named note outdated, pointing at the new one;
 * - a note shaped by web content, or an agent's note about you, waits for
 *   your approval.
 */
export function planWrite(
  existing: readonly MemoryNote[],
  scope: MemoryScope,
  draft: MemoryDraft,
  now: string,
): WritePlan {
  const name = slugify(draft.name);
  const same = existing.find((n) => n.name === name) ?? null;
  const body = draft.body.trim();
  const description = draft.description.replace(/[\r\n]+/g, " ").trim();

  if (same && normalize(same.body) === normalize(body) && same.description === description && same.status !== "outdated") {
    return { action: "skip", reason: "unchanged", existing: same };
  }
  const repeat = existing.find((n) => n.name !== name && n.status !== "outdated" && normalize(n.body) === normalize(body));
  if (repeat) return { action: "skip", reason: "duplicate", existing: repeat };

  const tainted = draft.tainted === true;
  const pendingReason: PendingReason | null = tainted ? "web" : scope === "you" && draft.author !== "you" ? "you-scope" : null;

  const replacesName = draft.replaces ? slugify(draft.replaces) : null;
  const replaced = replacesName && replacesName !== name ? existing.find((n) => n.name === replacesName) ?? null : null;

  const note: MemoryNote = {
    name,
    scope,
    kind: draft.kind,
    description,
    body,
    author: draft.author,
    harness: draft.harness ?? null,
    created: same?.created ?? now,
    updated: now,
    status: pendingReason ? "pending" : "active",
    pendingReason,
    tainted,
    supersedes: replaced?.name ?? same?.supersedes ?? null,
    replacedBy: null,
    sources: [...new Set([...(same?.sources ?? []), ...(draft.sources ?? [])])].slice(-10),
    native: null,
  };
  const outdated = replaced ? { ...replaced, status: "outdated" as const, replacedBy: name, updated: now } : null;
  return { action: same ? "update" : "add", note, outdated };
}

// ---------------------------------------------------------------------------
// The brief every agent gets at start

export interface BriefInput {
  /** The CLI the brief is for: its own memory is left out, since it loads that itself. */
  harness: string | null;
  role: "manager" | "worker";
  you: readonly MemoryNote[];
  workdesk: readonly MemoryNote[];
  folder: readonly MemoryNote[];
  worktree: readonly MemoryNote[];
  /** Notes read from each CLI's own memory for this folder, keyed by CLI. */
  native: Readonly<Record<string, readonly MemoryNote[]>>;
  folderLabel: string | null;
  worktreeLabel: string | null;
  /** For a manager: what the person has been asking for lately, from the record. */
  digest?: string | null;
  /** Characters; the brief stops adding notes past it and lists the rest by title. */
  budget?: number;
}

/** What an agent was told at launch, for showing it ("Started with memory"). */
export interface LaunchBrief {
  at: string;
  harness: string | null;
  words: number;
  items: Array<{
    scope: MemoryScope;
    name: string;
    description: string;
    /** The CLI whose own memory it came from, or null for Tacit's. */
    native: string | null;
    /** Only its title was given, for lack of room. */
    listed: boolean;
  }>;
  /** Notes left out entirely, for lack of room. */
  omitted: number;
}

export interface Brief {
  text: string;
  /** "scope/name" of each note given in full. */
  included: string[];
  /** Notes only listed by title, for lack of room. */
  listed: string[];
  /** Live notes left out entirely. */
  omitted: number;
}

/** The harness each CLI's own memory belongs to (what it loads itself). */
const NATIVE_OWNER: Record<string, string> = { "claude-memory": "claude", "codex-memory": "codex" };

export const NATIVE_LABEL: Record<string, string> = { "claude-memory": "Claude", "codex-memory": "Codex" };

const KIND_ORDER: Record<MemoryKind, number> = {
  handover: 0,
  preference: 1,
  decision: 2,
  howto: 3,
  fact: 4,
  reference: 5,
  event: 6,
};

export const DEFAULT_BRIEF_BUDGET = 9000;
/** A CLI that already loads its own memory gets less of Tacit's, so the two together stay in budget. */
export const BRIEF_BUDGET_WITH_NATIVE = 6000;
const NOTE_BODY_LIMIT = 600;

const live = (n: MemoryNote) => n.status === "active";

function byPriority(a: MemoryNote, b: MemoryNote): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.updated.localeCompare(a.updated);
}

function renderNote(note: MemoryNote): string {
  const body = note.body.replace(/\n{3,}/g, "\n\n").trim();
  const clipped = body.length > NOTE_BODY_LIMIT ? `${body.slice(0, NOTE_BODY_LIMIT).trimEnd()}… (recall "${note.name}" for the rest)` : body;
  const from = note.native ? ` _(from ${NATIVE_LABEL[note.native] ?? note.native}'s own memory)_` : "";
  const indented = clipped.split("\n").join("\n  ");
  return `- **${note.description}**${from}${indented ? `\n  ${indented}` : ""}`;
}

/**
 * Where an agent is, in one line: said first, since some CLIs show only the
 * start of a server's instructions. Codex, told only about memory, looked for
 * the canvas with screenshots before it found the tool.
 */
export const TACIT_PLACE =
  "Tacit is the app you run in. Its canvas is where the person draws and puts things: when they say my canvas, what I drew or sketched, or the note, picture or file I added, call `read_canvas` (a `tacit` tool), not screenshots or computer use.";

export const MEMORY_HOW_TO = [
  "How to use it:",
  "- Before starting a piece of work (not a quick question), `recall` it: it searches these notes, the decision record and the workdesk's history.",
  "- Save as you go, with `remember`, in the same turn you learn it. Don't just keep it in mind: your context ends with this session, and the next agent may be a different CLI. Save when:",
  "  - the person corrects you, or says something in the repo (README, docs, a comment) is wrong or out of date;",
  "  - the person states a decision, a rule or a preference (\"we always…\", \"never…\", \"from now on…\");",
  "  - you find something non-obvious that cost effort to learn (a gotcha, a working command, why something is the way it is).",
  "- Choose the scope: `you` for the person's own preferences (they approve it), `workdesk` for goals, decisions and who's on what, `folder` for facts, rules and how-tos about this repository, `worktree` for notes about this branch only.",
  "- Same `name` updates a note; pass `replaces` when a note makes another one wrong. Don't save what the code or git history already says, or anything secret.",
].join("\n");

/**
 * The brief: what an agent should know before its first message, from every
 * scope it is in, within a budget. Handover and preferences come first, then
 * decisions, how-tos and facts, newest first. Notes from the agent's own
 * CLI memory are left out (it loads them itself); notes from another CLI's
 * memory are included, marked as such, so a Codex agent knows what Claude
 * learned. Pending and outdated notes are never included.
 */
export function buildBrief(input: BriefInput): Brief {
  const budget = input.budget ?? DEFAULT_BRIEF_BUDGET;
  const included: string[] = [];
  const listed: string[] = [];
  let omitted = 0;

  const nativeForOthers: MemoryNote[] = [];
  for (const [owner, notes] of Object.entries(input.native)) {
    if (input.harness && NATIVE_OWNER[owner] === input.harness) continue;
    nativeForOthers.push(...notes.filter(live));
  }
  // A Tacit note and a CLI's note on the same subject: the newer one wins.
  const folderNames = new Map(input.folder.filter(live).map((n) => [n.name, n]));
  const nativeKept = nativeForOthers.filter((n) => {
    const tacit = folderNames.get(n.name);
    return !tacit || n.updated > tacit.updated;
  });
  const folderKept = input.folder.filter(live).filter((n) => !nativeForOthers.some((m) => m.name === n.name && m.updated > n.updated));

  const workdesk = input.workdesk.filter(live).filter((n) => input.role === "manager" || n.kind !== "event");
  const handover = workdesk.filter((n) => n.kind === "handover");
  const desk = workdesk.filter((n) => n.kind !== "handover" && n.kind !== "event").sort(byPriority);
  const events = input.role === "manager" ? workdesk.filter((n) => n.kind === "event").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8) : [];

  const sections: Array<{ title: string; notes: MemoryNote[] }> = [
    { title: "About you (the person)", notes: input.you.filter(live).sort(byPriority) },
    { title: "This workdesk: handover", notes: handover },
    { title: "This workdesk: goals and decisions", notes: desk },
    { title: `This folder${input.folderLabel ? ` (${input.folderLabel})` : ""}`, notes: [...folderKept, ...nativeKept].sort(byPriority) },
    { title: `This worktree${input.worktreeLabel ? ` (${input.worktreeLabel})` : ""}`, notes: input.worktree.filter(live).sort(byPriority) },
    { title: "Recent workdesk activity", notes: events },
  ];

  const head = [
    TACIT_PLACE,
    "",
    "# Tacit memory",
    "",
    "What Tacit's agents have learned about this person, this workdesk and this folder, shared by every agent whichever CLI it runs. Trust it like notes from a teammate: check anything that may have changed before relying on it.",
    "",
    MEMORY_HOW_TO,
  ].join("\n");

  let used = head.length;
  const out: string[] = [head];
  for (const section of sections) {
    if (section.notes.length === 0) continue;
    const lines: string[] = [];
    const titleOnly: string[] = [];
    const header = `\n## ${section.title}\n`;
    let sectionUsed = header.length;
    for (const note of section.notes) {
      const rendered = renderNote(note);
      if (used + sectionUsed + rendered.length + 1 <= budget) {
        lines.push(rendered);
        sectionUsed += rendered.length + 1;
        included.push(`${note.scope}/${note.name}`);
        continue;
      }
      const title = `- ${note.description} (\`recall\` "${note.name}")`;
      if (used + sectionUsed + title.length + 1 <= budget + 600) {
        titleOnly.push(title);
        sectionUsed += title.length + 1;
        listed.push(`${note.scope}/${note.name}`);
      } else {
        omitted += 1;
      }
    }
    if (lines.length === 0 && titleOnly.length === 0) continue;
    out.push(header + [...lines, ...(titleOnly.length ? ["More, by title:", ...titleOnly] : [])].join("\n"));
    used += sectionUsed;
  }

  if (input.role === "manager" && input.digest && input.digest.trim()) {
    const digest = `\n## What has been going on (from the decision record)\n${input.digest.trim()}`;
    if (used + digest.length <= budget + 1500) {
      out.push(digest);
      used += digest.length;
    }
  }

  return { text: out.join("\n"), included, listed, omitted };
}

// ---------------------------------------------------------------------------
// Search

export interface MemoryHit {
  note: MemoryNote;
  score: number;
}

/** Notes matching every word of the query, title matches first, then newest. */
export function searchNotes(notes: readonly MemoryNote[], query: string, opts: { includeOutdated?: boolean; limit?: number } = {}): MemoryHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: MemoryHit[] = [];
  for (const note of notes) {
    if (note.status === "outdated" && !opts.includeOutdated) continue;
    if (note.status === "pending") continue;
    const title = `${note.name} ${note.description}`.toLowerCase();
    const text = `${title} ${note.body.toLowerCase()}`;
    if (words.length && !words.every((w) => text.includes(w))) continue;
    const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 1), 0);
    hits.push({ note, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.note.updated.localeCompare(a.note.updated))
    .slice(0, opts.limit ?? 20);
}

// ---------------------------------------------------------------------------
// The Memory view (src/components/MemoryView.tsx) and its IPC

export interface MemoryViewRequest {
  /** The workdesk's memory, about you, and what waits for review. */
  workdeskId?: string | null;
  /** A folder's memory: its own, its worktrees', and each CLI's for it. */
  folder?: string | null;
  /** The folder's worktrees the renderer knows, to show their notes. */
  worktrees?: string[];
}

export interface MemoryViewData {
  you: MemoryNote[];
  workdesk: MemoryNote[];
  pending: MemoryNote[];
  folder: MemoryNote[];
  folderPath: string | null;
  worktrees: Array<{ path: string; notes: MemoryNote[] }>;
  /** Each CLI's own memory for the folder, read-only. */
  native: Array<{ cli: string; dir: string; notes: MemoryNote[] }>;
}

export type MemoryAction =
  | { action: "approve" | "restore" | "forget" | "delete"; filePath: string }
  | { action: "edit"; filePath: string; description?: string; body?: string }
  | {
      action: "add";
      scope: MemoryScope;
      workdeskId?: string | null;
      folder?: string | null;
      kind: MemoryKind;
      name: string;
      description: string;
      body: string;
    };
