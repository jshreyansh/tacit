/**
 * The record of what browser profile storage actually exists on disk.
 *
 * A profile's cookies live in an Electron partition directory under
 * `userData/Partitions`. The list of profiles the user can see lives in the
 * workspace file. Those two drift: emptying a partition leaves its directory
 * behind, and a workspace restored from before profiles existed drops every
 * imported profile while its directory — holding real logins — stays on disk,
 * unreachable and therefore unerasable.
 *
 * This registry is the authority for *what exists*; the workspace stays the
 * authority for *what the user sees*. Main owns it, writes it the moment a
 * partition is materialised, and diffs the two at startup so a partition can
 * never be forgotten silently.
 *
 * Everything here is pure: no filesystem, no Electron, no absolute paths — the
 * shapes in this file are the ones that cross into the renderer, and a path
 * must never be one of them (see electron/browser-partition-store.ts for the
 * side of this that touches disk).
 */

import { isValidBrowserIdentityId } from "./browser-profile-import";

export const PARTITION_REGISTRY_VERSION = 1;

/** How a partition came to exist, for describing an orphan to its owner. */
export type PartitionOrigin = "session" | "import" | "adopted";

export interface PartitionRegistryEntry {
  identityId: string;
  createdAt: number;
  origin: PartitionOrigin;
  /** Non-secret label captured when the partition was made, when one was known. */
  label?: string;
}

/**
 * A partition whose data is gone but whose directory could not be removed yet.
 *
 * Electron has no `session.destroy()`, so a session that has been used in this
 * process may hold its files open for the life of the process. Deleting under
 * it risks Chromium recreating what we just removed, so the removal is recorded
 * and collected at the next start, when nothing is holding anything.
 */
export interface PendingPartitionReap {
  identityId: string;
  requestedAt: number;
}

export interface PartitionRegistryDocument {
  version: number;
  partitions: PartitionRegistryEntry[];
  pendingReaps: PendingPartitionReap[];
}

/**
 * What the renderer is told about a partition with no profile. Size and age
 * only: an orphan's contents are never read to describe it.
 */
export interface OrphanPartitionSummary {
  identityId: string;
  createdAt: number;
  sizeBytes: number;
  label?: string;
}

export function emptyPartitionRegistry(): PartitionRegistryDocument {
  return { version: PARTITION_REGISTRY_VERSION, partitions: [], pendingReaps: [] };
}

/**
 * Electron names a persistent partition's directory after the part following
 * `persist:`, which for our profiles is `identity-<identity id>` — and our
 * identity ids themselves start with `identity-`, hence the doubled prefix on
 * disk. Throwing rather than sanitising is deliberate: this name becomes a path
 * that something gets deleted from.
 */
export function partitionDirNameForIdentity(identityId: unknown): string {
  if (!isValidBrowserIdentityId(identityId)) {
    throw new Error("Refused a partition directory for an invalid browser profile id");
  }
  return `identity-${identityId}`;
}

/**
 * The inverse, for adopting directories that predate this registry. Returns
 * null for anything that is not one of our profile partitions — Electron keeps
 * its own directories under the same root, and those are not ours to touch.
 */
export function identityIdFromPartitionDirName(dirName: unknown): string | null {
  if (typeof dirName !== "string") return null;
  const prefix = "identity-";
  if (!dirName.startsWith(prefix)) return null;
  const identityId = dirName.slice(prefix.length);
  return isValidBrowserIdentityId(identityId) ? identityId : null;
}

function coerceEntry(value: unknown): PartitionRegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isValidBrowserIdentityId(raw.identityId)) return null;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
    ? raw.createdAt
    : 0;
  const origin: PartitionOrigin =
    raw.origin === "import" || raw.origin === "adopted" ? raw.origin : "session";
  const label = typeof raw.label === "string" && raw.label.trim()
    ? raw.label.trim().slice(0, 200)
    : undefined;
  return { identityId: raw.identityId, createdAt, origin, ...(label ? { label } : {}) };
}

function coercePending(value: unknown): PendingPartitionReap | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isValidBrowserIdentityId(raw.identityId)) return null;
  const requestedAt = typeof raw.requestedAt === "number" && Number.isFinite(raw.requestedAt)
    ? raw.requestedAt
    : 0;
  return { identityId: raw.identityId, requestedAt };
}

/**
 * Parses a registry file. A damaged or partly unreadable file degrades to the
 * entries that are still readable rather than to nothing: every entry dropped
 * here is a directory that becomes invisible again, which is the failure this
 * whole registry exists to prevent.
 */
export function coercePartitionRegistry(value: unknown): PartitionRegistryDocument {
  if (!value || typeof value !== "object") return emptyPartitionRegistry();
  const raw = value as Record<string, unknown>;
  const partitions: PartitionRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(raw.partitions) ? raw.partitions : []) {
    const entry = coerceEntry(candidate);
    if (!entry || seen.has(entry.identityId)) continue;
    seen.add(entry.identityId);
    partitions.push(entry);
  }
  const pendingReaps: PendingPartitionReap[] = [];
  const pendingSeen = new Set<string>();
  for (const candidate of Array.isArray(raw.pendingReaps) ? raw.pendingReaps : []) {
    const pending = coercePending(candidate);
    if (!pending || pendingSeen.has(pending.identityId)) continue;
    pendingSeen.add(pending.identityId);
    pendingReaps.push(pending);
  }
  return { version: PARTITION_REGISTRY_VERSION, partitions, pendingReaps };
}

/**
 * Records a partition. Re-registering an existing one keeps the original
 * created-at — the first sighting is the true one — and only fills in a label
 * that was not known before.
 */
export function registerPartition(
  document: PartitionRegistryDocument,
  entry: PartitionRegistryEntry,
): PartitionRegistryDocument {
  const existing = document.partitions.find((p) => p.identityId === entry.identityId);
  if (!existing) {
    return { ...document, partitions: [...document.partitions, entry] };
  }
  if (existing.label || !entry.label) return document;
  return {
    ...document,
    partitions: document.partitions.map((p) =>
      p.identityId === entry.identityId ? { ...p, label: entry.label } : p,
    ),
  };
}

/** Drops a partition and any pending removal for it — the directory is gone. */
export function forgetPartition(
  document: PartitionRegistryDocument,
  identityId: string,
): PartitionRegistryDocument {
  return {
    ...document,
    partitions: document.partitions.filter((p) => p.identityId !== identityId),
    pendingReaps: document.pendingReaps.filter((p) => p.identityId !== identityId),
  };
}

/**
 * Marks a partition for removal at the next start. The entry stays: the
 * directory is still there, and a registry that forgot it now would be lying
 * about disk again.
 */
export function recordPendingReap(
  document: PartitionRegistryDocument,
  identityId: string,
  requestedAt: number,
): PartitionRegistryDocument {
  if (!isValidBrowserIdentityId(identityId)) {
    throw new Error("Refused to schedule removal for an invalid browser profile id");
  }
  if (document.pendingReaps.some((p) => p.identityId === identityId)) return document;
  return {
    ...document,
    pendingReaps: [...document.pendingReaps, { identityId, requestedAt }],
  };
}

export function clearPendingReap(
  document: PartitionRegistryDocument,
  identityId: string,
): PartitionRegistryDocument {
  return {
    ...document,
    pendingReaps: document.pendingReaps.filter((p) => p.identityId !== identityId),
  };
}

export function isPendingReap(
  document: PartitionRegistryDocument,
  identityId: string,
): boolean {
  return document.pendingReaps.some((p) => p.identityId === identityId);
}

/**
 * The diff this registry exists for: registered partitions the workspace has no
 * profile for. A partition already scheduled for removal is not an orphan —
 * the user has decided about it, and offering it back would undo their answer.
 */
export function orphanedPartitions(
  document: PartitionRegistryDocument,
  identityIds: readonly string[],
): PartitionRegistryEntry[] {
  const known = new Set(identityIds.filter(isValidBrowserIdentityId));
  return document.partitions.filter(
    (entry) => !known.has(entry.identityId) && !isPendingReap(document, entry.identityId),
  );
}

/**
 * What the main process reports back after erasing. The storage clear either
 * happened or threw; the directory can additionally be waiting for a restart,
 * and the UI is told which so it never claims more than is true.
 */
export interface BrowserPartitionEraseResult {
  identityId: string;
  directory: "erased" | "pending" | "absent";
}
