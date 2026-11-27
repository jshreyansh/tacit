/**
 * What a tile's page did that isn't on the page: files it downloaded and
 * windows it opened. Main records them as they happen (electron/main.ts); an
 * agent's browser_act reports the ones its steps caused, and can wait for a
 * download to finish. Kept by the page's webContents id, a few per page, for
 * a few minutes: a convenience for the agent, not a history.
 */

export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface DownloadEvent {
  kind: "download";
  id: number;
  at: number;
  /** The name it was saved as (sanitised; see browser-downloads.ts). */
  file: string;
  /** Where it was saved: always in the person's Downloads folder. */
  path: string;
  url: string;
  state: DownloadState;
  bytes: number;
  total: number;
  /** Told to an agent once finished; until then it's in every result. */
  reported?: boolean;
}

export interface OpenedEvent {
  kind: "opened";
  at: number;
  url: string;
  /** A new tile on the canvas; a separate window (a sign-in); the person's own browser. */
  as: "tile" | "window" | "outside";
  reported?: boolean;
}

export type PageEvent = DownloadEvent | OpenedEvent;

const PER_PAGE = 20;
const KEEP_MS = 10 * 60_000;
const MAX_PAGES = 200;

export class PageEvents {
  private readonly byPage = new Map<number, PageEvent[]>();
  private readonly waiters = new Set<() => void>();
  private nextId = 1;

  constructor(readonly now: () => number = Date.now) {}

  private add(pageId: number, event: PageEvent): void {
    const cutoff = this.now() - KEEP_MS;
    const list = (this.byPage.get(pageId) ?? []).filter((e) => e.at >= cutoff);
    list.push(event);
    this.byPage.delete(pageId);
    this.byPage.set(pageId, list.slice(-PER_PAGE));
    while (this.byPage.size > MAX_PAGES) this.byPage.delete(this.byPage.keys().next().value as number);
    this.changed();
  }

  private changed(): void {
    for (const w of [...this.waiters]) w();
  }

  /** A download began; returns its id, for progress and the end. */
  downloadStarted(pageId: number, d: { file: string; path: string; url: string; total: number }): number {
    const id = this.nextId++;
    this.add(pageId, { kind: "download", id, at: this.now(), state: "progressing", bytes: 0, ...d });
    return id;
  }

  downloadUpdated(pageId: number, id: number, update: { state?: DownloadState; bytes?: number; total?: number }): void {
    const e = this.byPage.get(pageId)?.find((x): x is DownloadEvent => x.kind === "download" && x.id === id);
    if (!e) return;
    if (update.state) e.state = update.state;
    if (update.bytes !== undefined) e.bytes = update.bytes;
    if (update.total !== undefined && update.total > 0) e.total = update.total;
    this.changed();
  }

  opened(pageId: number, url: string, as: OpenedEvent["as"]): void {
    this.add(pageId, { kind: "opened", at: this.now(), url, as });
  }

  /** What the page did from `since` on, and anything not yet told to an agent, oldest first. */
  since(pageId: number, since: number): PageEvent[] {
    return (this.byPage.get(pageId) ?? []).filter((e) => e.at >= since || !e.reported).map((e) => ({ ...e }));
  }

  /** The same, marking what's told as told: a download still coming is told again until it's done. */
  take(pageId: number, since: number): PageEvent[] {
    const out = this.since(pageId, since);
    for (const e of this.byPage.get(pageId) ?? []) {
      if ((e.at >= since || !e.reported) && !(e.kind === "download" && e.state === "progressing")) e.reported = true;
    }
    return out;
  }

  /** Resolves when `test` holds for the page's events since `since`, or with null after `ms`. */
  waitFor<T>(pageId: number, since: number, test: (events: PageEvent[]) => T | null | undefined, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        const hit = test(this.since(pageId, since));
        if (hit === null || hit === undefined) return false;
        finish(hit);
        return true;
      };
      const finish = (value: T | null) => {
        this.waiters.delete(onChange);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const onChange = () => void check();
      if (check()) return;
      this.waiters.add(onChange);
      timer = setTimeout(() => finish(null), ms);
    });
  }
}

/** The one main keeps. */
export const pageEvents = new PageEvents();
