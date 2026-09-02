import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertInsidePartitionsRoot,
  BrowserPartitionStore,
  partitionsRootFor,
  resolvePartitionDirectory,
  type PartitionFileSystem,
} from "../electron/browser-partition-store";
import { partitionDirNameForIdentity } from "../shared/browser-partition-registry";
import {
  validateOrphanPartitionDiffRequest,
  validateOrphanPartitionEraseRequest,
} from "../electron/browser-profile-ipc";

const IMPORTED = "identity-ec994ff1-dd26-4ce4-93c1-32a4b6c9c17e";
const ORPHAN = "identity-4552a80f-a4d8-4150-8987-c4eb6a4e8f68";

function userDataFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-partitions-test-"));
  fs.mkdirSync(partitionsRootFor(root), { recursive: true });
  return root;
}

/** A partition directory with a file in it, the way Electron leaves one. */
function seedPartition(userDataDir: string, identityId: string, bytes = 32): string {
  const directory = path.join(
    partitionsRootFor(userDataDir),
    partitionDirNameForIdentity(identityId),
  );
  fs.mkdirSync(path.join(directory, "Network"), { recursive: true });
  fs.writeFileSync(path.join(directory, "Network", "Cookies"), "x".repeat(bytes));
  return directory;
}

test("a path outside the partitions root is refused", () => {
  const root = partitionsRootFor("/tmp/tacit-userdata");
  for (const candidate of [
    "/etc/passwd",
    "/tmp/tacit-userdata",
    root,
    `${root}/../secrets`,
    `${root}/identity-a/../../secrets`,
    "/tmp/tacit-userdataPartitionsBackup/identity-x",
    `${root}Backup/identity-x`,
  ]) {
    assert.throws(
      () => assertInsidePartitionsRoot(root, candidate),
      /outside the browser partitions directory|not a browser partition directory/,
      candidate,
    );
  }
  // A nested path inside a partition is refused too: only whole partition
  // directories are ever removed.
  assert.throws(
    () => assertInsidePartitionsRoot(root, `${root}/identity-identity-default/Cookies`),
    /not a browser partition directory/,
  );
  assert.doesNotThrow(() =>
    assertInsidePartitionsRoot(root, `${root}/identity-identity-default`),
  );
});

test("a partition path can only be built from a valid identity id", () => {
  const root = partitionsRootFor("/tmp/tacit-userdata");
  assert.equal(
    resolvePartitionDirectory(root, "identity-default"),
    path.join(root, "identity-identity-default"),
  );
  for (const identityId of ["../../etc", "identity-a/../../b", "", null, 7]) {
    assert.throws(
      () => resolvePartitionDirectory(root, identityId),
      /invalid profile id/,
      String(identityId),
    );
  }
});

test("erasing an invalid id is refused before anything is removed", () => {
  const userDataDir = userDataFixture();
  const store = new BrowserPartitionStore({ userDataDir });
  assert.throws(
    () => store.erase("../../../etc"),
    /invalid browser profile id/,
  );
  assert.equal(fs.existsSync(partitionsRootFor(userDataDir)), true);
});

test("a registered partition is erased directory and all, and forgotten", () => {
  const userDataDir = userDataFixture();
  const directory = seedPartition(userDataDir, IMPORTED);
  const store = new BrowserPartitionStore({ userDataDir });
  store.register(IMPORTED, { origin: "import", label: "Your Chrome" });

  assert.equal(store.erase(IMPORTED), "erased");
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(store.snapshot().partitions, []);
  assert.deepEqual(store.snapshot().pendingReaps, []);
  // The registry survives the process that wrote it.
  assert.deepEqual(new BrowserPartitionStore({ userDataDir }).snapshot().partitions, []);
});

test("a partition still in use is not deleted under its session; the next start collects it", () => {
  const userDataDir = userDataFixture();
  const directory = seedPartition(userDataDir, IMPORTED);
  const live = new Set([IMPORTED]);
  const store = new BrowserPartitionStore({
    userDataDir,
    isPartitionInUse: (identityId) => live.has(identityId),
    now: () => 5_000,
  });
  store.register(IMPORTED, { origin: "session" });

  assert.equal(store.erase(IMPORTED), "pending");
  assert.equal(fs.existsSync(directory), true);
  assert.deepEqual(store.snapshot().pendingReaps, [
    { identityId: IMPORTED, requestedAt: 5_000 },
  ]);

  // Next start: nothing is holding it any more.
  const restarted = new BrowserPartitionStore({ userDataDir });
  const report = restarted.start();
  assert.equal(report.reaped, 1);
  assert.equal(report.stillPending, 0);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(restarted.snapshot().partitions, []);
  assert.deepEqual(restarted.snapshot().pendingReaps, []);
});

test("a directory a live session rebuilds is recorded rather than reported gone", () => {
  const userDataDir = userDataFixture();
  const directory = seedPartition(userDataDir, IMPORTED);
  // Chromium recreating its partition the instant it is unlinked.
  const stubbornFileSystem: PartitionFileSystem = {
    existsSync: (target) => fs.existsSync(target),
    mkdirSync: (target, options) => void fs.mkdirSync(target, options),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    writeFileSync: (target, data, options) => fs.writeFileSync(target, data, options),
    renameSync: (from, to) => fs.renameSync(from, to),
    readdirSync: (target, options) => fs.readdirSync(target, options),
    statSync: (target) => fs.statSync(target),
    rmSync: (target, options) => {
      fs.rmSync(target, options);
      fs.mkdirSync(target, { recursive: true });
    },
  };
  const store = new BrowserPartitionStore({
    userDataDir,
    fileSystem: stubbornFileSystem,
    now: () => 9_000,
  });
  store.register(IMPORTED, { origin: "session" });

  assert.equal(store.erase(IMPORTED), "pending");
  assert.equal(fs.existsSync(directory), true);
  assert.deepEqual(store.snapshot().pendingReaps, [
    { identityId: IMPORTED, requestedAt: 9_000 },
  ]);
});

test("a removal that throws is kept for the next start instead of being reported done", () => {
  const userDataDir = userDataFixture();
  seedPartition(userDataDir, IMPORTED);
  const failingFileSystem: PartitionFileSystem = {
    existsSync: (target) => fs.existsSync(target),
    mkdirSync: (target, options) => void fs.mkdirSync(target, options),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    writeFileSync: (target, data, options) => fs.writeFileSync(target, data, options),
    renameSync: (from, to) => fs.renameSync(from, to),
    readdirSync: (target, options) => fs.readdirSync(target, options),
    statSync: (target) => fs.statSync(target),
    rmSync: () => {
      throw new Error("EBUSY");
    },
  };
  const store = new BrowserPartitionStore({
    userDataDir,
    fileSystem: failingFileSystem,
    now: () => 1_000,
  });
  store.register(IMPORTED);
  assert.equal(store.erase(IMPORTED), "pending");

  // A start that still cannot remove it keeps the pending record rather than
  // quietly dropping the directory from the registry.
  const stubborn = new BrowserPartitionStore({ userDataDir, fileSystem: failingFileSystem });
  const report = stubborn.start();
  assert.equal(report.stillPending, 1);
  assert.equal(report.reaped, 0);
  assert.equal(stubborn.snapshot().pendingReaps.length, 1);
});

test("startup adopts partitions that predate the registry and prunes ones already gone", () => {
  const userDataDir = userDataFixture();
  seedPartition(userDataDir, ORPHAN, 2048);
  // Not ours: Electron keeps its own directories under the same root.
  fs.mkdirSync(path.join(partitionsRootFor(userDataDir), "browser"), { recursive: true });
  fs.writeFileSync(path.join(partitionsRootFor(userDataDir), "stray-file"), "x");

  const store = new BrowserPartitionStore({ userDataDir });
  // An entry whose directory was removed behind our back.
  store.register("identity-vanished");
  const report = store.start();

  assert.equal(report.adopted, 1);
  assert.equal(report.pruned, 1);
  assert.deepEqual(
    store.snapshot().partitions.map((entry) => entry.identityId),
    [ORPHAN],
  );
  assert.equal(store.snapshot().partitions[0].origin, "adopted");
});

test("an orphan is described by size and age, never by a path or its contents", () => {
  const userDataDir = userDataFixture();
  seedPartition(userDataDir, IMPORTED, 1024);
  seedPartition(userDataDir, ORPHAN, 2048);
  const store = new BrowserPartitionStore({ userDataDir });
  store.start();

  const orphans = store.listOrphans(["identity-default", IMPORTED]);
  assert.deepEqual(orphans.map((entry) => entry.identityId), [ORPHAN]);
  assert.equal(orphans[0].sizeBytes, 2048);
  assert.ok(orphans[0].createdAt > 0);
  assert.deepEqual(Object.keys(orphans[0]).sort(), ["createdAt", "identityId", "sizeBytes"]);
  assert.equal(
    JSON.stringify(orphans).includes(userDataDir),
    false,
    "an orphan summary must never carry a filesystem path",
  );

  // The label recorded at import time is a name, and names may be shown.
  store.register(ORPHAN, { origin: "import", label: "Your Chrome" });
  const labelled = store
    .listOrphans([])
    .find((entry) => entry.identityId === ORPHAN);
  assert.equal(labelled?.label, "Your Chrome");
});

test("erasing an orphan removes the directory and drops it from the registry", () => {
  const userDataDir = userDataFixture();
  const directory = seedPartition(userDataDir, ORPHAN);
  const store = new BrowserPartitionStore({ userDataDir });
  store.start();
  assert.equal(store.listOrphans([]).length, 1);

  assert.equal(store.erase(ORPHAN), "erased");
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(store.listOrphans([]), []);
  assert.deepEqual(new BrowserPartitionStore({ userDataDir }).listOrphans([]), []);
});

test("a partition whose directory is already absent is forgotten without a pending reap", () => {
  const userDataDir = userDataFixture();
  const store = new BrowserPartitionStore({ userDataDir });
  store.register(IMPORTED);
  assert.equal(store.erase(IMPORTED), "absent");
  assert.deepEqual(store.snapshot().partitions, []);
  assert.deepEqual(store.snapshot().pendingReaps, []);
});

test("an unreadable registry file does not lose the directories it described", () => {
  const userDataDir = userDataFixture();
  seedPartition(userDataDir, ORPHAN);
  fs.writeFileSync(path.join(userDataDir, "browser-partitions.json"), "{ truncated");

  const events: string[] = [];
  const store = new BrowserPartitionStore({
    userDataDir,
    log: (event) => events.push(event.event),
  });
  store.start();
  assert.ok(events.includes("registry-unreadable"));
  assert.deepEqual(
    store.listOrphans([]).map((entry) => entry.identityId),
    [ORPHAN],
  );
});

test("the workspace's profile list survives ids this build cannot read", () => {
  assert.deepEqual(
    validateOrphanPartitionDiffRequest({ identityIds: ["identity-default", "../escape", 7] }),
    { identityIds: ["identity-default"] },
  );
  assert.deepEqual(
    validateOrphanPartitionDiffRequest(["identity-default"]),
    { identityIds: ["identity-default"] },
  );
  assert.throws(() => validateOrphanPartitionDiffRequest("nope"), /required/);
  assert.throws(
    () => validateOrphanPartitionDiffRequest({ identityIds: new Array(1001).fill("identity-default") }),
    /required/,
  );
});

test("the orphan erase path refuses a profile the workspace still has", () => {
  assert.deepEqual(
    validateOrphanPartitionEraseRequest({ identityId: ORPHAN, identityIds: ["identity-default"] }),
    { identityId: ORPHAN },
  );
  assert.throws(
    () =>
      validateOrphanPartitionEraseRequest({
        identityId: IMPORTED,
        identityIds: ["identity-default", IMPORTED],
      }),
    /still exists/,
  );
  assert.throws(
    () => validateOrphanPartitionEraseRequest({ identityId: "../../etc", identityIds: [] }),
    /invalid browser partition/,
  );
  assert.throws(
    () => validateOrphanPartitionEraseRequest({ identityId: ORPHAN }),
    /required/,
  );
  assert.throws(() => validateOrphanPartitionEraseRequest(null), /required/);
});
