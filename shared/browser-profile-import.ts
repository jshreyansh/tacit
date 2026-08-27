export type BrowserProfileImportSource = "chrome";

export interface ImportableBrowserProfile {
  source: BrowserProfileImportSource;
  /** Chrome-owned directory key such as `Default` or `Profile 3`. */
  profileId: string;
  /** User-visible Chrome profile name from Local State. */
  name: string;
  /** Non-secret account label (normally an email) exposed by Chrome metadata. */
  accountHint?: string;
  /** Chrome's built-in avatar identifier/URL; never a source filesystem path. */
  avatarHint?: string;
}

export type BrowserProfileCategory =
  | "profileMetadata"
  | "cookies"
  | "siteStorage"
  | "history"
  | "bookmarks"
  | "savedPasswords"
  | "openTabs"
  | "cacheAndWorkers"
  | "protectedState";

export type BrowserProfileCategoryStatus =
  "imported" | "partial" | "empty" | "unsupported" | "failed";

export interface BrowserProfileCategoryResult {
  status: BrowserProfileCategoryStatus;
  count: number;
  detail?: string;
}

export type BrowserProfileCategorySummary = Record<
  BrowserProfileCategory,
  BrowserProfileCategoryResult
>;

export interface BrowserIdentityProvenance {
  source: BrowserProfileImportSource;
  sourceProfileId: string;
  sourceProfileName: string;
  importedAt: number;
  categories: BrowserProfileCategorySummary;
}

export interface ImportedBrowserIdentity {
  id: string;
  name: string;
  createdAt: number;
  provenance: BrowserIdentityProvenance;
}

export interface BrowserProfileImportSuccess {
  status: "completed";
  profileId: string;
  identity: ImportedBrowserIdentity;
}

export interface BrowserProfileImportFailure {
  status: "failed";
  profileId: string;
  errorCode: "profile_import_failed" | "cleanup_failed";
  error: string;
  cleanup: "completed" | "failed";
}

export type BrowserProfileImportResult =
  | BrowserProfileImportSuccess
  | BrowserProfileImportFailure;

export interface BrowserProfileImportBatchResult {
  source: BrowserProfileImportSource;
  results: BrowserProfileImportResult[];
}

// UUID imports and pre-v2 renderer-created ids both use this traversal-safe
// identifier grammar. Keeping legacy ids valid preserves old workspaces.
const IDENTITY_ID_PATTERN = /^identity-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export function isValidBrowserIdentityId(value: unknown): value is string {
  return value === "identity-default" ||
    (typeof value === "string" && IDENTITY_ID_PATTERN.test(value));
}

export function partitionForBrowserIdentity(identityId: string): string {
  if (!isValidBrowserIdentityId(identityId)) throw new Error("Invalid browser identity id");
  return `persist:identity-${identityId}`;
}

/**
 * The inverse, for main-process code that is handed a partition and needs to
 * know whose it is — observation entries are filed per profile, and the guest
 * that produced one is identified by its session's partition.
 *
 * Returns null rather than throwing: a partition that is not one of ours (a
 * connected tab, or anything Electron created for its own reasons) is a normal
 * thing to be asked about, not an error.
 */
export function identityIdFromPartition(partition: unknown): string | null {
  if (typeof partition !== "string") return null;
  const prefix = "persist:identity-";
  if (!partition.startsWith(prefix)) return null;
  const identityId = partition.slice(prefix.length);
  return isValidBrowserIdentityId(identityId) ? identityId : null;
}
