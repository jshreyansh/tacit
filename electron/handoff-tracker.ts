import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { CaptureEvent, CaptureNodeRef, HandoffFile } from "../shared/capture";

/**
 * Where text pasted into an agent terminal came from (SHR-62).
 *
 * The clipboard has no "copied from" field and no change event, so this
 * keeps checkpoints: each time focus moves (between nodes, or Tacit losing
 * or regaining the window), main reads the clipboard and notes its
 * fingerprint. A change since the last checkpoint happened wherever focus
 * was in between. A copy command Tacit sees itself (⌘C in a node, a terminal
 * copying its selection) is `observed`; a change found only by a checkpoint
 * is `inferred`, because a clipboard manager, a password manager clearing
 * it, or iPhone Universal Clipboard can change it under any node.
 *
 * Nothing copied or pasted is stored. Fingerprints are HMAC-SHA256 under a
 * key made once per install and kept on this Mac, so a fingerprint in an
 * exported record can't be reversed, even for a 6-digit code, or matched
 * against anything elsewhere. A pasted text is held in memory, until its
 * terminal's next prompt, only to say whether that prompt contains it.
 */

/** Where focus is: a canvas node, Tacit's own panels, or another app. */
export type HandoffFocus = CaptureNodeRef | "app" | "external";

type CopySource = { from: HandoffFocus; attribution: "observed" | "inferred"; at: string };

interface PendingPaste {
  eventId: string;
  text: string;
  at: number;
}

/** How late a copy's report may arrive after a checkpoint already saw it. */
const COPY_REPORT_GRACE_MS = 1_000;
/** Copies remembered; older ones are forgotten first. */
const MAX_COPIES = 100;
/** Pastes waiting for their terminal's next prompt. */
const MAX_PENDING_PER_TERMINAL = 5;
const PENDING_TTL_MS = 30 * 60_000;
/** A shorter paste ("y", "ok") would be found in almost any prompt. */
const MIN_LINKED_PASTE_LENGTH = 8;
/** Files larger than this are named, not read. */
export const MAX_FINGERPRINT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_DROPPED_FILES = 20;

const KEY_FILE = "handoff-key";

/**
 * The install's fingerprint key: 32 random bytes in `<dir>/handoff-key`,
 * readable only by this user, made the first time it's needed.
 */
export function loadHandoffKey(dir: string): Buffer {
  const keyPath = path.join(dir, KEY_FILE);
  const read = (): Buffer | null => {
    try {
      const hex = fs.readFileSync(keyPath, "utf-8").trim();
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  fs.mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  try {
    fs.writeFileSync(keyPath, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    // Another launch made it first, or a damaged file is in the way.
    const raced = read();
    if (raced) return raced;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fs.writeFileSync(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    return key;
  }
}

export function keyedFingerprint(key: Buffer, data: string | Buffer): string {
  return `hmac:${createHmac("sha256", key).update(data).digest("hex").slice(0, 32)}`;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

export class HandoffTracker {
  private readonly copies = new Map<string, CopySource>();
  private readonly pending = new Map<CaptureNodeRef, PendingPaste[]>();
  /** The clipboard's fingerprint at the last checkpoint; undefined before the first. */
  private lastSeen: string | null | undefined = undefined;
  private windowFocused = false;
  private nodeFocus: CaptureNodeRef | "app" = "app";

  constructor(
    private readonly key: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  fingerprint(text: string): string {
    return keyedFingerprint(this.key, text);
  }

  /** The Tacit window gained or lost focus. */
  windowFocusChanged(focused: boolean, clipboard: string | null): void {
    this.checkpoint(clipboard);
    this.windowFocused = focused;
  }

  /** Focus moved to a node, or to Tacit's own panels (null). */
  nodeFocusChanged(node: CaptureNodeRef | null, clipboard: string | null): void {
    this.checkpoint(clipboard);
    this.nodeFocus = node ?? "app";
  }

  /**
   * Tacit saw a copy command in `node`. When the clipboard didn't change
   * (⌘C with nothing selected), nothing was copied.
   */
  copied(node: CaptureNodeRef, clipboard: string | null): void {
    if (!clipboard) return;
    const fingerprint = this.fingerprint(clipboard);
    const known = this.copies.get(fingerprint);
    // A checkpoint can run between the copy and this report (focus moved
    // within moments of ⌘C); it found the change in this same node, so the
    // copy stands. Only just now: later, a ⌘C with nothing selected must not
    // turn a change made by something else into an observed copy.
    const caughtFirst =
      known?.from === node &&
      known.attribution === "inferred" &&
      this.now().getTime() - Date.parse(known.at) <= COPY_REPORT_GRACE_MS;
    if (fingerprint === this.lastSeen && !caughtFirst) return;
    this.remember(fingerprint, { from: node, attribution: "observed", at: known && caughtFirst ? known.at : this.now().toISOString() });
    this.lastSeen = fingerprint;
  }

  /**
   * Text was pasted into agent terminal `to`. Returns the handoff to record,
   * with the id its entry must carry so the next prompt can point to it.
   */
  pasted(to: CaptureNodeRef, clipboard: string | null): { event: CaptureEvent; eventId: string } | null {
    if (!clipboard) return null;
    // A change since the last checkpoint happened where focus is now.
    this.checkpoint(clipboard);
    const fingerprint = this.fingerprint(clipboard);
    const source = this.copies.get(fingerprint);
    const eventId = randomUUID();
    this.awaitPrompt(to, eventId, clipboard);
    return {
      eventId,
      event: {
        kind: "handoff",
        from: source?.from ?? "external",
        to,
        via: "paste",
        attribution: source?.attribution ?? "unmatched",
        by: "user",
        fingerprint,
        length: clipboard.length,
        ...(source ? { copied_at: source.at } : {}),
      },
    };
  }

  /**
   * Text a handoff put in `to`'s input, so its next prompt can say it
   * contains it. Held in memory only.
   */
  awaitPrompt(to: CaptureNodeRef, eventId: string, text: string): void {
    const nowMs = this.now().getTime();
    const list = (this.pending.get(to) ?? []).filter((paste) => nowMs - paste.at <= PENDING_TTL_MS);
    list.push({ eventId, text: normalizeForMatch(text), at: nowMs });
    this.pending.set(to, list.slice(-MAX_PENDING_PER_TERMINAL));
  }

  /**
   * A prompt was submitted in `to`: the ids of this terminal's pastes it
   * contains. Its pending pastes are done with either way; one that isn't in
   * the prompt was deleted before sending.
   */
  promptRefs(to: CaptureNodeRef, prompt: string | null): string[] {
    const list = this.pending.get(to);
    if (!list) return [];
    this.pending.delete(to);
    if (!prompt) return [];
    const text = normalizeForMatch(prompt);
    const nowMs = this.now().getTime();
    return list
      .filter((paste) => nowMs - paste.at <= PENDING_TTL_MS)
      .filter((paste) => paste.text && (paste.text === text || (paste.text.length >= MIN_LINKED_PASTE_LENGTH && text.includes(paste.text))))
      .map((paste) => paste.eventId);
  }

  forget(to: CaptureNodeRef): void {
    this.pending.delete(to);
  }

  private checkpoint(clipboard: string | null): void {
    if (!clipboard) return;
    const fingerprint = this.fingerprint(clipboard);
    if (this.lastSeen === undefined) {
      // The first look: whatever is there came from before Tacit was watching.
      this.lastSeen = fingerprint;
      return;
    }
    if (fingerprint === this.lastSeen) return;
    this.lastSeen = fingerprint;
    this.remember(fingerprint, {
      from: this.windowFocused ? this.nodeFocus : "external",
      attribution: "inferred",
      at: this.now().toISOString(),
    });
  }

  private remember(fingerprint: string, source: CopySource): void {
    this.copies.delete(fingerprint);
    this.copies.set(fingerprint, source);
    while (this.copies.size > MAX_COPIES) {
      const oldest = this.copies.keys().next().value;
      if (oldest === undefined) break;
      this.copies.delete(oldest);
    }
  }
}

/** Harnesses that take prompts; a paste into a shell, lazygit or tmux isn't recorded. */
const AGENT_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "gemini", "kimi", "antigravity", "wuu"]);

export function isAgentHarness(harness: string | null): boolean {
  return harness !== null && AGENT_HARNESSES.has(harness);
}

/** A pin dropped on an agent terminal: the pin's text is typed in. */
export function pinDropEvent(pinId: string, to: CaptureNodeRef): CaptureEvent {
  return { kind: "handoff", from: `note:${pinId}`, to, via: "drop", attribution: "observed", by: "user" };
}

/** Files dropped on an agent terminal, from Tacit's Files panel or another app. */
export function fileDropEvent(files: HandoffFile[], to: CaptureNodeRef, fromFilesPanel: boolean): CaptureEvent {
  return { kind: "handoff", from: fromFilesPanel ? "app" : "external", to, via: "drop", attribution: "observed", by: "user", files };
}

/**
 * How a dropped file is named in the record: relative to the terminal's
 * project, or under `~`, so the account name stays out; with its size and a
 * keyed fingerprint of its contents, so it's known again if moved or renamed.
 */
export async function describeDroppedFile(
  filePath: string,
  options: { key: Buffer; projectRoot: string | null; home: string; maxBytes?: number },
): Promise<HandoffFile> {
  const resolved = path.resolve(filePath);
  const shown = displayPath(resolved, options.projectRoot, options.home);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return { path: shown, size: null, fingerprint: null };
  }
  if (!stat.isFile()) return { path: shown, size: null, fingerprint: null };
  if (stat.size > (options.maxBytes ?? MAX_FINGERPRINT_FILE_BYTES)) {
    return { path: shown, size: stat.size, fingerprint: null };
  }
  try {
    const hmac = createHmac("sha256", options.key);
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(resolved)
        .on("data", (chunk) => hmac.update(chunk))
        .on("end", () => resolve())
        .on("error", reject);
    });
    return { path: shown, size: stat.size, fingerprint: `hmac:${hmac.digest("hex").slice(0, 32)}` };
  } catch {
    return { path: shown, size: stat.size, fingerprint: null };
  }
}

function displayPath(resolved: string, projectRoot: string | null, home: string): string {
  const inside = (root: string) => {
    const rel = path.relative(root, resolved);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
  };
  if (projectRoot) {
    const rel = inside(path.resolve(projectRoot));
    if (rel) return rel;
  }
  const underHome = inside(path.resolve(home));
  return underHome ? `~/${underHome}` : resolved;
}
