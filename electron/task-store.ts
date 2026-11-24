/**
 * Tasks, saved (docs/architecture/task-board.md): a folder for each workdesk
 * in `~/.tacit/tasks`, a file for each task in that, its whole history beside
 * it in `<id>.events.jsonl`, never rewritten. Read and changed only here, in
 * the main process; every change goes through `change`.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TaskError, columnOf, type Actor, type Ctx, type Task } from "../shared/task.js";
import { makeTask, readTask, type NewTask } from "../shared/task-ops.js";
import { ID_REGEX, deriveExtension, writeFileAtomically } from "./record-file";

const WORKDESK = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_KEYS = 200;
const MAX_ATTACHMENT = 20 * 1024 * 1024;
export const newId = () => crypto.randomBytes(5).toString("hex");

export interface TaskChange {
  before: Task | null;
  task: Task;
  by: Actor;
}

export interface TaskStoreEvents {
  changed: [TaskChange];
  removed: [{ workdesk: string; id: string }];
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  private readonly loaded = new Map<string, Map<string, Task>>();
  /** Changes already made, by the key they were sent with. */
  private readonly keys = new Map<string, string[]>();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  private dir(workdesk: string): string {
    // A bare ".." would pass the pattern and leave the folder.
    if (!WORKDESK.test(workdesk) || workdesk.startsWith(".")) throw new TaskError("That isn't a workdesk");
    return path.join(this.root, `workdesk-${workdesk}`);
  }
  private file(workdesk: string, id: string): string {
    if (!ID_REGEX.test(id)) throw new TaskError("That isn't a task");
    return path.join(this.dir(workdesk), `${id}.json`);
  }
  private events(workdesk: string, id: string): string {
    return this.file(workdesk, id).replace(/\.json$/, ".events.jsonl");
  }

  private attachments(workdesk: string, id: string): string {
    return this.file(workdesk, id).replace(/\.json$/, ".attachments");
  }
  /** Where its pictures are served from, for the window. */
  attachmentsUrl(workdesk: string, id: string): string {
    return `tc-attachment://local${pathToFileURL(this.attachments(workdesk, id)).pathname}`;
  }
  saveAttachment(workdesk: string, id: string, fileName: string, data: Buffer): { relativePath: string; absolutePath: string } {
    if (!this.get(workdesk, id)) throw new TaskError("That task isn't there", 404);
    if (data.length > MAX_ATTACHMENT) throw new TaskError("That file is too big: 20 MB at most");
    const dir = this.attachments(workdesk, id);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomBytes(6).toString("hex")}.${deriveExtension(fileName, data)}`;
    const absolutePath = path.join(dir, name);
    fs.writeFileSync(absolutePath, data);
    return { relativePath: `./${id}.attachments/${name}`, absolutePath };
  }
  /** A brief's pictures by their whole paths, so an agent can open them. */
  withWholePaths(task: Pick<Task, "workdesk" | "id">, text: string): string {
    return text.replaceAll(`](./${task.id}.attachments/`, `](${this.attachments(task.workdesk, task.id)}/`);
  }

  private desk(workdesk: string): Map<string, Task> {
    const dir = this.dir(workdesk);
    const had = this.loaded.get(workdesk);
    if (had) return had;
    const tasks = new Map<string, Task>();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : null;
        if (!id || !ID_REGEX.test(id)) continue;
        try {
          const task = readTask(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
          // Its place on disk says whose it is; a file can't claim another workdesk or name.
          if (task && task.id === id) tasks.set(id, { ...task, workdesk });
          else console.error("[tasks] skipping a file that doesn't read as a task", path.join(dir, name));
        } catch (err) {
          console.error("[tasks] skipping a file that can't be read", path.join(dir, name), err);
        }
      }
    }
    this.loaded.set(workdesk, tasks);
    return tasks;
  }

  list(workdesk: string): Task[] {
    return [...this.desk(workdesk).values()];
  }
  get(workdesk: string, id: string): Task | null {
    return this.desk(workdesk).get(id) ?? null;
  }
  /** Every workdesk with tasks, for what happens whichever one is open. */
  workdesks(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).flatMap((name) => {
      const id = name.startsWith("workdesk-") ? name.slice("workdesk-".length) : "";
      return WORKDESK.test(id) && !id.startsWith(".") ? [id] : [];
    });
  }
  all(): Task[] {
    return this.workdesks().flatMap((w) => this.list(w));
  }
  /** A task by its id, or T-12, on one workdesk. */
  find(workdesk: string, ref: string): Task | null {
    const n = /^t-?(\d+)$/i.exec(ref.trim());
    return this.get(workdesk, ref) ?? (n ? (this.list(workdesk).find((t) => t.n === Number(n[1])) ?? null) : null);
  }

  ctx(by: Actor): Ctx {
    return { at: this.now().toISOString(), by, newId };
  }

  create(workdesk: string, input: NewTask, by: Actor): Task {
    const tasks = this.desk(workdesk);
    const n = this.nextNumber(workdesk, tasks);
    const task = makeTask(input, { id: this.newTaskId(tasks, workdesk, input.title), n, workdesk }, this.ctx(by));
    this.save(null, task, by);
    return task;
  }

  /**
   * Every change. `fn` gets the task as it is now, so nothing is made from an
   * old copy; returning the same object changes nothing. Sent again with the
   * same key, it's the same change, made once.
   */
  change(workdesk: string, id: string, by: Actor, fn: (task: Task, ctx: Ctx) => Task, key?: string): Task {
    const task = this.get(workdesk, id);
    if (!task) throw new TaskError("That task isn't there", 404);
    const at = `${workdesk}/${id}`;
    if (key) {
      const done = this.keys.get(at) ?? this.savedKeys(workdesk, id);
      this.keys.set(at, done);
      if (done.includes(key)) return task;
    }
    const next = fn(task, this.ctx(by));
    if (next === task) return task;
    const saved = { ...next, id: task.id, n: task.n, workdesk: task.workdesk, created: task.created, rev: task.rev + 1 };
    this.save(task, saved, by, key);
    if (key) {
      const done = this.keys.get(at)!;
      done.push(key);
      if (done.length > MAX_KEYS) done.splice(0, done.length - MAX_KEYS);
    }
    return saved;
  }

  remove(workdesk: string, id: string): void {
    if (!this.get(workdesk, id)) throw new TaskError("That task isn't there", 404);
    fs.rmSync(this.file(workdesk, id), { force: true });
    fs.rmSync(this.events(workdesk, id), { force: true });
    fs.rmSync(this.attachments(workdesk, id), { recursive: true, force: true });
    this.desk(workdesk).delete(id);
    this.keys.delete(`${workdesk}/${id}`);
    this.emit("removed", { workdesk, id });
  }

  private save(before: Task | null, task: Task, by: Actor, key?: string): void {
    const { workdesk, id } = task;
    // Written first: if the disk is full, nothing is said to have changed.
    writeFileAtomically(this.file(workdesk, id), JSON.stringify(task, null, 1));
    this.desk(workdesk).set(id, task);
    const said = task.history.filter((h) => !before?.history.includes(h));
    const column = { from: before ? columnOf(before) : null, to: columnOf(task) };
    try {
      fs.appendFileSync(this.events(workdesk, id), `${JSON.stringify({ at: task.updated, by, rev: task.rev, ...(said.length ? { did: said.map((h) => h.text) } : {}), ...(column.from !== column.to ? { column: column.to } : {}), ...(key ? { key } : {}) })}\n`);
    } catch (err) {
      console.error("[tasks] couldn't add to a task's history", id, err);
    }
    this.emit("changed", { before, task, by });
  }

  private savedKeys(workdesk: string, id: string): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.events(workdesk, id), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .flatMap((line) => {
        try {
          const key = (JSON.parse(line) as { key?: unknown }).key;
          return typeof key === "string" ? [key] : [];
        } catch {
          return [];
        }
      })
      .slice(-MAX_KEYS);
  }

  /** Counted on the workdesk and never given twice, so T-12 always means the same task. */
  private nextNumber(workdesk: string, tasks: Map<string, Task>): number {
    const file = path.join(this.dir(workdesk), "last-number");
    let last = 0;
    try {
      last = Number.parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
    } catch {
      // The first one.
    }
    const n = Math.max(last, 0, ...[...tasks.values()].map((t) => t.n)) + 1;
    writeFileAtomically(file, String(n));
    return n;
  }

  private newTaskId(tasks: Map<string, Task>, workdesk: string, title: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "") || "task";
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
      if (!tasks.has(id) && !fs.existsSync(this.file(workdesk, id))) return id;
    }
    throw new TaskError("Couldn't name that task", 500);
  }
}
