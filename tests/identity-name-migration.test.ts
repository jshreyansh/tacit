import test from "node:test";
import assert from "node:assert/strict";

import {
  migrateBuiltInIdentityName,
  useIdentityStore,
} from "../src/stores/identityStore.ts";
import {
  DEFAULT_IDENTITY_ID,
  DEFAULT_IDENTITY_NAME,
  type BrowserIdentity,
} from "../src/types/workspace.ts";

/**
 * The built-in profile's name lives in the workspace document, not in code,
 * so renaming the constant to "Guest" only reached workspaces created after
 * the change. Existing ones kept showing "Default" — the very name that made
 * the empty, signed-out profile read as the right one to use.
 */

function identity(
  id: string,
  name: string,
  createdAt = 1,
): BrowserIdentity {
  return { id, name, createdAt };
}

test("the built-in profile is renamed to Guest on load", () => {
  const migrated = migrateBuiltInIdentityName([
    identity(DEFAULT_IDENTITY_ID, "Default"),
    identity("identity-work", "Work"),
  ]);

  assert.equal(migrated[0].name, DEFAULT_IDENTITY_NAME);
  assert.equal(migrated[0].id, DEFAULT_IDENTITY_ID);
  assert.equal(migrated[0].createdAt, 1, "nothing else about it changes");
  assert.equal(migrated[1].name, "Work", "other profiles are untouched");
});

test("a name the user chose themselves is left alone", () => {
  // Someone who renamed the built-in profile has already said what they want
  // it called. That outranks the new default.
  for (const chosen of ["Personal", "默认", "Default profile", "guest account"]) {
    const migrated = migrateBuiltInIdentityName([
      identity(DEFAULT_IDENTITY_ID, chosen),
    ]);
    assert.equal(migrated[0].name, chosen, `renamed "${chosen}" unexpectedly`);
  }
});

test("an imported profile already called Guest keeps the name to itself", () => {
  // Chrome profiles can be called anything, "Guest" included. Two rows with
  // the same name would be worse than one stale one.
  const migrated = migrateBuiltInIdentityName([
    identity(DEFAULT_IDENTITY_ID, "Default"),
    identity("identity-imported", "guest"),
  ]);
  assert.equal(migrated[0].name, "Default");
});

test("a workspace with no built-in profile migrates cleanly", () => {
  const only = [identity("identity-work", "Work")];
  assert.deepEqual(migrateBuiltInIdentityName(only), only);
  assert.deepEqual(migrateBuiltInIdentityName([]), []);
});

test("hydrating a stored workspace applies the rename", () => {
  useIdentityStore
    .getState()
    .hydrate(
      [
        identity(DEFAULT_IDENTITY_ID, "Default"),
        identity("identity-work", "Work"),
      ],
      DEFAULT_IDENTITY_ID,
    );

  const { identities, activeIdentityId } = useIdentityStore.getState();
  assert.equal(identities[DEFAULT_IDENTITY_ID].name, DEFAULT_IDENTITY_NAME);
  assert.equal(activeIdentityId, DEFAULT_IDENTITY_ID);
  assert.equal(identities["identity-work"].name, "Work");

  // Idempotent: loading the already-migrated workspace changes nothing.
  useIdentityStore
    .getState()
    .hydrate(Object.values(identities), activeIdentityId);
  assert.equal(
    useIdentityStore.getState().identities[DEFAULT_IDENTITY_ID].name,
    DEFAULT_IDENTITY_NAME,
  );

  // And a rename the user makes afterwards survives the next load.
  useIdentityStore.getState().renameIdentity(DEFAULT_IDENTITY_ID, "Mine");
  useIdentityStore
    .getState()
    .hydrate(
      Object.values(useIdentityStore.getState().identities),
      DEFAULT_IDENTITY_ID,
    );
  assert.equal(
    useIdentityStore.getState().identities[DEFAULT_IDENTITY_ID].name,
    "Mine",
  );
});
