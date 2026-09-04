/**
 * Chrome's Local Storage, staged into an Electron partition.
 *
 * Cookies alone do not restore a session on the sites that matter most. Google,
 * Gmail and Drive keep signed-in state in Local Storage, so a cookies-only
 * import behaves like a working feature everywhere except the first place a
 * user is likely to try it — and fails there with no error, which reads as "the
 * app is broken" rather than "one format is not supported yet".
 *
 * Local Storage is a LevelDB directory, and unlike IndexedDB it is portable
 * between the Chrome that wrote it and the Chromium that Electron ships. Its
 * values are plain bytes behind a one-byte encoding tag, its key grammar
 * (`VERSION`, `META:<origin>`, `_<origin>\0<key>`) has been stable since M69,
 * and it uses LevelDB's default bytewise comparator. IndexedDB is the opposite
 * and must never be copied this way: its records are V8 serialisation wire
 * format, and a one-version mismatch wipes the database with no error raised.
 *
 * The failure mode here is deliberately benign. If the staged database is not
 * one this Chromium can open, LevelDB refuses it and the partition comes up
 * with empty Local Storage — the user is signed out, not corrupted. That
 * asymmetry against IndexedDB is the entire reason this is worth doing.
 *
 * Nothing here writes to the Chrome profile. The source is opened read-only,
 * and the only directory this module creates or removes is the `Local Storage`
 * tree inside a partition it has just been given.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * LevelDB's own file grammar. Anything outside it is not database state:
 * `LOCK` belongs to whichever process opens the database and must never be
 * inherited, and `LOG`/`LOG.old` are human-readable diagnostics that would only
 * carry one browser's history into another.
 */
const LEVELDB_DATA_FILE = /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:ldb|log|sst))$/;

/**
 * A ceiling on what one profile may stage. Local Storage is normally single
 * -digit megabytes; anything approaching this is pathological, and refusing is
 * better than blocking an import behind a multi-gigabyte copy.
 */
const MAX_STAGED_BYTES = 512 * 1024 * 1024;

/** How much of the staged database is scanned to describe it. See `countOrigins`. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

const META_PREFIX = Buffer.from("META:");
const MAX_ORIGIN_LENGTH = 255;

/**
 * The comparator a staged database must declare.
 *
 * A LevelDB records its key comparator in the MANIFEST, and refuses to open
 * under a different one. This constant is not a guess about Chromium: it is
 * LevelDB's own built-in comparator name, fixed in LevelDB's source, so every
 * Chromium that links LevelDB writes exactly this for Local Storage. Comparing
 * against it is comparing against what the destination writes.
 *
 * It is also the check that catches the dangerous mistake. IndexedDB is a
 * LevelDB too, sitting one directory away, and it declares `idb_cmp1` — so a
 * source that ever pointed there is refused here rather than copied into a
 * partition where opening it would rebuild and wipe it.
 */
const REQUIRED_COMPARATOR = "leveldb.BytewiseComparator";

/** The comparator is written in the MANIFEST's first record. */
const MANIFEST_HEADER_BYTES = 8 * 1024;

export interface SiteStorageStageResult {
  /**
   * `imported` when a database was staged, `empty` when the profile had none to
   * stage, `unsupported` when one exists in a format this build will not move,
   * `failed` when one existed and the copy itself did not work. Never
   * `partial`: half a LevelDB is not a smaller LevelDB, so a copy that cannot
   * finish is removed and reported as a failure.
   */
  status: "imported" | "empty" | "unsupported" | "failed";
  /**
   * Origins observed in the staged database. A floor, not a census — LevelDB
   * compacts older keys into compressed blocks this scan cannot read, so the
   * true number is this or higher. It is reported because it is a useful
   * description of what moved, and it is deliberately never allowed to decide
   * anything: `status` is driven by whether the copy succeeded.
   */
  origins: number;
  files: number;
  bytes: number;
  detail?: string;
}

function emptyResult(detail: string): SiteStorageStageResult {
  return { status: "empty", origins: 0, files: 0, bytes: 0, detail };
}

function failedResult(detail: string): SiteStorageStageResult {
  return { status: "failed", origins: 0, files: 0, bytes: 0, detail };
}

function unsupportedResult(detail: string): SiteStorageStageResult {
  return { status: "unsupported", origins: 0, files: 0, bytes: 0, detail };
}

/**
 * Whether the database at `sourceDir` is one this build will move.
 *
 * The gate exists to keep the reported status honest, not to prevent damage:
 * an unopenable database would leave Chromium with empty Local Storage rather
 * than a broken profile. But it would leave provenance claiming `imported` for
 * a profile that is in fact signed out, and a record that lies is worse than a
 * category that admits it did nothing.
 */
function readComparator(sourceDir: string, manifestName: string): string | null {
  let header: Buffer;
  try {
    const handle = fs.openSync(path.join(sourceDir, manifestName), "r");
    try {
      header = Buffer.alloc(MANIFEST_HEADER_BYTES);
      const read = fs.readSync(handle, header, 0, MANIFEST_HEADER_BYTES, 0);
      header = header.subarray(0, read);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  // The name is a length-prefixed slice inside a VersionEdit record, so it is
  // plain ASCII in the bytes with no framing this needs to decode.
  return header.includes(REQUIRED_COMPARATOR) ? REQUIRED_COMPARATOR : null;
}

/**
 * Copies a Chrome profile's Local Storage database into a partition directory.
 *
 * Must run before anything opens a session on that partition. Chromium opens
 * the Local Storage database lazily and holds it for the life of the process,
 * so staging afterwards would either be ignored or land under a live writer.
 *
 * Never throws. Local Storage is an improvement on top of cookies, not a
 * precondition for them, so a profile whose site storage cannot be staged still
 * imports — with the reason recorded on the returned result, which the caller
 * persists into the identity's provenance.
 */
export function stageChromeLocalStorage(
  sourceProfileRoot: string,
  partitionDirectory: string,
): SiteStorageStageResult {
  const sourceDir = path.join(sourceProfileRoot, "Local Storage", "leveldb");
  const targetDir = path.join(partitionDirectory, "Local Storage", "leveldb");

  let sourceEntries: fs.Dirent[];
  try {
    if (!fs.existsSync(sourceDir)) {
      return emptyResult("Chrome profile has no Local Storage database");
    }
    sourceEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    return failedResult(`Chrome's Local Storage could not be read (${errorLabel(error)})`);
  }

  // A LevelDB is only openable via CURRENT, which names the live MANIFEST.
  // Without both there is no database here to move, whatever else is lying
  // around, and staging the remainder would produce a directory Chromium
  // rejects rather than a working profile.
  const names = new Set(sourceEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const manifests = [...names].filter((name) => name.startsWith("MANIFEST-"));
  if (!names.has("CURRENT") || manifests.length === 0) {
    return emptyResult("Chrome profile has no complete Local Storage database");
  }

  if (!manifests.some((manifest) => readComparator(sourceDir, manifest))) {
    return unsupportedResult(
      "Chrome's Local Storage uses a key order this build does not import",
    );
  }

  const copyable: string[] = [];
  let totalBytes = 0;
  for (const entry of sourceEntries) {
    // `isFile` on a Dirent is already an lstat: a symlink reports false here,
    // so nothing outside the profile directory can be followed into the copy.
    if (!entry.isFile() || !LEVELDB_DATA_FILE.test(entry.name)) continue;
    let size: number;
    try {
      size = fs.statSync(path.join(sourceDir, entry.name)).size;
    } catch (error) {
      return failedResult(`Chrome's Local Storage could not be read (${errorLabel(error)})`);
    }
    totalBytes += size;
    if (totalBytes > MAX_STAGED_BYTES) {
      return failedResult("Chrome's Local Storage is too large to import");
    }
    copyable.push(entry.name);
  }
  if (copyable.length === 0) return emptyResult("Chrome profile has no Local Storage database");

  // Refusing a target that already holds a database is what keeps this
  // one-directional. Staging is only ever correct into a partition that has
  // never been opened; overwriting a populated one would discard whatever the
  // user has since signed into inside Tacit.
  try {
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      return failedResult("This profile already has site storage; it was left untouched");
    }
  } catch (error) {
    return failedResult(`The profile's storage could not be inspected (${errorLabel(error)})`);
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return failedResult(`The profile's storage could not be created (${errorLabel(error)})`);
  }

  try {
    for (const name of copyable) {
      fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
    }
  } catch (error) {
    // A partially copied LevelDB is not a partially working one — CURRENT can
    // name a MANIFEST that never arrived. Remove what was written so the
    // partition falls back to having no Local Storage, which is a state
    // Chromium handles, rather than one it refuses.
    discardStagedDirectory(targetDir);
    return failedResult(`Chrome's Local Storage could not be copied (${errorLabel(error)})`);
  }

  const origins = countOrigins(targetDir, copyable);
  return {
    status: "imported",
    origins,
    files: copyable.length,
    bytes: totalBytes,
    // The caveat travels with the number. This detail is persisted onto the
    // identity's provenance, where a reader months later has no other way to
    // know that the origin count is a lower bound.
    detail: `${origins} origins or more across ${copyable.length} database files, ${Math.round(totalBytes / 1024)} KB`,
  };
}

/**
 * Removes only the `Local Storage` tree this function created, and only after
 * confirming it sits under the partition directory it was given. The partition
 * itself is not this module's to delete — a failed stage leaves the import to
 * carry on with cookies alone.
 */
function discardStagedDirectory(targetDir: string): void {
  try {
    const localStorageDir = path.dirname(path.resolve(targetDir));
    if (path.basename(localStorageDir) !== "Local Storage") return;
    fs.rmSync(localStorageDir, { recursive: true, force: true });
  } catch {
    // Leaving the directory behind is survivable: Chromium will refuse to open
    // an incomplete database and start with empty Local Storage. Failing the
    // whole import over a cleanup that did not land would be worse.
  }
}

/**
 * Counts distinct `META:<origin>` keys visible in the raw database bytes.
 *
 * This reads the files as bytes rather than as a LevelDB. Keys written recently
 * live in the uncompressed write-ahead log and in block restart points, and are
 * plainly visible; keys that have been compacted into compressed blocks are
 * not. The result is therefore a lower bound, which is why it is only ever used
 * to describe an import and never to decide whether one worked.
 */
function countOrigins(directory: string, fileNames: readonly string[]): number {
  const origins = new Set<string>();
  let budget = MAX_SCAN_BYTES;
  for (const name of fileNames) {
    if (budget <= 0) break;
    let contents: Buffer;
    try {
      contents = fs.readFileSync(path.join(directory, name));
    } catch {
      continue;
    }
    budget -= contents.length;
    for (let at = contents.indexOf(META_PREFIX); at !== -1; at = contents.indexOf(META_PREFIX, at + 1)) {
      const origin = readOrigin(contents, at + META_PREFIX.length);
      if (origin) origins.add(origin);
    }
  }
  return origins.size;
}

function readOrigin(contents: Buffer, start: number): string | null {
  let end = start;
  while (end < contents.length && end - start < MAX_ORIGIN_LENGTH) {
    const byte = contents[end]!;
    // Origins are ASCII and end at the first byte that cannot appear in one,
    // which in LevelDB's packed keys is whatever length or tag byte follows.
    const isOriginByte =
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x2d || byte === 0x2e || byte === 0x3a || byte === 0x2f; // - . : /
    if (!isOriginByte) break;
    end += 1;
  }
  const candidate = contents.subarray(start, end).toString("ascii");
  return candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : null;
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
