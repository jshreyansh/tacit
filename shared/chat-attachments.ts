import type { ChatAttachment } from "./chat-events";

/**
 * Files sent with a chat message. Both agents read a file from its path:
 * Claude takes `@path` in the message as an attachment (an image as an
 * image, any other file inlined), and Codex reads the path it's given; an
 * image goes to Codex as a picture of its own. The mentions go after the
 * text, one per line, so a conversation reopened from history shows them as
 * attachments again. Pure.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function attachmentKind(name: string): ChatAttachment["kind"] {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
}

export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

/** `@path`, quoted when the path has spaces (Claude's own way to write it). */
export function mentionOf(filePath: string): string {
  return /[\s"]/.test(filePath) ? `@"${filePath.replace(/"/g, '\\"')}"` : `@${filePath}`;
}

/** The message as the agent gets it: the text, then a line per file. */
export function withMentions(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const mentions = paths.map(mentionOf).join("\n");
  return text.trim() ? `${text}\n\n${mentions}` : mentions;
}

const MENTION_LINE = /^@(?:"((?:[^"\\]|\\.)+)"|(\S+))$/;
const ABSOLUTE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;

/**
 * A message from history split back into its text and the files mentioned
 * on its last lines. Only whole lines of absolute paths count, so an `@name`
 * in the text stays text.
 */
export function splitMentions(message: string): { text: string; attachments: ChatAttachment[] } {
  const lines = message.replace(/\s+$/, "").split("\n");
  const found: ChatAttachment[] = [];
  while (lines.length > 0) {
    const m = MENTION_LINE.exec(lines[lines.length - 1].trim());
    const filePath = m ? (m[1]?.replace(/\\"/g, '"') ?? m[2]) : null;
    if (!filePath || !ABSOLUTE.test(filePath)) break;
    found.unshift({ name: baseName(filePath), path: filePath, kind: attachmentKind(filePath) });
    lines.pop();
  }
  if (found.length === 0) return { text: message, attachments: [] };
  // The mentions follow a blank line, or are the whole message.
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") return { text: message, attachments: [] };
  return { text: lines.join("\n").trim(), attachments: found };
}
