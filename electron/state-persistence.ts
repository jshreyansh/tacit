import fs from "fs";
import path from "path";
import { getTacitDataDir } from "../shared/tacit-instance";
import { workdeskFolders } from "./file-tiles";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
export const TACIT_DIR = getTacitDataDir(isDev ? "dev" : "prod");
/**
 * The saved workdesks. Nothing is saved until the window has opened what was
 * there: a window that couldn't (a bug, a file from a newer Tacit) shows an
 * empty workdesk, and saving that would lose every other one.
 */
export class StatePersistence {
  private folders: string[] | null = null;
  private ids: string[] | null = null;
  private held = true;
  private readonly file: string;

  constructor(private readonly dir: string = TACIT_DIR) {
    this.file = path.join(dir, "state.json");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** For the window to open: holds saving until it says it has. Throws when it can't be read. */
  open(): unknown | null {
    this.held = true;
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, "utf-8"));
  }

  /** The window has opened it. */
  opened(): void {
    this.held = false;
  }

  /** What's open replaces what's saved, which is kept beside it. */
  replace(): void {
    if (!this.held) return;
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, path.join(this.dir, `state.kept-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    this.held = false;
  }

  load(): unknown | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const data = fs.readFileSync(this.file, "utf-8");
      return JSON.parse(data);
    } catch (err) {
      console.error("[StatePersistence] failed to load state:", err);
      return null;
    }
  }

  save(state: unknown) {
    if (this.held) throw new Error("The saved workdesks haven't been opened, so nothing is saved over them.");
    const serialized =
      typeof state === "string" ? state : JSON.stringify(state, null, 2);
    // From folders to none at all: it may be meant, so it's saved, but what was there is kept.
    if (this.workdeskFolders().length > 0 && workdeskFolders(JSON.parse(serialized)).length === 0) {
      fs.copyFileSync(this.file, path.join(this.dir, "state.before-empty.json"));
    }
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, this.file);
    this.folders = null;
    this.ids = null;
  }

  /** Every workdesk's folders as last saved, read again after each save. */
  workdeskFolders(): string[] {
    if (!this.folders) this.folders = workdeskFolders(this.load());
    return this.folders;
  }

  /** Every workdesk's id as last saved, read again after each save. */
  workdeskIds(): string[] {
    if (!this.ids) {
      const canvases = (this.load() as { workspace?: { canvases?: unknown } } | null)?.workspace?.canvases;
      this.ids = Array.isArray(canvases) ? canvases.flatMap((c) => (c && typeof c.id === "string" ? [c.id] : [])) : [];
    }
    return this.ids;
  }
}
