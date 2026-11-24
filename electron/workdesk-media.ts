/**
 * Files pasted or dropped onto the canvas (or chosen with the File tool) from
 * outside the workdesk (docs/architecture/workdesk-board.md). They're saved
 * as real files in the workdesk's folder, under `.tacit/media/`, and shown
 * as ordinary file tiles, so there's one preview everywhere (canvas, grid,
 * panels) and agents can open them like any other file.
 *
 * The renderer hands over the bytes, never a path to read. The type comes
 * from the content, not the name; the folder must be one of the workdesk's
 * own, as saved; `.tacit/media/` keeps itself out of git.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "other";

/** Pictures were agreed at 20 MB; a video, a recording or any other file gets more room. */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  pdf: 200 * 1024 * 1024,
  other: 200 * 1024 * 1024,
};

/** Names that promise something the canvas would show as media. */
const MEDIA_EXTENSIONS = /^(png|jpe?g|gif|webp|avif|apng|bmp|ico|svg|mp4|m4v|mov|webm|ogv|mp3|m4a|wav|ogg|oga|flac|aac|opus|pdf)$/i;

export const MEDIA_DIR = path.join(".tacit", "media");

/** What a file is from its first bytes, and the extension it's saved with; null if we don't show it. */
export function sniffMedia(bytes: Uint8Array): { kind: MediaKind; ext: string } | null {
  const at = (i: number, ...vals: number[]) => vals.every((v, k) => bytes[i + k] === v);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", ext: "png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: "image", ext: "jpg" };
  if (ascii(0, "GIF8")) return { kind: "image", ext: "gif" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { kind: "image", ext: "webp" };
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { kind: "audio", ext: "wav" };
  if (ascii(0, "%PDF-")) return { kind: "pdf", ext: "pdf" };
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { kind: "video", ext: "webm" };
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "qt  ") return { kind: "video", ext: "mov" };
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", ext: "m4a" };
    if (brand === "avif" || brand === "avis") return { kind: "image", ext: "avif" };
    return { kind: "video", ext: "mp4" };
  }
  if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes.byteLength > 2)) return { kind: "audio", ext: "mp3" };
  if (ascii(0, "OggS")) return { kind: "audio", ext: "ogg" };
  if (ascii(0, "fLaC")) return { kind: "audio", ext: "flac" };
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { kind: "image", ext: "svg" };
  return null;
}

export type SaveMediaResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not_a_folder" | "empty" | "unsupported" | "too_large" };

/** A file name from what the renderer called it: no folders, no odd characters, the right extension. */
export function mediaFileName(name: unknown, ext: string, now: Date): string {
  const raw = typeof name === "string" ? path.basename(name) : "";
  const stem = raw
    .replace(/\.[^.]*$/, "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-")
    .replace(/^[.\s-]+|[\s-]+$/g, "")
    .slice(0, 80);
  // A pasted screenshot arrives as "image.png": name it by when it came instead.
  if (!stem || /^image$/i.test(stem)) {
    if (!ext) return "Pasted file";
    const p = (n: number) => String(n).padStart(2, "0");
    return `Pasted ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} at ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
  }
  return ext ? `${stem}.${ext}` : stem;
}

function sameBytes(file: string, sha: string): boolean {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sha;
  } catch {
    return false;
  }
}

/**
 * Save the bytes in `<folder>/.tacit/media/`. `folders` are the workdesk
 * folders as saved; `folder` must be one of them. The same bytes under the
 * same name are one file; a different file with that name gets " 2", " 3".
 */
export function saveWorkdeskMedia(
  folders: readonly string[],
  folder: unknown,
  bytes: unknown,
  name: unknown,
  now = new Date(),
): SaveMediaResult {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return { ok: false, reason: "not_a_folder" };
  const root = path.resolve(folder);
  if (!folders.some((f) => path.resolve(f) === root)) return { ok: false, reason: "not_a_folder" };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, reason: "empty" };
  // Media by its content. Any other file keeps its own extension, unless that
  // names media its content isn't (a script called photo.svg is refused).
  const ownExt = typeof name === "string" ? (/\.([A-Za-z0-9]{1,10})$/.exec(path.basename(name))?.[1] ?? "") : "";
  const type = sniffMedia(bytes) ?? (MEDIA_EXTENSIONS.test(ownExt) ? null : { kind: "other" as const, ext: ownExt.toLowerCase() });
  if (!type) return { ok: false, reason: "unsupported" };
  if (bytes.byteLength > MEDIA_MAX_BYTES[type.kind]) return { ok: false, reason: "too_large" };

  const dir = path.join(root, MEDIA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // Kept out of git without touching the project's own .gitignore.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# Files pasted or dropped onto Tacit's canvas.\n*\n");

  const sha = createHash("sha256").update(bytes).digest("hex");
  const file = mediaFileName(name, type.ext, now);
  const dot = file.lastIndexOf(".") > 0 ? file.lastIndexOf(".") : file.length;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? file : `${file.slice(0, dot)} ${n}${file.slice(dot)}`);
    if (fs.existsSync(candidate)) {
      if (sameBytes(candidate, sha)) return { ok: true, path: candidate };
      continue;
    }
    const tmp = `${candidate}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, candidate);
    return { ok: true, path: candidate };
  }
  return { ok: false, reason: "not_a_folder" };
}
