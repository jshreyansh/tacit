import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatAttachment, ChatAttachmentInfo } from "../../shared/chat-events";
import { attachmentKind, baseName } from "../../shared/chat-attachments";

/**
 * The files a chat message can carry. Only files the person chose reach an
 * agent: picked in the open dialog, dropped on the message box, or pasted
 * (a pasted image is saved first, since both agents read files by path).
 * Each gets an id; a message names its files by id, never by path.
 */

export type AttachmentInfo = ChatAttachmentInfo;

/** A pasted image: up to 20 MB, and only the formats both agents read. */
const MAX_PASTED_BYTES = 20 * 1024 * 1024;
/** Pasted images are kept a week, long enough for the agent to read them again. */
const PASTED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HELD = 500;

/** The image format a pasted file is, from its first bytes. */
export function imageExtension(bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export class ChatAttachments {
  private readonly held = new Map<string, AttachmentInfo>();

  constructor(
    private readonly deps: {
      /** Where pasted images are saved. */
      dir: string;
      /** A picture of an image file, as a data URL; undefined when it can't be read. */
      preview: (filePath: string) => string | undefined;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {}

  /** A file the person picked or dropped: an existing file, by absolute path. */
  addPath(filePath: unknown): AttachmentInfo {
    if (typeof filePath !== "string" || filePath.length > 4096 || !path.isAbsolute(filePath)) throw new Error("not a file path");
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`${baseName(filePath)} isn't a file`);
    return this.hold(filePath, baseName(filePath), stat.size);
  }

  /** A pasted image, saved so the agent can read it. */
  addImage(name: unknown, bytes: unknown): AttachmentInfo {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("no image");
    if (bytes.byteLength > MAX_PASTED_BYTES) throw new Error("the image is over 20 MB");
    const ext = imageExtension(bytes);
    if (!ext) throw new Error("only PNG, JPEG, GIF and WebP images can be pasted");
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const filePath = path.join(this.deps.dir, `${randomUUID()}.${ext}`);
    fs.writeFileSync(filePath, bytes);
    const shown = typeof name === "string" && name.trim() && name.length <= 255 ? name.trim() : `pasted-image.${ext}`;
    return this.hold(filePath, attachmentKind(shown) === "image" ? shown : `${shown}.${ext}`, bytes.byteLength);
  }

  /** The files a message names. Throws when one isn't known, so nothing goes half-sent. */
  resolve(ids: unknown): ChatAttachment[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids) || ids.length > 20) throw new Error("invalid attachments");
    return ids.map((id) => {
      const held = typeof id === "string" ? this.held.get(id) : undefined;
      if (!held) throw new Error("an attached file is no longer available; attach it again");
      return { name: held.name, path: held.path, kind: held.kind, ...(held.preview ? { preview: held.preview } : {}) };
    });
  }

  /** Removes pasted images older than a week. */
  prune(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch {
      return; // Nothing pasted yet.
    }
    const cutoff = (this.deps.now?.() ?? Date.now()) - PASTED_KEEP_MS;
    for (const name of names) {
      const file = path.join(this.deps.dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (error) {
        this.deps.log?.(`chat attachments: couldn't remove ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private hold(filePath: string, name: string, size: number): AttachmentInfo {
    const kind = attachmentKind(name);
    const preview = kind === "image" ? this.deps.preview(filePath) : undefined;
    const info: AttachmentInfo = { id: randomUUID(), name, path: filePath, kind, size, ...(preview ? { preview } : {}) };
    this.held.set(info.id, info);
    if (this.held.size > MAX_HELD) this.held.delete(this.held.keys().next().value!);
    return info;
  }
}
