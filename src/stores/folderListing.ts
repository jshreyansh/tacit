// Pure helpers for a project the Files panel loads a folder at a time.
//
// Folders are keyed by their path relative to the project, with a trailing
// "/" as the tree uses for directories: "" is the project itself, "src/" a
// folder in it. A loaded folder's value lists its entries the same way:
// "src/main.ts" for a file, "src/lib/" for a folder.

export interface FolderEntry {
  name: string;
  isDirectory: boolean;
}

/** A folder's entries as tree paths. */
export function entryPaths(folder: string, entries: readonly FolderEntry[]): string[] {
  return entries.map((entry) => `${folder}${entry.name}${entry.isDirectory ? "/" : ""}`);
}

/** Every path the tree should show: the entries of every loaded folder. */
export function loadedPaths(folders: Readonly<Record<string, readonly string[]>>): string[] {
  const paths: string[] = [];
  for (const entries of Object.values(folders)) paths.push(...entries);
  return paths;
}

/**
 * The folders after `folder` is (re)listed as `entries`: loaded folders
 * beneath it that are no longer there are dropped, with everything under
 * them. Returns the new map and the folders dropped.
 */
export function withFolderListed(
  folders: Readonly<Record<string, readonly string[]>>,
  folder: string,
  entries: readonly string[],
): { folders: Record<string, readonly string[]>; dropped: string[] } {
  const present = new Set(entries.filter((path) => path.endsWith("/")));
  const next: Record<string, readonly string[]> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(folders)) {
    const gone = key !== folder && key.startsWith(folder) && !present.has(childFolderOf(folder, key));
    if (gone) dropped.push(key);
    else next[key] = value;
  }
  next[folder] = entries;
  return { folders: next, dropped };
}

/** Drops `folder` and every loaded folder beneath it. */
export function withoutFolder(
  folders: Readonly<Record<string, readonly string[]>>,
  folder: string,
): { folders: Record<string, readonly string[]>; dropped: string[] } {
  const next: Record<string, readonly string[]> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(folders)) {
    if (key.startsWith(folder)) dropped.push(key);
    else next[key] = value;
  }
  return { folders: next, dropped };
}

/**
 * The folder to load along with `folder`, when its only entry is a folder.
 * The tree shows such chains as one row ("src/main/java"), and opening that
 * row opens the last folder in it, so the chain loads together (VS Code's
 * explorer does the same). Bounded, so a link that points at its own parent
 * can't chain forever.
 */
export function onlyChildFolder(folder: string, entries: readonly string[]): string | null {
  if (entries.length !== 1 || !entries[0].endsWith("/")) return null;
  if (folder.split("/").length > MAX_CHAIN_DEPTH) return null;
  return entries[0];
}

const MAX_CHAIN_DEPTH = 32;

/** Listed folders not yet loaded or known to be unreadable: the ones to load when opened. */
export function unloadedFolders(
  paths: readonly string[],
  folders: Readonly<Record<string, unknown>>,
  unreadable: Readonly<Record<string, unknown>>,
): string[] {
  return paths.filter((path) => path.endsWith("/") && !(path in folders) && !(path in unreadable));
}

/** The folder key for an absolute path inside `root`, or null when it is outside. */
export function folderKeyFor(root: string, absolutePath: string): string | null {
  if (absolutePath === root) return "";
  if (!absolutePath.startsWith(`${root}/`)) return null;
  return `${absolutePath.slice(root.length + 1)}/`;
}

/** The absolute path of a folder key. */
export function folderPathFor(root: string, folder: string): string {
  return folder ? `${root}/${folder.slice(0, -1)}` : root;
}

// "src/lib/deep/" under "src/" → "src/lib/".
function childFolderOf(folder: string, descendant: string): string {
  const rest = descendant.slice(folder.length);
  return `${folder}${rest.slice(0, rest.indexOf("/") + 1)}`;
}
