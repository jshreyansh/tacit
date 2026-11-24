/**
 * The window's way to tasks. Only the app's own window, every argument
 * checked; a workdesk is named by its id and the store keeps to its own
 * folder. Changes from here are the person's.
 */
import type { IpcMainInvokeEvent } from "electron";
import { TaskError, type Task } from "../shared/task.js";
import { applyTaskOp, parseNewTask, parseTaskOp, type TaskResult } from "../shared/task-ops.js";
import type { TaskStore } from "./task-store";
import type { HandOver, TaskRunner } from "./task-runner";

interface Deps {
  handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
  allowed: (event: IpcMainInvokeEvent) => boolean;
  store: TaskStore;
  runner: TaskRunner;
}

const str = (v: unknown, max = 200): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new TaskError("That isn't right");
  return v;
};
const optional = (v: unknown, max: number): string | undefined => (v === undefined || v === null ? undefined : typeof v === "string" && v.length <= max ? v : str(null));

export function registerTaskIpc({ handle, allowed, store, runner }: Deps): void {
  const on = (channel: string, fn: (...args: unknown[]) => unknown): void =>
    handle(channel, async (event, ...args): Promise<TaskResult<unknown>> => {
      if (!allowed(event)) return { ok: false, error: "Not allowed" };
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        if (!(err instanceof TaskError)) console.error(`[tasks] ${channel} failed`, err);
        const code = (err as { code?: unknown }).code;
        return { ok: false, error: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code } : {}) };
      }
    });

  on("tasks:list", (): Task[] => store.all());
  on("tasks:create", (workdesk, input) => store.create(str(workdesk), parseNewTask(input), "user"));
  on("tasks:change", (workdesk, id, raw, key) => {
    const op = parseTaskOp(raw);
    if (op.op === "accept" || op.op === "drop") return runner.close(str(workdesk), str(id), op.op === "accept" ? "done" : "dropped", "user");
    return store.change(str(workdesk), str(id), "user", (t, ctx) => applyTaskOp(t, ctx, op), optional(key, 100));
  });
  on("tasks:remove", (workdesk, id) => {
    const task = store.get(str(workdesk), str(id));
    // Only what's already been let go of: nothing under way goes at one press.
    if (task && !task.closed) throw new TaskError("Drop it first", 409);
    store.remove(str(workdesk), str(id));
  });
  on("tasks:hand-over", (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const how = r.how === "queue" || r.how === "interrupt" || r.how === "launch" ? r.how : undefined;
    const req: HandOver = {
      workdesk: str(r.workdesk), id: str(r.id), terminal: str(r.terminal), by: "user",
      part: optional(r.part, 100) ?? null,
      ...(how ? { how } : {}),
      ...(how === "launch" && r.as && typeof r.as === "object" ? { as: { name: str((r.as as Record<string, unknown>).name), worktree: str((r.as as Record<string, unknown>).worktree, 4096) } } : {}),
      ...(r.allowed === undefined ? {} : { allowed: optional(r.allowed, 2000) ?? "" }),
      ...(r.note === undefined ? {} : { note: optional(r.note, 2000) ?? "" }),
    };
    return runner.handOver(req);
  });
  on("tasks:send-now", (workdesk, id, tryId) => runner.sendNow(str(workdesk), str(id), str(tryId)));
  on("tasks:stop", (workdesk, id, tryId) => runner.stopFor(str(workdesk), str(id), str(tryId), "user"));
  on("tasks:answer", (workdesk, id, request, text) => runner.answer(str(workdesk), str(id), str(request), str(text, 1000), "user"));
  on("tasks:say", (workdesk, id, text, tryId) => runner.say(str(workdesk), str(id), str(text, 8000), "user", "You", optional(tryId, 100)));
  // A reply that came to a task along a wire: the agent's words, kept with it.
  on("tasks:log", (workdesk, id, text, terminal, name) => runner.say(str(workdesk), str(id), str(text, 8000), `terminal:${str(terminal, 128)}`, str(name)));
  on("tasks:attach", (workdesk, id, name, data) => {
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) throw new TaskError("That isn't a file");
    return store.saveAttachment(str(workdesk), str(id), str(name, 300), Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)));
  });
  on("tasks:attachments", (workdesk, id) => store.attachmentsUrl(str(workdesk), str(id)));
  on("tasks:landed", (workdesk) => runner.refreshLanded(str(workdesk)));
}
