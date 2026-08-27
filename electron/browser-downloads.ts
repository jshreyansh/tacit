/**
 * Where a file downloaded inside a browser node goes, and what the user is
 * told about it.
 *
 * A download that silently does nothing is one of the cheapest ways to lose a
 * session: the user assumes the embedded browser cannot do it, opens Chrome,
 * and everything after that is invisible to the record. So downloads work — but
 * on Tacit's terms, not the page's:
 *
 *  - **The page never picks the path.** The destination is always the OS
 *    Downloads folder; the page contributes a *name*, which is sanitised down
 *    to a single path segment. A suggested filename is attacker-controlled
 *    input in every meaningful sense, and `path.join` is happy to walk out of a
 *    directory when handed one.
 *  - **Nothing is opened.** Fetching a file is the user's decision; running it
 *    is a second one, and the app does not get to make the second one on their
 *    behalf.
 *  - **Nothing is overwritten.** A second `invoice.pdf` becomes
 *    `invoice (1).pdf`, the way every browser does it, because silently
 *    replacing a file the user already had is data loss caused by a click that
 *    did not ask for it.
 *
 * The path arithmetic lives here rather than in main.ts so it can be tested
 * against hostile names without an Electron download to drive it.
 */

import path from "path";

/**
 * Filesystem-hostile characters: control codes, the path separators of both
 * platforms, and the punctuation Windows refuses outright.
 */
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** Long enough for real names; short enough to survive every filesystem. */
export const MAX_DOWNLOAD_FILENAME_LENGTH = 120;

/** Used when the page suggests nothing usable at all. */
export const FALLBACK_DOWNLOAD_FILENAME = "download";

/**
 * Windows refuses these as filenames whatever the extension, and a failed
 * `setSavePath` surfaces as a download that vanishes with no explanation.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Split at the LAST dot, so `archive.tar.gz` keeps `.gz` and not `.tar.gz`. */
function splitExtension(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension: `.bashrc` has no stem to
  // number, and treating it as one produces ` (1).bashrc`.
  if (dot <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, dot), ext: filename.slice(dot) };
}

/**
 * Reduce a page-supplied name to one safe path segment.
 *
 * Note what this does NOT do: it does not try to decide whether the extension
 * is dangerous. Judging that is a losing game, and the protection that matters
 * — the file is never executed by us — is structural.
 */
export function safeDownloadFilename(suggested: string): string {
  const flattened = suggested.replace(UNSAFE_FILENAME_CHARS, "_").trim();
  // `.` and `..` survive the character filter and are the two names that would
  // still escape the directory once joined.
  if (!flattened || flattened === "." || flattened === "..") {
    return FALLBACK_DOWNLOAD_FILENAME;
  }

  let { stem, ext } = splitExtension(flattened);
  if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) stem = `${stem}_file`;

  // Truncate the stem rather than the whole name: an extension is what tells
  // the user (and their OS) what they just got.
  const room = MAX_DOWNLOAD_FILENAME_LENGTH - ext.length;
  if (room <= 0) return `${FALLBACK_DOWNLOAD_FILENAME}${ext}`.slice(0, MAX_DOWNLOAD_FILENAME_LENGTH);
  if (stem.length > room) stem = stem.slice(0, room);
  // Trailing dots and spaces are stripped by Windows on write, which turns
  // "the name we reported" into a name that does not exist on disk.
  stem = stem.replace(/[. ]+$/, "");
  if (!stem) stem = FALLBACK_DOWNLOAD_FILENAME;

  return `${stem}${ext}`;
}

/**
 * How many `name (n)` attempts before giving up on being tidy. Reached only by
 * something pathological, and the timestamp fallback is still collision-free.
 */
const MAX_DEDUPE_ATTEMPTS = 200;

export interface DownloadSavePathInput {
  /** Always the OS Downloads folder in practice; a parameter so it is testable. */
  directory: string;
  /** The page's suggestion. Untrusted. */
  suggested: string;
  exists: (candidate: string) => boolean;
  /** Injected only so the timestamp fallback is deterministic under test. */
  now?: () => number;
}

export interface DownloadSavePath {
  filePath: string;
  /** The name the user is told about — always the basename actually written. */
  filename: string;
}

export function resolveDownloadSavePath(
  input: DownloadSavePathInput,
): DownloadSavePath {
  const base = safeDownloadFilename(input.suggested);
  const first = path.join(input.directory, base);
  if (!input.exists(first)) return { filePath: first, filename: base };

  const { stem, ext } = splitExtension(base);
  for (let n = 1; n <= MAX_DEDUPE_ATTEMPTS; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    const candidatePath = path.join(input.directory, candidate);
    if (!input.exists(candidatePath)) {
      return { filePath: candidatePath, filename: candidate };
    }
  }

  const stamp = (input.now ?? Date.now)();
  const candidate = `${stem} (${stamp})${ext}`;
  return { filePath: path.join(input.directory, candidate), filename: candidate };
}
