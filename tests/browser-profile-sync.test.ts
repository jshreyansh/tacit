import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveMacChromiumKey } from "../electron/browser-profile-import";
import { syncChromeProfiles } from "../electron/browser-profile-sync";
import { readChromeSyncRequests } from "../shared/browser-profile-sync";
import { partitionForBrowserIdentity } from "../shared/browser-profile-import";

const PASSWORD = "synthetic-safe-storage-secret";

function encryptV10Cookie(host: string, value: string): string {
  const cipher = createCipheriv("aes-128-cbc", deriveMacChromiumKey(PASSWORD), Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]).toString("hex");
}

function cookieRow(host: string, name: string, value: string): string {
  return `INSERT INTO cookies VALUES('${host}', '${name}', '/', '', X'${encryptV10Cookie(host, value)}', 0, 1, 1, -1);`;
}

/** A Chrome directory with real cookie databases, one per profile. */
function chromeFixture(profiles: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-sync-test-"));
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
    profile: { info_cache: Object.fromEntries(Object.keys(profiles).map((id) => [id, { name: id }])) },
  }));
  for (const [profileId, rows] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(root, profileId), { recursive: true });
    fs.writeFileSync(path.join(root, profileId, "Preferences"), "{}");
    execFileSync("/usr/bin/sqlite3", [path.join(root, profileId, "Cookies"), [
      "PRAGMA journal_mode=DELETE;",
      "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);",
      "INSERT INTO meta(key, value) VALUES('version', '24');",
      "CREATE TABLE cookies(host_key TEXT, name TEXT, path TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);",
      ...rows,
    ].join("\n")]);
  }
  return root;
}

function partitions() {
  const written = new Map<string, Array<{ name: string; value: string }>>();
  return {
    written,
    fromPartition: (partitionName: string) => {
      const list = written.get(partitionName) ?? [];
      written.set(partitionName, list);
      return {
        cookies: {
          set: async (cookie: { name?: string; value?: string }) => { list.push({ name: cookie.name ?? "", value: cookie.value ?? "" }); },
          remove: async () => {},
        },
        flushStorageData: async () => {},
      };
    },
  };
}

test("a sync request names imported profiles and the Chrome profile each came from; nothing else gets through", () => {
  assert.deepEqual(
    readChromeSyncRequests({ profiles: [{ identityId: "identity-a", sourceProfileId: "Default" }, { identityId: "identity-b", sourceProfileId: "Profile 12" }] }),
    [{ identityId: "identity-a", sourceProfileId: "Default" }, { identityId: "identity-b", sourceProfileId: "Profile 12" }],
  );
  for (const bad of [
    null,
    { profiles: [] },
    { profiles: [{ identityId: "identity-a", sourceProfileId: "../Default" }] },
    { profiles: [{ identityId: "identity-a", sourceProfileId: "Profile 1/../../x" }] },
    { profiles: [{ identityId: "../identity", sourceProfileId: "Default" }] },
    { profiles: [{ identityId: "identity-a", sourceProfileId: "Default" }, { identityId: "identity-a", sourceProfileId: "Profile 2" }] },
  ]) {
    assert.throws(() => readChromeSyncRequests(bad), undefined, JSON.stringify(bad));
  }
});

test("a sync copies each profile's cookies again, asks the keychain once, and says which profile it couldn't find", async () => {
  const root = chromeFixture({
    Default: [cookieRow(".google.com", "SID", "fresh-personal")],
    "Profile 2": [cookieRow(".google.com", "SID", "fresh-work"), cookieRow(".github.com", "user_session", "gh")],
  });
  const target = partitions();
  let keychainReads = 0;
  try {
    const { results } = await syncChromeProfiles(
      [
        { identityId: "identity-personal", sourceProfileId: "Default" },
        { identityId: "identity-work", sourceProfileId: "Profile 2" },
        { identityId: "identity-gone", sourceProfileId: "Profile 9" },
      ],
      {
        chromeRoot: root,
        isChromeRunning: async () => true,
        readChromeSafeStoragePassword: async () => { keychainReads += 1; return PASSWORD; },
        fromPartition: target.fromPartition,
      },
    );
    assert.deepEqual(results.map((r) => [r.identityId, r.status]), [
      ["identity-personal", "synced"],
      ["identity-work", "synced"],
      ["identity-gone", "failed"],
    ]);
    assert.equal(results[2]!.status === "failed" && results[2]!.reason, "profile_missing");
    assert.equal(keychainReads, 1);
    assert.deepEqual(target.written.get(partitionForBrowserIdentity("identity-personal")), [{ name: "SID", value: "fresh-personal" }]);
    assert.equal(target.written.get(partitionForBrowserIdentity("identity-work"))?.length, 2);
    // Values never come back to the renderer.
    assert.equal(JSON.stringify(results).includes("fresh-"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("when macOS refuses the keychain, every profile says so and none is half-synced", async () => {
  const root = chromeFixture({ Default: [cookieRow(".google.com", "SID", "x")], "Profile 2": [cookieRow(".google.com", "SID", "y")] });
  const target = partitions();
  try {
    const { results } = await syncChromeProfiles(
      [{ identityId: "identity-a", sourceProfileId: "Default" }, { identityId: "identity-b", sourceProfileId: "Profile 2" }],
      {
        chromeRoot: root,
        isChromeRunning: async () => false,
        readChromeSafeStoragePassword: async () => { throw new Error("macOS did not allow access to Chrome Safe Storage, so signed-in sessions were not imported"); },
        fromPartition: target.fromPartition,
      },
    );
    assert.deepEqual(results.map((r) => r.status === "failed" && r.reason), ["keychain_denied", "keychain_denied"]);
    assert.equal([...target.written.values()].flat().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a sync while Chrome is mid-write reads the last committed cookies, not the half-written ones", async () => {
  const root = chromeFixture({ Default: [cookieRow(".google.com", "SID", "committed")] });
  const db = path.join(root, "Default", "Cookies");
  // Chrome keeps its cookie database in rollback-journal mode. Hold a write
  // open with a tiny page cache, so uncommitted pages reach the database file
  // and the journal holds the originals: what a copy of a running Chrome sees.
  const writer = spawn("/usr/bin/sqlite3", [db], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    const filler = "x".repeat(2000);
    writer.stdin.write(`PRAGMA cache_size=1;\nPRAGMA cache_spill=1;\nBEGIN;\nUPDATE cookies SET encrypted_value = X'${encryptV10Cookie(".google.com", "uncommitted")}';\n`);
    for (let i = 0; i < 400; i += 1) {
      writer.stdin.write(`INSERT INTO cookies VALUES('.filler${i}.example', 'f', '/', '${filler}', X'', 0, 1, 1, -1);\n`);
    }
    const journal = `${db}-journal`;
    const deadline = Date.now() + 10_000;
    while (!(fs.existsSync(journal) && fs.statSync(journal).size > 0 && fs.statSync(db).size > 64 * 1024)) {
      if (Date.now() > deadline) throw new Error("the writer never spilled to disk");
      await new Promise((r) => setTimeout(r, 50));
    }

    const target = partitions();
    const { results } = await syncChromeProfiles([{ identityId: "identity-a", sourceProfileId: "Default" }], {
      chromeRoot: root,
      isChromeRunning: async () => true,
      readChromeSafeStoragePassword: async () => PASSWORD,
      fromPartition: target.fromPartition,
    });
    assert.equal(results[0]!.status, "synced", JSON.stringify(results));
    assert.deepEqual(target.written.get(partitionForBrowserIdentity("identity-a")), [{ name: "SID", value: "committed" }]);
    // Chrome's own files are untouched: its write is still open.
    assert.ok(fs.existsSync(journal));
  } finally {
    writer.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
