export interface FileInfo {
  name: string;
  additions: number;
  deletions: number;
  binary: boolean;
  isImage: boolean;
  imageOld: string | null;
  imageNew: string | null;
}

export interface FileDiff {
  file: FileInfo;
  hunks: string[];
}

export function parseDiff(raw: string, files: FileInfo[]): FileDiff[] {
  const fileMap = new Map(files.map((f) => [f.name, f]));
  const result: FileDiff[] = [];
  const sections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0] ?? "";
    const match = header.match(/b\/(.+)$/);
    const name = match?.[1] ?? "";
    const file = fileMap.get(name) ?? {
      name,
      additions: 0,
      deletions: 0,
      binary: false,
      isImage: false,
      imageOld: null,
      imageNew: null,
    };
    const content = lines.slice(1).join("\n");
    result.push({ file, hunks: [content] });
  }

  for (const f of files) {
    if (f.binary && !result.find((r) => r.file.name === f.name)) {
      result.push({ file: f, hunks: [] });
    }
  }

  return result;
}

/** The first changed line in the new version of a file, to open it there. */
export function firstChangedLine(hunks: string[]): number | undefined {
  for (const hunk of hunks) {
    let line: number | null = null;
    for (const text of hunk.split("\n")) {
      const header = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) line = Number(header[1]);
      else if (line === null || text.startsWith("\\")) continue;
      else if (text.startsWith("+") || text.startsWith("-")) return Math.max(line, 1);
      else line += 1;
    }
  }
  return undefined;
}

/** A file this diff deletes isn't there to open. */
export function isDeletedInDiff(hunks: string[]): boolean {
  return hunks.some((hunk) => /^deleted file mode /m.test(hunk));
}
