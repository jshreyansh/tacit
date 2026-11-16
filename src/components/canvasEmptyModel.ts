const RECENT_LIMIT = 4;

/**
 * Folders used on the other workdesks, most recent workdesk first, for
 * one-click setup. Comes from the saved workdesks, so it needs nothing new
 * from the main process.
 */
export function recentFolders(
  canvases: readonly { id: string; createdAt: number; scene?: { projects?: readonly { path?: string }[] } }[],
  activeId: string,
  limit = RECENT_LIMIT,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const others = canvases.filter((c) => c.id !== activeId).sort((a, b) => b.createdAt - a.createdAt);
  for (const canvas of others) {
    for (const project of canvas.scene?.projects ?? []) {
      const path = project.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
