/**
 * The disk half of the partition registry (shared/browser-partition-registry.ts
 * holds the shapes and the pure bookkeeping).
 *
 * This is the only place in the app that removes a browser profile's files, and
 * it is driven by ids that originated in a renderer message, so every path it
 * touches is rebuilt from a validated identity id and re-checked against the
 * partitions root before anything is unlinked. Nothing outside
 * `userData/Partitions` can be reached from here, whatever arrives.
 *
 * Session data is not cleared here. Clearing storage is Electron's job and
 * belongs in main; this file owns the directory afterwards — including the case
 * where it cannot be removed yet, which is recorded and collected at the next
 * start rather than forced under a live session.
 */

import fs from "node:fs";
import path from "node:path";
import {
  clearPendingReap,
  coercePartitionRegistry,
  emptyPartitionRegistry,
  forgetPartition,
  identityIdFromPartitionDirName,
  orphanedPartitions,
  partitionDirNameForIdentity,
  recordPendingReap,
  registerPartition,
  type OrphanPartitionSummary,
  type PartitionOrigin,
  type PartitionRegistryDocument,
} from "../shared/browser-partition-registry";
import { isValidBrowserIdentityId } from "../shared/browser-profile-import";

export const PARTITIONS_DIR_NAME = "Partitions";
export const PARTITION_REGISTRY_FILE = "browser-partitions.json";

interface PartitionDirent {
  name: string;
  isDirectory(): boolean;
}

interface PartitionStats {
  size: number;
  birthtimeMs: number;
  mtimeMs: number;
}

/** The filesystem surface this store uses, injectable so tests can drive it. */
export interface PartitionFileSystem {
  existsSync(target: string): boolean;
  mkdirSync(target: string, options: { recursive: true }): void;
  readFileSync(target: string, encoding: "utf8"): string;
  writeFileSync(
    target: string,
    data: string,
    options: { encoding: "utf8"; mode?: number },
  ): void;
  renameSync(from: string, to: string): void;
  readdirSync(target: string, options: { withFileTypes: true }): PartitionDirent[];
  statSync(target: string): PartitionStats;
  rmSync(target: string, options: { recursive: true; force: true }): void;
}

const nodeFileSystem: PartitionFileSystem = {
  existsSync: (target) => fs.existsSync(target),
  mkdirSync: (target, options) => void fs.mkdirSync(target, options),
  readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
  writeFileSync: (target, data, options) => fs.writeFileSync(target, data, options),
  renameSync: (from, to) => fs.renameSync(from, to),
  readdirSync: (target, options) => fs.readdirSync(target, options),
  statSync: (target) => fs.statSync(target),
  rmSync: (target, options) => fs.rmSync(target, options),
};

export interface BrowserPartitionStoreDeps {
  userDataDir: string;
  fileSystem?: PartitionFileSystem;
  now?: () => number;
  /**
   * Whether a live guest is still running on this profile's session. Electron
   * cannot destroy a session, so a directory under one may be recreated the
   * moment it is removed; when this says yes, the removal waits for a restart.
   */
  isPartitionInUse?: (identityId: string) => boolean;
  log?: (event: {
    event: "adopted" | "pruned" | "reaped" | "reap-pending" | "reap-failed" | "registry-unreadable";
    identityId?: string;
    detail?: string;
  }) => void;
}

export type EraseOutcome = "erased" | "pending" | "absent";

export interface PartitionStartupReport {
  /** Directories found on disk that no registry entry covered yet. */
  adopted: number;
  /** Registry entries whose directory is already gone. */
  pruned: number;
  /** Directories removed to satisfy a reap recorded before the last exit. */
  reaped: number;
  /** Reaps still outstanding, to be retried at the next start. */
  stillPending: number;
}

export function partitionsRootFor(userDataDir: string): string {
  return path.resolve(userDataDir, PARTITIONS_DIR_NAME);
}

/**
 * The one path builder. An identity id is the only accepted input, it is
 * validated by the same rule the rest of the app uses, and the result is
 * re-checked to be a direct child of the partitions root — so a traversal that
 * somehow survived id validation still cannot name a directory to delete.
 */
export function resolvePartitionDirectory(
  partitionsRoot: string,
  identityId: unknown,
): string {
  if (!isValidBrowserIdentityId(identityId)) {
    throw new Error("Refused a browser partition path for an invalid profile id");
  }
  const root = path.resolve(partitionsRoot);
  const resolved = path.resolve(root, partitionDirNameForIdentity(identityId));
  assertInsidePartitionsRoot(root, resolved);
  return resolved;
}

/**
 * The guard every removal passes through. Exported because it is the invariant
 * worth testing on its own: nothing at or above the partitions root, and no
 * path that merely shares its prefix (`…/PartitionsBackup`), is deletable.
 */
export function assertInsidePartitionsRoot(
  partitionsRoot: string,
  candidate: string,
): void {
  const root = path.resolve(partitionsRoot);
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error("Refused to remove a path outside the browser partitions directory");
  }
  if (path.dirname(resolved) !== root) {
    throw new Error("Refused to remove a path that is not a browser partition directory");
  }
}

export class BrowserPartitionStore {
  private readonly fileSystem: PartitionFileSystem;
  private readonly now: () => number;
  private readonly inUse: (identityId: string) => boolean;
  private readonly log: NonNullable<BrowserPartitionStoreDeps["log"]>;
  readonly partitionsRoot: string;
  readonly registryPath: string;
  private document: PartitionRegistryDocument;

  constructor(deps: BrowserPartitionStoreDeps) {
    this.fileSystem = deps.fileSystem ?? nodeFileSystem;
    this.now = deps.now ?? Date.now;
    this.inUse = deps.isPartitionInUse ?? (() => false);
    this.log = deps.log ?? (() => {});
    this.partitionsRoot = partitionsRootFor(deps.userDataDir);
    this.registryPath = path.resolve(deps.userDataDir, PARTITION_REGISTRY_FILE);
    this.document = this.read();
  }

  /** The current registry, for diagnostics and tests. */
  snapshot(): PartitionRegistryDocument {
    return this.document;
  }

  private read(): PartitionRegistryDocument {
    if (!this.fileSystem.existsSync(this.registryPath)) return emptyPartitionRegistry();
    try {
      return coercePartitionRegistry(
        JSON.parse(this.fileSystem.readFileSync(this.registryPath, "utf8")),
      );
    } catch (error) {
      // An unreadable registry must not take the app down, and must not be
      // silently replaced either — the directories it described are still on
      // disk and get adopted back at startup.
      this.log({
        event: "registry-unreadable",
        detail: error instanceof Error ? error.name : "UnknownError",
      });
      return emptyPartitionRegistry();
    }
  }

  private write(next: PartitionRegistryDocument): void {
    this.document = next;
    this.fileSystem.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const temporaryPath = `${this.registryPath}.tmp`;
    this.fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.fileSystem.renameSync(temporaryPath, this.registryPath);
  }

  /**
   * Records a partition at the moment it is materialised. Called before the
   * work that might fail, so a half-finished import still leaves something that
   * knows the directory exists.
   */
  register(
    identityId: string,
    options: { origin?: PartitionOrigin; label?: string; createdAt?: number } = {},
  ): void {
    if (!isValidBrowserIdentityId(identityId)) return;
    const before = this.document;
    const after = registerPartition(before, {
      identityId,
      createdAt: options.createdAt ?? this.now(),
      origin: options.origin ?? "session",
      ...(options.label?.trim() ? { label: options.label.trim().slice(0, 200) } : {}),
    });
    if (after !== before) this.write(after);
  }

  /**
   * Startup reconciliation: adopt directories that predate the registry, drop
   * entries whose directory is gone, and collect removals that could not happen
   * while the last session was live. Nothing here consults the workspace — this
   * is only about what is on disk.
   */
  start(): PartitionStartupReport {
    const report: PartitionStartupReport = { adopted: 0, pruned: 0, reaped: 0, stillPending: 0 };
    let next = this.document;

    for (const dirName of this.readPartitionDirNames()) {
      const identityId = identityIdFromPartitionDirName(dirName);
      if (!identityId) continue;
      if (next.partitions.some((entry) => entry.identityId === identityId)) continue;
      next = registerPartition(next, {
        identityId,
        createdAt: this.directoryCreatedAt(identityId),
        origin: "adopted",
      });
      report.adopted += 1;
      this.log({ event: "adopted", identityId });
    }

    for (const entry of [...next.partitions]) {
      if (this.directoryExists(entry.identityId)) continue;
      next = forgetPartition(next, entry.identityId);
      report.pruned += 1;
      this.log({ event: "pruned", identityId: entry.identityId });
    }

    for (const pending of [...next.pendingReaps]) {
      const outcome = this.removeDirectory(pending.identityId);
      if (outcome === "removed" || outcome === "absent") {
        next = forgetPartition(next, pending.identityId);
        if (outcome === "removed") report.reaped += 1;
        this.log({ event: "reaped", identityId: pending.identityId });
      } else {
        report.stillPending += 1;
        this.log({ event: "reap-failed", identityId: pending.identityId, detail: outcome });
      }
    }

    this.write(next);
    return report;
  }

  /**
   * Partitions on disk that the workspace has no profile for. Size and
   * created-at only — an orphan's contents are never opened to describe it.
   */
  listOrphans(identityIds: readonly string[]): OrphanPartitionSummary[] {
    return orphanedPartitions(this.document, identityIds)
      .filter((entry) => this.directoryExists(entry.identityId))
      .map((entry) => ({
        identityId: entry.identityId,
        createdAt: entry.createdAt || this.directoryCreatedAt(entry.identityId),
        sizeBytes: this.directorySize(entry.identityId),
        ...(entry.label ? { label: entry.label } : {}),
      }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * Removes a partition directory and its registry entry. The caller is
   * responsible for having cleared the session's own data first; this is the
   * step that makes "erased" true on disk.
   *
   * Returns "pending" when the directory cannot go yet — the entry stays and
   * the removal is recorded for the next start.
   */
  erase(identityId: string): EraseOutcome {
    if (!isValidBrowserIdentityId(identityId)) {
      throw new Error("Refused to erase an invalid browser profile id");
    }
    if (this.inUse(identityId)) {
      this.write(recordPendingReap(this.document, identityId, this.now()));
      this.log({ event: "reap-pending", identityId, detail: "in-use" });
      return "pending";
    }
    const outcome = this.removeDirectory(identityId);
    if (outcome === "removed" || outcome === "absent") {
      this.write(forgetPartition(this.document, identityId));
      return outcome === "removed" ? "erased" : "absent";
    }
    this.write(recordPendingReap(this.document, identityId, this.now()));
    this.log({ event: "reap-pending", identityId, detail: outcome });
    return "pending";
  }

  private removeDirectory(identityId: string): "removed" | "absent" | "failed" | "recreated" {
    let directory: string;
    try {
      directory = resolvePartitionDirectory(this.partitionsRoot, identityId);
    } catch {
      return "failed";
    }
    if (!this.fileSystem.existsSync(directory)) return "absent";
    try {
      this.fileSystem.rmSync(directory, { recursive: true, force: true });
    } catch {
      return "failed";
    }
    // A session that is still alive can rebuild its directory the instant it is
    // unlinked. Verifying rather than trusting the call is what turns that case
    // into a pending reap instead of a silent survivor.
    return this.fileSystem.existsSync(directory) ? "recreated" : "removed";
  }

  private readPartitionDirNames(): string[] {
    if (!this.fileSystem.existsSync(this.partitionsRoot)) return [];
    try {
      return this.fileSystem
        .readdirSync(this.partitionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private directoryExists(identityId: string): boolean {
    try {
      return this.fileSystem.existsSync(
        resolvePartitionDirectory(this.partitionsRoot, identityId),
      );
    } catch {
      return false;
    }
  }

  private directoryCreatedAt(identityId: string): number {
    try {
      const stats = this.fileSystem.statSync(
        resolvePartitionDirectory(this.partitionsRoot, identityId),
      );
      return Math.round(stats.birthtimeMs || stats.mtimeMs) || this.now();
    } catch {
      return this.now();
    }
  }

  /** Recursive size, bounded so a pathological tree cannot stall startup. */
  private directorySize(identityId: string): number {
    let directory: string;
    try {
      directory = resolvePartitionDirectory(this.partitionsRoot, identityId);
    } catch {
      return 0;
    }
    let total = 0;
    let budget = 20_000;
    const queue = [directory];
    while (queue.length > 0 && budget > 0) {
      const current = queue.pop()!;
      let entries: PartitionDirent[];
      try {
        entries = this.fileSystem.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        budget -= 1;
        if (budget <= 0) break;
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(child);
          continue;
        }
        try {
          total += this.fileSystem.statSync(child).size;
        } catch {
          // A file that vanished mid-walk contributes nothing; the number is a
          // description for a human, not an accounting figure.
        }
      }
    }
    return total;
  }
}
