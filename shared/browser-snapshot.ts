/**
 * A page as an agent reads it: a short outline of what can be clicked, typed
 * into or read, one line each, with a handle to point at (`[e12]`, `[f1e3]`
 * inside the first frame). Built from what PAGE_SCRIPT finds in each frame
 * (shared/browser-page-script.ts); this file only puts the frames together,
 * keeps it within a size, and says what changed. Pure, so it is tested alone.
 */

export interface SnapshotEntry {
  ref: string;
  depth: number;
  role: string;
  name: string;
  value: string;
  states: string[];
  level?: string;
  offscreen?: boolean;
  iframe?: boolean;
  file?: boolean;
}

export interface FrameSnapshot {
  /** "" for the page itself, "f1", "f2"… for frames inside it. */
  prefix: string;
  entries: SnapshotEntry[];
  truncated?: boolean;
  /** The frame it sits in, and the handle of its <iframe> there; absent for the page. */
  parentPrefix?: string;
  ownerRef?: string | null;
}

export const qualified = (prefix: string, ref: string): string => `${prefix}${ref}`;

/** One entry as a line: `- button "Save" [e12] (disabled)`. */
export function entryLine(e: SnapshotEntry, prefix: string, depth = e.depth): string {
  const role = e.role === "heading" && e.level ? `heading[${e.level}]` : e.role;
  const name = e.name ? ` "${e.name.replace(/"/g, "'")}"` : "";
  const value = e.value ? `: ${e.value}` : "";
  const states = e.states.length ? ` (${e.states.join(", ")})` : "";
  const off = e.offscreen ? " ↓" : "";
  return `${"  ".repeat(depth)}- ${role}${name}${value} [${qualified(prefix, e.ref)}]${states}${off}`;
}

/** The page's frames as one outline: each frame's lines under its <iframe> line. */
export function snapshotLines(frames: readonly FrameSnapshot[]): string[] {
  const byParent = new Map<string, FrameSnapshot[]>();
  for (const f of frames) {
    if (f.parentPrefix === undefined) continue;
    byParent.set(f.parentPrefix, [...(byParent.get(f.parentPrefix) ?? []), f]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const emit = (frame: FrameSnapshot, base: number) => {
    if (seen.has(frame.prefix)) return;
    seen.add(frame.prefix);
    const children = byParent.get(frame.prefix) ?? [];
    for (const e of frame.entries) {
      out.push(entryLine(e, frame.prefix, e.depth + base));
      if (e.iframe) for (const c of children.filter((c) => c.ownerRef === e.ref)) emit(c, e.depth + base + 1);
    }
    // Frames whose <iframe> line wasn't shown (hidden, or past the size limit) still count.
    for (const c of children) if (!seen.has(c.prefix)) {
      out.push(`${"  ".repeat(base)}- iframe [${c.prefix}]`);
      emit(c, base + 1);
    }
  };
  const root = frames.find((f) => f.parentPrefix === undefined);
  if (root) emit(root, 0);
  for (const f of frames) if (!seen.has(f.prefix)) emit(f, 0);
  return out;
}

/** Within `maxChars`, whole lines only, saying how much was left out. */
export function capLines(lines: readonly string[], maxChars: number): { text: string; truncated: boolean; shown: number } {
  let used = 0;
  let shown = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    shown++;
  }
  const truncated = shown < lines.length;
  const text = lines.slice(0, shown).join("\n") + (truncated ? `\n… ${lines.length - shown} more lines not shown: snapshot again with a larger maxChars, or use browser_find.` : "");
  return { text, truncated, shown };
}

/**
 * What changed between two outlines of the same page: lines that went, lines that came.
 * A line that only scrolled into or out of view (its ↓) hasn't changed.
 */
export function diffLines(before: readonly string[], after: readonly string[], max = 40): { added: string[]; removed: string[]; more: number } {
  const keyOf = (l: string) => l.trim().replace(/ ↓$/, "");
  const was = new Map<string, string[]>();
  for (const l of before) was.set(keyOf(l), [...(was.get(keyOf(l)) ?? []), l.trim()]);
  const added: string[] = [];
  for (const l of after) {
    const left = was.get(keyOf(l));
    if (left?.length) left.pop();
    else added.push(l.trim());
  }
  const removed: string[] = [];
  for (const lines of was.values()) removed.push(...lines);
  const more = Math.max(0, added.length + removed.length - max);
  return { added: added.slice(0, max), removed: removed.slice(0, Math.max(0, max - Math.min(max, added.length))), more };
}

/** "f2e15" → { prefix: "f2", ref: "e15" }; "e3" → { prefix: "", ref: "e3" }. */
export function parseRef(input: string): { prefix: string; ref: string } | null {
  const m = /^(f\d{1,4})?(e\d{1,7})$/.exec(input.trim());
  return m ? { prefix: m[1] ?? "", ref: m[2] } : null;
}

/** Lines whose text holds every word of the query: find without reading the whole page. */
export function findLines(lines: readonly string[], query: string, max = 30): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return lines.filter((l) => words.every((w) => l.toLowerCase().includes(w))).map((l) => l.trim()).slice(0, max);
}
