import fs from "fs";
import path from "path";
import { getTacitDataDir } from "../shared/tacit-instance";
import { workdeskFolders } from "./file-tiles";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
export const TACIT_DIR = getTacitDataDir(isDev ? "dev" : "prod");
const STATE_FILE = path.join(TACIT_DIR, "state.json");

export class StatePersistence {
  private folders: string[] | null = null;
  private ids: string[] | null = null;

  constructor() {
    if (!fs.existsSync(TACIT_DIR)) {
      fs.mkdirSync(TACIT_DIR, { recursive: true });
    }
  }

  load(): unknown | null {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const data = fs.readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(data);
    } catch (err) {
      console.error("[StatePersistence] failed to load state:", err);
      return null;
    }
  }

  save(state: unknown) {
    const serialized =
      typeof state === "string" ? state : JSON.stringify(state, null, 2);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, STATE_FILE);
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
