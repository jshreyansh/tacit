import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageChromeLocalStorage } from "../electron/browser-site-storage-import";
import { importChromeProfilesAsIdentities } from "../electron/browser-profile-import";

/**
 * A LevelDB directory shaped the way Chrome leaves one: the data files, plus
 * the three that belong to whichever process opened it and must not travel.
 */
function levelDbFixture(
  root: string,
  options: { origins?: string[]; omitCurrent?: boolean; comparator?: string } = {},
): string {
  const dir = path.join(root, "Local Storage", "leveldb");
  fs.mkdirSync(dir, { recursive: true });
  if (!options.omitCurrent) fs.writeFileSync(path.join(dir, "CURRENT"), "MANIFEST-000001\n");
  // A MANIFEST declares its comparator in the first record. The surrounding
  // bytes stand in for the record framing the gate does not need to decode.
  fs.writeFileSync(path.join(dir, "MANIFEST-000001"), Buffer.concat([
    Buffer.from([0x00, 0x01, 0x1a]),
    Buffer.from(options.comparator ?? "leveldb.BytewiseComparator"),
    Buffer.from([0x02, 0x00]),
  ]));
  const origins = options.origins ?? ["https://mail.google.com", "https://drive.google.com"];
  // Real keys are length-prefixed and packed; the bytes on either side stand in
  // for whatever LevelDB puts there, which is what the scanner must stop at.
  const log = Buffer.concat([
    Buffer.from([0x01, 0x00, 0x2a]),
    ...origins.map((origin) => Buffer.concat([
      Buffer.from(`META:${origin}`),
      Buffer.from([0x00, 0x07]),
    ])),
  ]);
  fs.writeFileSync(path.join(dir, "000004.log"), log);
  fs.writeFileSync(path.join(dir, "000003.ldb"), "table-bytes");
  fs.writeFileSync(path.join(dir, "LOCK"), "");
  fs.writeFileSync(path.join(dir, "LOG"), "one browser's diagnostics");
  fs.writeFileSync(path.join(dir, "LOG.old"), "older diagnostics");
  return dir;
}

function scratch(): { profile: string; partition: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-site-storage-test-"));
  const profile = path.join(base, "Profile 1");
  const partition = path.join(base, "Partitions", "identity-identity-abc");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(partition, { recursive: true });
  return { profile, partition, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function stagedNames(partition: string): string[] {
  return fs.readdirSync(path.join(partition, "Local Storage", "leveldb")).sort();
}

test("staging copies LevelDB's data files and leaves the opener's files behind", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    levelDbFixture(profile);
    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "imported");
    assert.deepEqual(stagedNames(partition), [
      "000003.ldb",
      "000004.log",
      "CURRENT",
      "MANIFEST-000001",
    ]);
    // LOCK belongs to whichever process holds the database, and LOG is one
    // browser's history of it. Inheriting either is a bug, not a nicety.
    for (const excluded of ["LOCK", "LOG", "LOG.old"]) {
      assert.equal(stagedNames(partition).includes(excluded), false, excluded);
    }
    assert.equal(result.files, 4);
  } finally {
    cleanup();
  }
});

test("origin count reads META keys and ignores anything that is not an origin", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    levelDbFixture(profile, {
      origins: [
        "https://mail.google.com",
        "https://drive.google.com",
        "https://mail.google.com",
        "chrome-extension://abcdef",
      ],
    });
    const result = stageChromeLocalStorage(profile, partition);

    // Two distinct http(s) origins; the duplicate collapses and the
    // extension scheme is not a site whose storage this describes.
    assert.equal(result.origins, 2);
    assert.match(result.detail ?? "", /2 origins or more/);
  } finally {
    cleanup();
  }
});

test("a profile with no Local Storage is empty rather than failed, and stages nothing", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    const result = stageChromeLocalStorage(profile, partition);
    assert.equal(result.status, "empty");
    assert.equal(result.files, 0);
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
  } finally {
    cleanup();
  }
});

test("a LevelDB with no CURRENT is not a database and is not staged", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    levelDbFixture(profile, { omitCurrent: true });
    const result = stageChromeLocalStorage(profile, partition);

    // CURRENT is the only entry point to a LevelDB. Copying the rest would
    // produce a directory Chromium rejects rather than a working profile.
    assert.equal(result.status, "empty");
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
  } finally {
    cleanup();
  }
});

test("a partition that already holds site storage is refused and left untouched", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    levelDbFixture(profile);
    const existing = path.join(partition, "Local Storage", "leveldb");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "CURRENT"), "MANIFEST-000009\n");

    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /already has site storage/);
    // Whatever the user signed into inside Tacit survives verbatim.
    assert.deepEqual(stagedNames(partition), ["CURRENT"]);
    assert.equal(fs.readFileSync(path.join(existing, "CURRENT"), "utf8"), "MANIFEST-000009\n");
  } finally {
    cleanup();
  }
});

test("a symlink in the source is not followed into the partition", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    const dir = levelDbFixture(profile);
    const secret = path.join(path.dirname(profile), "elsewhere.txt");
    fs.writeFileSync(secret, "not database state");
    fs.symlinkSync(secret, path.join(dir, "000009.ldb"));

    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "imported");
    assert.equal(stagedNames(partition).includes("000009.ldb"), false);
  } finally {
    cleanup();
  }
});

test("a database over the size ceiling is refused before anything is copied", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    const dir = levelDbFixture(profile);
    // Sparse: the size is what the ceiling reads, without writing the bytes.
    const handle = fs.openSync(path.join(dir, "000010.ldb"), "w");
    fs.ftruncateSync(handle, 600 * 1024 * 1024);
    fs.closeSync(handle);

    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /too large/);
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
  } finally {
    cleanup();
  }
});

test("a copy that fails part way leaves no half-written database behind", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    const dir = levelDbFixture(profile);
    // Readable at listing time, unreadable at copy time: the shape of a file
    // that changes underneath an import.
    fs.chmodSync(path.join(dir, "000003.ldb"), 0o000);

    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "failed");
    // Half a LevelDB is not a smaller LevelDB — CURRENT can name a MANIFEST
    // that never arrived. Chromium handles an absent database; it refuses a
    // truncated one.
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
    fs.chmodSync(path.join(dir, "000003.ldb"), 0o600);
  } finally {
    cleanup();
  }
});

test("site storage is staged before the session opens the partition", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-order-test-"));
  try {
    fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Personal" } } },
    }));
    fs.mkdirSync(path.join(root, "Default"), { recursive: true });
    fs.writeFileSync(path.join(root, "Default", "Preferences"), "{}");
    fs.writeFileSync(path.join(root, "Default", "Cookies"), "fixture");

    const order: string[] = [];
    const result = await importChromeProfilesAsIdentities(["Default"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => "00000000-0000-4000-8000-000000000001",
      readCookieRows: async () => ({ schemaVersion: 24, rows: [] }),
      stageSiteStorage: () => {
        order.push("stage");
        return { status: "imported", origins: 3, files: 4, bytes: 2048 };
      },
      fromPartition: () => {
        order.push("session");
        return {
          cookies: { set: async () => {}, remove: async () => {}, flushStore: async () => {} },
          flushStorageData: async () => {},
          clearStorageData: async () => {},
        };
      },
    });

    // Chromium opens a partition's Local Storage lazily and holds it for the
    // life of the process, so this ordering is the feature working at all.
    assert.deepEqual(order, ["stage", "session"]);
    const entry = result.results[0];
    assert.equal(entry?.status, "completed");
    const siteStorage = entry?.status === "completed"
      ? entry.identity.provenance.categories.siteStorage
      : null;
    assert.equal(siteStorage?.status, "imported");
    assert.equal(siteStorage?.count, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("site storage that cannot be staged does not fail the cookie import", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-degrade-test-"));
  try {
    fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Personal" } } },
    }));
    fs.mkdirSync(path.join(root, "Default"), { recursive: true });
    fs.writeFileSync(path.join(root, "Default", "Preferences"), "{}");
    fs.writeFileSync(path.join(root, "Default", "Cookies"), "fixture");

    const cleared: string[] = [];
    const result = await importChromeProfilesAsIdentities(["Default"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => "00000000-0000-4000-8000-000000000001",
      readCookieRows: async () => ({
        schemaVersion: 24,
        rows: [{
          host_key: ".example.com", name: "session", path: "/", value: "kept",
          encrypted_value_hex: "", expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1,
        }],
      }),
      stageSiteStorage: () => {
        throw new Error("disk went away");
      },
      fromPartition: () => ({
        cookies: { set: async () => {}, remove: async () => {}, flushStore: async () => {} },
        flushStorageData: async () => {},
        clearStorageData: async () => { cleared.push("cleared"); },
      }),
    });

    // Site storage is an improvement on top of cookies, not a precondition for
    // them. Losing it must not discard a working set of logins.
    const entry = result.results[0];
    assert.equal(entry?.status, "completed");
    assert.deepEqual(cleared, []);
    const categories = entry?.status === "completed" ? entry.identity.provenance.categories : null;
    assert.equal(categories?.siteStorage.status, "failed");
    assert.equal(categories?.cookies.status, "imported");
    assert.match(categories?.siteStorage.detail ?? "", /could not be staged/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a database with a different key order is refused rather than staged", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    // `idb_cmp1` is IndexedDB's comparator, and IndexedDB sits one directory
    // away from Local Storage. Copying one into a partition and letting
    // Chromium open it is the case that silently wipes a database, so a source
    // that declares it is refused here instead of moved.
    levelDbFixture(profile, { comparator: "idb_cmp1" });

    const result = stageChromeLocalStorage(profile, partition);

    assert.equal(result.status, "unsupported");
    assert.match(result.detail ?? "", /key order/);
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
  } finally {
    cleanup();
  }
});

test("an unreadable format is reported unsupported, not imported", () => {
  const { profile, partition, cleanup } = scratch();
  try {
    const dir = levelDbFixture(profile);
    fs.writeFileSync(path.join(dir, "MANIFEST-000001"), "no comparator here");

    const result = stageChromeLocalStorage(profile, partition);

    // The gate is about the truth of the record. An unopenable database would
    // leave Chromium with empty Local Storage anyway; what must not happen is
    // provenance claiming `imported` for a profile that is signed out.
    assert.equal(result.status, "unsupported");
    assert.equal(fs.existsSync(path.join(partition, "Local Storage")), false);
  } finally {
    cleanup();
  }
});
