import {
  isValidBrowserIdentityId,
  partitionForBrowserIdentity,
} from "../shared/browser-profile-import";

export interface ChromeProfileImportRequest {
  profileIds: string[];
  existingIdentityNames: string[];
}

export function resolveIdentityClearPartition(identityId: unknown): string {
  if (!isValidBrowserIdentityId(identityId)) {
    throw new Error("Refused to clear an invalid browser identity");
  }
  return partitionForBrowserIdentity(identityId);
}

export function validateChromeProfileImportRequest(
  input: unknown,
): ChromeProfileImportRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Chrome profile import request is required");
  }
  const { profileIds, existingIdentityNames } = input as Record<string, unknown>;
  if (!Array.isArray(profileIds) || profileIds.length === 0 || profileIds.length > 100 ||
      !profileIds.every((id) => typeof id === "string")) {
    throw new Error("Chrome profile ids are required");
  }
  if (!Array.isArray(existingIdentityNames) || existingIdentityNames.length > 1000 ||
      !existingIdentityNames.every((name) => typeof name === "string" && name.length <= 200)) {
    throw new Error("Existing identity names are invalid");
  }
  return { profileIds, existingIdentityNames };
}

export interface OrphanPartitionDiffRequest {
  identityIds: string[];
}

/**
 * The workspace's profile list, on its way to being diffed against what is on
 * disk. Unknown-shaped ids are dropped rather than rejected: a workspace that
 * somehow carries one is exactly the case this feature exists for, and refusing
 * the whole request would hide every orphan instead of showing them.
 */
export function validateOrphanPartitionDiffRequest(
  input: unknown,
): OrphanPartitionDiffRequest {
  const identityIds = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? (input as Record<string, unknown>).identityIds
      : null;
  if (!Array.isArray(identityIds) || identityIds.length > 1000) {
    throw new Error("Browser profile ids are required");
  }
  return { identityIds: identityIds.filter(isValidBrowserIdentityId) };
}

export interface OrphanPartitionEraseRequest {
  identityId: string;
}

/**
 * Erasing an orphan removes a directory outright, without the session clearing
 * a live profile's deletion goes through. The caller therefore sends the
 * profile list it believes in, and a target that appears in it is refused: a
 * renderer bug that pointed this at a profile the user still has would
 * otherwise erase a working login through the path that skips session cleanup.
 */
export function validateOrphanPartitionEraseRequest(
  input: unknown,
): OrphanPartitionEraseRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Browser partition erase request is required");
  }
  const { identityId, identityIds } = input as Record<string, unknown>;
  if (!isValidBrowserIdentityId(identityId)) {
    throw new Error("Refused to erase an invalid browser partition");
  }
  if (!Array.isArray(identityIds) || identityIds.length > 1000) {
    throw new Error("Browser profile ids are required");
  }
  if (identityIds.includes(identityId)) {
    throw new Error("That profile still exists; delete it from the profile list instead");
  }
  return { identityId };
}
