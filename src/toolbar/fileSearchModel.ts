/**
 * The navigator's search, for files: every word typed has to be in the
 * file's path (any case). Files whose name holds the words come first, then
 * names that start with them, then shorter paths; a folder's own build and
 * dependency folders are never listed (the file listing leaves out what git
 * ignores).
 */

export interface FileSearchFolder {
  /** The folder's absolute path. */
  path: string;
  /** Its name, shown beside each file. */
  label: string;
  /** Files, relative to the folder. */
  files: readonly string[];
}

export interface FileSearchHit {
  folderPath: string;
  folderLabel: string;
  /** Relative to the folder. */
  relPath: string;
  name: string;
  /** The folders between, for showing where it is. */
  dir: string;
  absPath: string;
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

export function searchFiles(folders: readonly FileSearchFolder[], query: string, limit = 30): { hits: FileSearchHit[]; total: number } {
  const ws = words(query);
  if (ws.length === 0) return { hits: [], total: 0 };
  const scored: Array<{ hit: FileSearchHit; score: number }> = [];
  for (const folder of folders) {
    for (const rel of folder.files) {
      const lower = rel.toLowerCase();
      if (!ws.every((w) => lower.includes(w))) continue;
      const cut = rel.lastIndexOf("/");
      const name = cut < 0 ? rel : rel.slice(cut + 1);
      const lowerName = name.toLowerCase();
      let score = 0;
      for (const w of ws) {
        if (lowerName === w || lowerName.replace(/\.[^.]+$/, "") === w) score += 8;
        else if (lowerName.startsWith(w)) score += 5;
        else if (lowerName.includes(w)) score += 3;
      }
      score -= rel.split("/").length * 0.1;
      const sep = folder.path.includes("\\") && !folder.path.includes("/") ? "\\" : "/";
      scored.push({
        score,
        hit: {
          folderPath: folder.path,
          folderLabel: folder.label,
          relPath: rel,
          name,
          dir: cut < 0 ? "" : rel.slice(0, cut),
          absPath: `${folder.path.replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}`,
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.hit.relPath.length - b.hit.relPath.length || a.hit.relPath.localeCompare(b.hit.relPath));
  return { hits: scored.slice(0, limit).map((s) => s.hit), total: scored.length };
}

/** A line inside a file that holds the text searched for. */
export interface ContentMatch {
  filePath: string;
  line: number;
  preview: string;
}

export interface ContentFileGroup {
  absPath: string;
  name: string;
  folderLabel: string;
  /** The folders between the workdesk folder and the file. */
  dir: string;
  lines: Array<{ line: number; preview: string }>;
}

/**
 * "Search inside files": the matching lines, grouped by file in the order
 * they came, each file under the workdesk folder that holds it, and at
 * most `perFile` lines of one file shown (the rest counted, not listed).
 */
export function groupContentMatches(
  folders: ReadonlyArray<{ path: string; label: string }>,
  matches: readonly ContentMatch[],
  perFile = 3,
): { files: Array<ContentFileGroup & { more: number }>; lines: number } {
  const byPath = new Map<string, ContentFileGroup & { more: number }>();
  const roots = [...folders].sort((a, b) => b.path.length - a.path.length);
  const seen = new Set<string>();
  let lines = 0;
  for (const m of matches) {
    const key = `${m.filePath}\n${m.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines++;
    let group = byPath.get(m.filePath);
    if (!group) {
      const root = roots.find((f) => m.filePath === f.path || m.filePath.startsWith(f.path.replace(/[\\/]+$/, "") + "/") || m.filePath.startsWith(f.path.replace(/[\\/]+$/, "") + "\\"));
      const rel = root ? m.filePath.slice(root.path.replace(/[\\/]+$/, "").length + 1) : m.filePath;
      const parts = rel.split(/[\\/]/);
      group = { absPath: m.filePath, name: parts.pop() ?? rel, folderLabel: root?.label ?? "", dir: parts.join("/"), lines: [], more: 0 };
      byPath.set(m.filePath, group);
    }
    if (group.lines.length < perFile) group.lines.push({ line: m.line, preview: m.preview });
    else group.more++;
  }
  for (const g of byPath.values()) g.lines.sort((a, b) => a.line - b.line);
  return { files: [...byPath.values()], lines };
}
