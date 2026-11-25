import fs from "fs";
import path from "path";
import type { CanvasRequest } from "../shared/canvas-ops";

/**
 * What agents have asked to change on the canvas, waiting on the person
 * (docs/architecture/workdesk-board.md, "Permissions"). Kept across restarts:
 * an agent was told its answer would come.
 */
/** The most that can wait at once. One more is refused: an agent that was told "they've been asked" is never dropped. */
export const REQUESTS_MAX = 100;

export class CanvasRequests {
  private list: CanvasRequest[] = [];
  private counter = 0;
  private unread = false;

  constructor(
    private readonly file: string,
    private readonly changed: (list: readonly CanvasRequest[]) => void,
    private readonly now: () => number = Date.now,
    /** A new one: more of one that's waiting isn't. */
    private readonly asked: (request: CanvasRequest) => void = () => {},
  ) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unread = true;
        console.error("[canvas-requests] couldn't read what was waiting:", err);
      }
      return;
    }
    try {
      const saved = JSON.parse(raw) as { list?: CanvasRequest[]; counter?: number };
      if (!Array.isArray(saved.list)) throw new Error("it has no list");
      this.list = saved.list.filter((r) => r && typeof r.id === "string" && typeof r.terminalId === "string" && (r.kind === "change" || r.kind === "delete"));
      if (typeof saved.counter === "number") this.counter = saved.counter;
    } catch (err) {
      // Kept aside, said in the window, and its ids aren't given again: an agent may still name one.
      this.unread = true;
      this.counter = Math.max(0, ...[...raw.matchAll(/"cr-(\d{1,12})"|"counter":(\d{1,12})/g)].map((m) => Number(m[1] ?? m[2])));
      const aside = `${file}.unreadable-${this.now()}`;
      console.error(`[canvas-requests] couldn't read what was waiting; moving it to ${aside}:`, err);
      try {
        fs.renameSync(file, aside);
      } catch (moveErr) {
        console.error("[canvas-requests] couldn't move it aside:", moveErr);
      }
    }
  }

  all(): readonly CanvasRequest[] {
    return this.list;
  }
  get(id: string): CanvasRequest | undefined {
    return this.list.find((r) => r.id === id);
  }

  /** Whether what was waiting before couldn't be read. Said once. */
  takeUnread(): boolean {
    const was = this.unread;
    this.unread = false;
    return was;
  }

  /**
   * One request for one thing: another change to the same drawings by the same agent joins the one that's waiting.
   * Null when there's no room for another.
   */
  ask(req: Omit<CanvasRequest, "id" | "at">): CanvasRequest | null {
    const same = this.list.find((r) => r.terminalId === req.terminalId && r.workdesk === req.workdesk && r.kind === req.kind && [...r.targets].sort().join() === [...req.targets].sort().join());
    if (same) {
      if (req.kind === "change") {
        const byId = new Map((same.changes ?? []).map((c) => [c.id, c]));
        for (const c of req.changes ?? []) byId.set(c.id, { ...byId.get(c.id), ...c });
        same.changes = [...byId.values()];
      }
      same.titles = req.titles;
      same.at = this.now();
      this.save();
      return same;
    }
    if (this.list.length >= REQUESTS_MAX) return null;
    const made: CanvasRequest = { ...req, id: `cr-${++this.counter}`, at: this.now() };
    this.list = [...this.list, made];
    this.save();
    this.asked(made);
    return made;
  }

  remove(id: string): CanvasRequest | undefined {
    const found = this.get(id);
    if (!found) return undefined;
    this.list = this.list.filter((r) => r.id !== id);
    this.save();
    return found;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      // The counter first: a file that ends early still says which ids were given.
      fs.writeFileSync(temp, JSON.stringify({ counter: this.counter, list: this.list }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (err) {
      console.error("[canvas-requests] couldn't save what's waiting:", err);
    }
    this.changed(this.list);
  }
}
