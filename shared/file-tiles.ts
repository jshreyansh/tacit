/**
 * File tiles: a file from one of the workdesk's folders shown on the canvas
 * or in the grid. Shared by main, which checks and serves the file, and the
 * renderer, which shows it.
 */

export type FileTileKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export type FileTileInfo =
  | {
      ok: true;
      kind: FileTileKind;
      size: number;
      /** ms since the epoch. */
      modified: number;
      /** Media streams from here; text is read and saved as before. */
      url?: string;
    }
  | { ok: false; error: "missing" | "not-a-file" | "outside-folders" | "invalid" };

const BY_EXT: Record<string, FileTileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  apng: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  ogv: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  aac: "audio",
  opus: "audio",
  pdf: "pdf",
};

export function fileExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What a file is by its name alone; null when only its bytes can tell. */
export function fileTileKindByName(filePath: string): FileTileKind | null {
  return BY_EXT[fileExtension(filePath)] ?? null;
}

/** Media is streamed to the tile; text is read and saved as before. */
export function isStreamedKind(kind: FileTileKind): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";
}

/** "2.4 MB", "830 KB", "12 bytes". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
