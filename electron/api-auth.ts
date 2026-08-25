import { randomBytes, timingSafeEqual } from "node:crypto";

export function createApiAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isAuthorizedBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const supplied = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice(7)
    : "";
  const expected = Buffer.from(expectedToken);
  const candidate = Buffer.from(supplied);
  return (
    expected.length === candidate.length && timingSafeEqual(expected, candidate)
  );
}
