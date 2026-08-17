import type { CaptureKind, CaptureNodeRef } from "./capture";

/**
 * Retrieval over the decision record and the workspace journal.
 *
 * ## Why this is not a vector store
 *
 * Measured on real use: 14 entries an hour, 319 bytes each. A year of heavy
 * days is roughly 22,000 entries and 7 MB — a full scan is milliseconds, and
 * the journal is smaller still. Embeddings would mean either a network call
 * per entry, which breaks the local-first promise the whole record exists to
 * keep, or shipping a model, which is a large dependency bought with nothing.
 *
 * The other half of the argument is that most of what a manager needs to ask
 * is not semantic at all. "What did I do with this browser", "what was on the
 * canvas when I abandoned that terminal", "what did the user ask before the
 * retry" are structural questions with exact answers, and the record is
 * structured. Ranking prose is the minority case, and lexical scoring handles
 * it well at this size.
 *
 * So: hard filters for structure, BM25 for prose, recency as a tiebreak. The
 * scorer is a separate step from the filter on purpose — a vector index slots
 * in as an additional signal in `score`, without touching callers or the query
 * shape. The threshold worth revisiting is roughly a hundred thousand entries,
 * or the first time a search obviously misses because the words differed.
 */

export interface RecallQuery {
  /** Free text. Absent means "everything matching the filters, newest first". */
  text?: string;
  kinds?: CaptureKind[];
  /** Anything touching this node — spawned it, wired it, closed it, named it. */
  node?: CaptureNodeRef;
  actor?: string;
  since?: string;
  until?: string;
  /**
   * Injected text is excluded by default. It is the software talking to
   * itself, and including it by default would put the noise this record was
   * just fixed to separate straight back into every answer.
   */
  includeInjected?: boolean;
  limit?: number;
}

export type RecallOrigin = "record" | "journal";

export interface RecallDoc {
  id: string;
  at: string;
  kind: string;
  origin: RecallOrigin;
  /** What gets searched. */
  text: string;
  /** Node refs this touches, for the structural filter. */
  nodes: CaptureNodeRef[];
  actor?: string;
  /** Set on injected prompts; absent means the user. */
  source?: string;
  /** One line for a reader — what this entry actually says. */
  summary: string;
}

export interface RecallHit {
  doc: RecallDoc;
  score: number;
  /** Why it matched, so a reader can judge the answer rather than trust it. */
  why: string[];
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","of","to","in","on","at","for",
  "is","are","was","were","be","been","it","its","this","that","these","those",
  "i","you","we","they","me","my","your","can","do","did","does","with","from",
  "as","by","so","just","not","no","yes","ok","okay",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;
/** A match a week old ranks about half as high as the same match today. */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

function passesFilters(doc: RecallDoc, q: RecallQuery): boolean {
  if (q.kinds?.length && !q.kinds.includes(doc.kind as CaptureKind)) return false;
  if (q.node && !doc.nodes.includes(q.node)) return false;
  if (q.actor && doc.actor !== q.actor) return false;
  if (q.since && doc.at < q.since) return false;
  if (q.until && doc.at > q.until) return false;
  if (!q.includeInjected && doc.source) return false;
  return true;
}

/**
 * Rank documents against a query.
 *
 * Filters are gates, not scores: asking for a specific node means entries
 * about other nodes are wrong answers, not weak ones, and letting a strong
 * text match outrank an explicit structural constraint is how retrieval starts
 * confidently returning the wrong thing.
 */
export function recall(docs: RecallDoc[], query: RecallQuery, now = Date.now()): RecallHit[] {
  const pool = docs.filter((doc) => passesFilters(doc, query));
  const limit = query.limit ?? 20;

  const terms = query.text ? tokenize(query.text) : [];
  if (terms.length === 0) {
    return pool
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((doc) => ({ doc, score: 0, why: ["most recent"] }));
  }

  const tokensByDoc = new Map<string, string[]>();
  const docFreq = new Map<string, number>();
  let totalLength = 0;
  for (const doc of pool) {
    const tokens = tokenize(doc.text);
    tokensByDoc.set(doc.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const avgLength = pool.length > 0 ? totalLength / pool.length : 0;

  const hits: RecallHit[] = [];
  for (const doc of pool) {
    const tokens = tokensByDoc.get(doc.id) ?? [];
    if (tokens.length === 0) continue;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    let score = 0;
    const matched: string[] = [];
    for (const term of new Set(terms)) {
      const tf = counts.get(term);
      if (!tf) continue;
      matched.push(term);
      const df = docFreq.get(term) ?? 0;
      // BM25's idf, with the +1 that keeps a term appearing in every document
      // from going negative and pushing otherwise-good matches below zero.
      const idf = Math.log(1 + (pool.length - df + 0.5) / (df + 0.5));
      const norm = avgLength > 0 ? tokens.length / avgLength : 1;
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm)));
    }
    if (score <= 0) continue;

    // Recency breaks ties rather than dominating: an old decision that matches
    // precisely should still beat a vague recent one.
    const ageMs = Math.max(0, now - new Date(doc.at).getTime());
    const recency = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    hits.push({
      doc,
      score: score * (1 + 0.35 * recency),
      why: [`matched ${matched.join(", ")}`],
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
