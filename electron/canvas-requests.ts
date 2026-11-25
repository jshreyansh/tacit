import fs from "fs";
import path from "path";
import type { CanvasRequest } from "../shared/canvas-ops";

/**
 * What agents have asked to change on the canvas, waiting on the person
 * (docs/architecture/workdesk-board.md, "Permissions"). Kept across restarts:
 * an agent was told its answer would come.
 */
const MAX = 100;

export class CanvasRequests {
  private list: CanvasRequest[] = [];
  private counter = 0;

  constructor(
    private readonly file: string,
    private readonly changed: (list: readonly CanvasRequest[]) => void,
    private readonly now: () => number = Date.now,
    /** A new one: more of one that's waiting isn't. */
    private readonly asked: (request: CanvasRequest) => void = () => {},
  ) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { list?: CanvasRequest[]; counter?: number };
      if (Array.isArray(saved.list)) this.list = saved.list.filter((r) => r && typeof r.id === "string" && typeof r.terminalId === "string" && (r.kind === "change" || r.kind === "delete"));
      if (typeof saved.counter === "number") this.counter = saved.counter;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[canvas-requests] couldn't read what was waiting:", err);
    }
  }

  all(): readonly CanvasRequest[] {
    return this.list;
  }
  get(id: string): CanvasRequest | undefined {
    return this.list.find((r) => r.id === id);
  }

  /** One request for one thing: another change to the same drawings by the same agent joins the one that's waiting. */
  ask(req: Omit<CanvasRequest, "id" | "at">): CanvasRequest {
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
    const made: CanvasRequest = { ...req, id: `cr-${++this.counter}`, at: this.now() };
    this.list = [...this.list, made].slice(-MAX);
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
      fs.writeFileSync(this.file, JSON.stringify({ list: this.list, counter: this.counter }), { mode: 0o600 });
    } catch (err) {
      console.error("[canvas-requests] couldn't save what's waiting:", err);
    }
    this.changed(this.list);
  }
}
