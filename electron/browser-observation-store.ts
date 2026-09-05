/**
 * Tier 2 of the record: the per-profile browser activity stream.
 *
 * Append-only JSONL, one file per browser profile, living in userData rather
 * than in the workspace. That location is the point: a workspace snapshot is a
 * file people copy, share, and commit, and the contents of pages you were
 * logged into must never travel that way. Tier 1 (shared/capture.ts) keeps the
 * choice points and *references* these entries; this is where the bulk lives.
 *
 * Two gates run here rather than in the preload, because a guest renderer is
 * the least trustworthy place to enforce anything:
 *
 *  - Every observation is re-validated. The preload builds them, but main is
 *    what writes them, and a malformed one is dropped rather than repaired.
 *  - Redaction is applied to page text. The preload does not know the rules and
 *    must not: a compromised page could otherwise learn which sites the user
 *    considers sensitive by watching what does not get sent.
 */

import fs from "fs";
import path from "path";
import {
  isNearDuplicateText,
  isWellFormedObservation,
  type BrowserObservation,
  type BrowserObservationSummary,
} from "../shared/browser-observation";
import {
  isRedactedUrl,
  type RedactionRule,
} from "../shared/browser-redaction";

export interface BrowserObservationEntry {
  schema_version: 1;
  at: string;
  profile: string;
  observation: BrowserObservation;
  /** Present only when page text was dropped, naming why. */
  redacted?: true;
}

export type ObservationOutcome =
  | { written: true; redacted: boolean }
  | { written: false; reason: "malformed" | "duplicate" | "unknown-profile" };

export interface BrowserObservationStoreDeps {
  rootDir: string;
  rules?: readonly RedactionRule[];
  appendFile?: (file: string, line: string) => void;
  now?: () => Date;
}

function defaultAppend(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, "utf8");
}

/**
 * Profile ids are validated before they reach a path. They are app-generated,
 * but this file writes to disk from data that originated in a renderer message,
 * so the check is here rather than assumed upstream.
 */
const SAFE_PROFILE_ID = /^[a-z0-9-]{1,128}$/;

export class BrowserObservationStore {
  private readonly rootDir: string;
  private readonly rules?: readonly RedactionRule[];
  private readonly append: (file: string, line: string) => void;
  private readonly now: () => Date;
  /** Last page text per profile, so a re-render is not a second entry. */
  private readonly lastText = new Map<string, { url: string; text: string }>();

  constructor(deps: BrowserObservationStoreDeps) {
    this.rootDir = deps.rootDir;
    this.rules = deps.rules;
    this.append = deps.appendFile ?? defaultAppend;
    this.now = deps.now ?? (() => new Date());
  }

  fileFor(profileId: string): string {
    if (!SAFE_PROFILE_ID.test(profileId)) {
      throw new Error("Refused an activity file for an invalid profile id");
    }
    const resolved = path.resolve(this.rootDir, `${profileId}.jsonl`);
    // Re-checked after joining, the same way partition removal is: this path is
    // built from data that arrived in a renderer message and is about to be
    // read or deleted.
    if (path.dirname(resolved) !== path.resolve(this.rootDir)) {
      throw new Error("Refused an activity file outside the observation directory");
    }
    return resolved;
  }

  /**
   * How much has been recorded, per profile.
   *
   * Exists so the user can be shown what they are carrying before deciding to
   * erase it. An app that watches a browser and cannot say how much it wrote is
   * asking for trust it has not earned.
   */
  summary(): BrowserObservationSummary {
    const profiles: BrowserObservationSummary["profiles"] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.rootDir);
    } catch {
      // No directory yet means nothing has ever been recorded, which is a
      // truthful empty summary rather than a failure.
      return { profiles: [], totalEntries: 0, totalBytes: 0 };
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const profileId = name.slice(0, -".jsonl".length);
      if (!SAFE_PROFILE_ID.test(profileId)) continue;
      try {
        const file = this.fileFor(profileId);
        const bytes = fs.statSync(file).size;
        // Newlines counted over raw bytes: the point is to describe the file's
        // size, not to decode the pages back into memory to say how many there
        // are. One entry per line, because the stream is append-only JSONL.
        const contents = fs.readFileSync(file);
        let entries = 0;
        for (let at = contents.indexOf(0x0a); at !== -1; at = contents.indexOf(0x0a, at + 1)) {
          entries += 1;
        }
        profiles.push({ profileId, entries, bytes });
      } catch {
        // A file that vanished or cannot be read contributes nothing; this is a
        // description for a human, not an audit.
      }
    }
    profiles.sort((left, right) => right.bytes - left.bytes);
    return {
      profiles,
      totalEntries: profiles.reduce((sum, entry) => sum + entry.entries, 0),
      totalBytes: profiles.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }

  /**
   * Erase what was recorded, for one profile or for all of them.
   *
   * Removing the file is the whole operation — the stream is append-only, so
   * there is no index to repair and nothing that outlives the file. The
   * in-memory duplicate guard is dropped alongside it, or the next observation
   * after an erase would be discarded as a repeat of something no longer there.
   */
  clear(profileId?: string): { cleared: number } {
    if (profileId !== undefined) {
      const file = this.fileFor(profileId);
      this.lastText.delete(profileId);
      if (!fs.existsSync(file)) return { cleared: 0 };
      fs.rmSync(file, { force: true });
      return { cleared: 1 };
    }
    let cleared = 0;
    for (const entry of this.summary().profiles) {
      try {
        fs.rmSync(this.fileFor(entry.profileId), { force: true });
        cleared += 1;
      } catch {
        // Reported by what remains in the next summary rather than thrown: one
        // stubborn file must not stop the rest of an erase the user asked for.
      }
    }
    this.lastText.clear();
    return { cleared };
  }

  record(profileId: string, observation: unknown): ObservationOutcome {
    if (!SAFE_PROFILE_ID.test(profileId)) {
      return { written: false, reason: "unknown-profile" };
    }
    if (!isWellFormedObservation(observation)) {
      return { written: false, reason: "malformed" };
    }

    let entry: BrowserObservationEntry = {
      schema_version: 1,
      at: this.now().toISOString(),
      profile: profileId,
      observation,
    };

    if (observation.type === "page_text") {
      if (isRedactedUrl(observation.url, this.rules)) {
        // The visit still happened and still belongs in the record; only its
        // contents are withheld. Dropping the entry entirely would make the
        // record quietly lie about where the work went.
        const { text: _dropped, truncated: _t, ...rest } = observation;
        entry = {
          ...entry,
          observation: { ...rest, text: "", truncated: false },
          redacted: true,
        };
      } else {
        // A second line of defence behind the preload's rate limit, and the
        // one that survives a reload: compared by similarity rather than by
        // hash, because a live page is never byte-identical to itself and an
        // exact-match check therefore never fires.
        const previous = this.lastText.get(profileId);
        if (
          previous &&
          previous.url === observation.url &&
          isNearDuplicateText(previous.text, observation.text)
        ) {
          return { written: false, reason: "duplicate" };
        }
        this.lastText.set(profileId, { url: observation.url, text: observation.text });
      }
    }

    this.append(this.fileFor(profileId), `${JSON.stringify(entry)}\n`);
    return { written: true, redacted: entry.redacted === true };
  }
}
