/** Files for records saved by the main process (electron/task-store.ts). */
import fs from "node:fs";
import path from "node:path";

export const ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function writeFileAtomically(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function deriveExtension(fileName: string, data: Buffer): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx < fileName.length - 1) {
    const ext = fileName.slice(dotIdx + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return detectImageExtension(data);
}

function detectImageExtension(data: Buffer): string {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "png";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "jpg";
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  )
    return "gif";
  if (
    data.length >= 12 &&
    data.slice(0, 4).toString("ascii") === "RIFF" &&
    data.slice(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  return "png";
}
