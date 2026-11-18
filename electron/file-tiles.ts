import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileTileKindByName, isStreamedKind, type FileTileInfo } from "../shared/file-tiles";

/**
 * Files shown on the canvas and in the grid as tiles. The renderer names a
 * file by its path; main checks that it is a file inside one of the
 * workdesk's folders and, for media, hands back a `tc-attachment://file/<id>`
 * URL that streams it (with range requests, so a video can seek). Only files
 * handed out this way are served, so a page in a browser node can't read the
 * disk through the scheme.
 */

/** Text unless the first bytes hold a NUL, as git decides. */
export function looksLikeText(head: Buffer): boolean {
  return !head.includes(0);
}

/**
 * Every folder of every workdesk in the saved state: each folder's path and
 * its worktrees'. The saved state is the source, not the renderer's word.
 */
export function workdeskFolders(state: unknown): string[] {
  const out = new Set<string>();
  const addScene = (scene: unknown) => {
    if (!scene || typeof scene !== "object") return;
    const projects = (scene as { projects?: unknown }).projects;
    if (!Array.isArray(projects)) return;
    for (const project of projects) {
      if (!project || typeof project !== "object") continue;
      const p = project as { path?: unknown; worktrees?: unknown };
      if (typeof p.path === "string" && path.isAbsolute(p.path)) out.add(path.resolve(p.path));
      if (!Array.isArray(p.worktrees)) continue;
      for (const worktree of p.worktrees) {
        const wp = worktree && typeof worktree === "object" ? (worktree as { path?: unknown }).path : null;
        if (typeof wp === "string" && path.isAbsolute(wp)) out.add(path.resolve(wp));
      }
    }
  };
  if (state && typeof state === "object") {
    const s = state as { scene?: unknown; workspace?: unknown };
    addScene(s.scene);
    const canvases = s.workspace && typeof s.workspace === "object" ? (s.workspace as { canvases?: unknown }).canvases : null;
    if (Array.isArray(canvases)) {
      for (const canvas of canvases) {
        if (canvas && typeof canvas === "object") addScene((canvas as { scene?: unknown }).scene);
      }
    }
  }
  return [...out];
}

export function isInsideFolders(filePath: string, folders: readonly string[]): boolean {
  const resolved = path.resolve(filePath);
  return folders.some((folder) => resolved.startsWith(folder + path.sep));
}

export class FileTiles {
  private idByPath = new Map<string, string>();
  private pathById = new Map<string, string>();

  constructor(private readonly folders: () => string[]) {}

  /** What the tile shows for this file, and where its media streams from. */
  inspect(filePath: unknown): FileTileInfo {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return { ok: false, error: "invalid" };
    const resolved = path.resolve(filePath);
    if (!isInsideFolders(resolved, this.folders())) return { ok: false, error: "outside-folders" };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, error: "missing" };
    }
    if (!stat.isFile()) return { ok: false, error: "not-a-file" };
    // A link inside a folder that leads out of it doesn't count.
    if (!isInsideFolders(realPath(resolved), this.folders().map(realPath))) return { ok: false, error: "outside-folders" };
    let kind = fileTileKindByName(resolved);
    if (!kind) {
      kind = "other";
      try {
        const fd = fs.openSync(resolved, "r");
        const head = Buffer.alloc(8192);
        const read = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        kind = looksLikeText(head.subarray(0, read)) ? "text" : "other";
      } catch {
        // Unreadable: shown as a file it can't preview.
      }
    }
    return {
      ok: true,
      kind,
      size: stat.size,
      modified: stat.mtimeMs,
      ...(isStreamedKind(kind) ? { url: `tc-attachment://file/${this.idFor(resolved)}` } : {}),
    };
  }

  /** A path handed out by inspect, still inside a folder; null otherwise. */
  pathFor(id: string): string | null {
    const held = this.pathById.get(id);
    // Checked again as it's served: the folder may have left, or the file changed.
    return held ? this.checked(held) : null;
  }

  /** For opening in its app or Quick Look: the same checks as a tile. */
  checked(filePath: unknown): string | null {
    const info = this.inspect(filePath);
    return info.ok ? path.resolve(filePath as string) : null;
  }

  private idFor(resolved: string): string {
    let id = this.idByPath.get(resolved);
    if (!id) {
      id = randomUUID();
      this.idByPath.set(resolved, id);
      this.pathById.set(id, resolved);
    }
    return id;
  }
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
