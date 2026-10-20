import { FONT_REGISTRY, type FontEntry } from "./fontRegistry";

/**
 * Adds a downloaded font to the page. Its bytes come from main: the page
 * can't load a file:// URL, which is what failed for every downloaded font
 * (SHR-93).
 */
export async function loadFont(entry: FontEntry): Promise<boolean> {
  if (entry.source === "builtin") return true;
  try {
    const bytes = await window.tacit.fonts.read(entry.fileName);
    const face = new FontFace(entry.cssFamily.replace(/"/g, ""), bytes);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (err) {
    console.error(`[fonts] ${entry.name} didn't load:`, err);
    return false;
  }
}

export async function loadAllDownloadedFonts(): Promise<void> {
  if (!window.tacit?.fonts) {
    return;
  }

  const downloaded = new Set(await window.tacit.fonts.listDownloaded());
  for (const entry of FONT_REGISTRY) {
    if (entry.source === "builtin") continue;
    if (downloaded.has(entry.fileName)) {
      await loadFont(entry);
    }
  }
}
