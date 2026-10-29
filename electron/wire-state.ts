import fs from "node:fs";
import path from "node:path";
import type { MailItem } from "./wire-mailbox";
import type { PendingAsk } from "./wire-asks";
import type { TrackedHandoff } from "./tracked-handoff";

/**
 * What the wires are in the middle of, kept on disk so a restart doesn't
 * lose it: messages waiting for busy agents, questions waiting for answers,
 * and tracked hand-offs waiting for results.
 *
 * One small JSON file in the Tacit data folder, written whole (to a temporary
 * file, then renamed over the old one) whenever any of it changes, and
 * readable only by the user: the messages are the user's agents' words.
 * A file that can't be read or doesn't match is set aside, the user is told,
 * and the app starts with nothing pending; it never stops the app starting.
 */

export const WIRE_STATE_VERSION = 1;

export interface WireState {
  version: typeof WIRE_STATE_VERSION;
  mail: MailItem[];
  asks: { queued: PendingAsk[]; active: PendingAsk[] };
  handoffs: TrackedHandoff[];
}

export const EMPTY_WIRE_STATE: WireState = {
  version: WIRE_STATE_VERSION,
  mail: [],
  asks: { queued: [], active: [] },
  handoffs: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isMailItem(value: unknown): value is MailItem {
  if (!isObject(value)) return false;
  const target = value.target;
  return (
    isString(value.id) && isString(value.terminalId) && isString(value.text) && isString(value.from) &&
    typeof value.preview === "string" && typeof value.at === "number" &&
    (target === undefined ||
      (isObject(target) && typeof target.ptyId === "number" && isString(target.terminalType) && isString(target.worktreePath))) &&
    (value.askId === undefined || isString(value.askId))
  );
}

function isPendingAsk(value: unknown): value is PendingAsk {
  return (
    isObject(value) &&
    isString(value.id) && isString(value.askerId) && typeof value.askerTitle === "string" &&
    isString(value.targetId) && typeof value.targetTitle === "string" && typeof value.question === "string" &&
    isString(value.cwd) && typeof value.at === "number" &&
    (value.before === undefined || typeof value.before === "string")
  );
}

function isTrackedHandoff(value: unknown): value is TrackedHandoff {
  return (
    isObject(value) &&
    isString(value.id) && isString(value.senderId) && typeof value.senderTitle === "string" &&
    isString(value.targetId) && typeof value.targetTitle === "string" && isString(value.dir) &&
    path.isAbsolute(value.dir) && typeof value.startedAt === "number"
  );
}

/** A saved file's contents, or why they can't be used. */
export function parseWireState(raw: string): { ok: true; state: WireState } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (!isObject(data) || data.version !== WIRE_STATE_VERSION) return { ok: false, reason: "unknown version" };
  const asks = isObject(data.asks) ? data.asks : {};
  const lists = {
    mail: data.mail,
    queued: asks.queued,
    active: asks.active,
    handoffs: data.handoffs,
  };
  for (const [name, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) return { ok: false, reason: `${name} is missing` };
  }
  const bad = (name: string) => ({ ok: false as const, reason: `a malformed entry in ${name}` });
  if (!(lists.mail as unknown[]).every(isMailItem)) return bad("mail");
  if (!(lists.queued as unknown[]).every(isPendingAsk)) return bad("asks.queued");
  if (!(lists.active as unknown[]).every(isPendingAsk)) return bad("asks.active");
  if (!(lists.handoffs as unknown[]).every(isTrackedHandoff)) return bad("handoffs");
  return {
    ok: true,
    state: {
      version: WIRE_STATE_VERSION,
      mail: lists.mail as MailItem[],
      asks: { queued: lists.queued as PendingAsk[], active: lists.active as PendingAsk[] },
      handoffs: lists.handoffs as TrackedHandoff[],
    },
  };
}

export function isEmptyWireState(state: WireState): boolean {
  return state.mail.length === 0 && state.asks.queued.length === 0 && state.asks.active.length === 0 && state.handoffs.length === 0;
}

export class WireStateFile {
  constructor(private readonly file: string) {}

  /**
   * What was saved, or nothing. A file that can't be used is moved aside, and
   * `problem` says so in words for the user: what it held is lost to the app.
   */
  load(): { state: WireState; problem?: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: EMPTY_WIRE_STATE };
      console.warn(`[wire-state] couldn't read ${this.file}`, err);
      return { state: EMPTY_WIRE_STATE, problem: `Tacit couldn't read what its wires were waiting on before it closed (${(err as Error).message}), so nothing was kept.` };
    }
    const parsed = parseWireState(raw);
    if (parsed.ok) return { state: parsed.state };
    const aside = `${this.file}.unreadable-${Date.now()}`;
    console.warn(`[wire-state] ${this.file} can't be used (${parsed.reason}); moving it to ${aside}`);
    try {
      fs.renameSync(this.file, aside);
    } catch (err) {
      console.warn(`[wire-state] couldn't move ${this.file} aside`, err);
    }
    return {
      state: EMPTY_WIRE_STATE,
      problem: `Tacit couldn't use what its wires were waiting on before it closed (${parsed.reason}), so nothing was kept. The file is at ${aside}.`,
    };
  }

  /** Writes the whole state; an empty state removes the file. */
  save(state: WireState): void {
    if (isEmptyWireState(state)) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
