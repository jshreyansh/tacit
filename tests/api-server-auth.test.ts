import test from "node:test";
import assert from "node:assert/strict";

import {
  createApiAuthToken,
  isAuthorizedBearer,
} from "../electron/api-auth.ts";

test("desktop API requires its per-instance bearer token", () => {
  const token = createApiAuthToken();

  assert.ok(token.length >= 43);
  assert.equal(isAuthorizedBearer(undefined, token), false);
  assert.equal(isAuthorizedBearer("Bearer wrong", token), false);
  assert.equal(isAuthorizedBearer(`Bearer ${token}`, token), true);
});
