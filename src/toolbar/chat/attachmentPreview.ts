/**
 * How the chat opens an attached file: in its own viewer for what a page can
 * show (pictures, video, audio, Markdown, text), in Quick Look for the rest.
 * Pure.
 */

export type PreviewKind = "image" | "video" | "audio" | "markdown" | "text" | "quicklook";

const BY_EXTENSION: Record<string, PreviewKind> = {};
const add = (kind: PreviewKind, exts: string) => exts.split(" ").forEach((e) => (BY_EXTENSION[e] = kind));
add("image", "png jpg jpeg gif webp svg bmp avif");
add("video", "mp4 m4v mov webm ogv");
add("audio", "mp3 m4a wav aac ogg oga flac opus");
add("markdown", "md markdown mdx");
add(
  "text",
  "txt log csv tsv json jsonl yaml yml toml ini env xml html css scss js jsx ts tsx mjs cjs py rb go rs java kt swift c h cpp hpp cs php sh zsh bash sql graphql lua r dart vue svelte",
);

export function previewKind(name: string): PreviewKind {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "quicklook";
}

/** An attachment the app no longer holds (shown, but not openable) has an id with this. */
export const UNHELD_PREFIX = "unheld:";
