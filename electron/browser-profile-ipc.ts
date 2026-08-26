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
