import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveMacChromiumKey } from "../electron/browser-profile-import";
import { syncChromeProfiles } from "../electron/browser-profile-sync";
import { ChromeLoginWatch } from "../electron/chrome-login-watch";
import { readChromeSyncRequests } from "../shared/browser-profile-sync";
import { partitionForBrowserIdentity } from "../shared/browser-profile-import";

const PASSWORD = "synthetic-safe-storage-secret";

function encryptV10Cookie(host: string, value: string): string {
  const cipher = createCipheriv("aes-128-cbc", deriveMacChromiumKey(PASSWORD), Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]).toString("hex");
}

function cookieRow(host: string, name: string, value: string): string {
  return `INSERT INTO cookies(host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, samesite) VALUES('${host}', '${name}', '/', '', X'${encryptV10Cookie(host, value)}', 0, 1, 1, -1);`;
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
      "CREATE TABLE cookies(host_key TEXT, name TEXT, path TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, creation_utc INTEGER DEFAULT (abs(random())));",
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
      writer.stdin.write(`INSERT INTO cookies(host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly, samesite) VALUES('.filler${i}.example', 'f', '/', '${filler}', X'', 0, 1, 1, -1);\n`);
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

test("Chrome's login watcher: a new login syncs that profile; rotating cookies and other profiles don't", async () => {
  const root = chromeFixture({ "Profile 4": [], "Profile 9": [] });
  const rows: Record<string, string> = {
    "Profile 4": ".google.com|SID|100\n.google.com|SIDCC|200\n.google.com|NID|300\n.github.com|_gh_sess|400",
    "Profile 9": ".google.com|SID|500",
  };
  const changes = new Map<string, (filename: string | null) => void>();
  const logins: Array<[string, string[]]> = [];
  const watch = new ChromeLoginWatch({
    chromeRoot: root,
    readLoginRows: async (db) => rows[path.basename(path.dirname(db))]!,
    watch: (dir, onChange) => { changes.set(path.basename(dir), onChange); return { close: () => changes.delete(path.basename(dir)) }; },
    onNewLogin: (source, identityIds) => logins.push([source, identityIds]),
  });
  try {
    watch.setSources([
      { identityId: "identity-a", sourceProfileId: "Profile 4" },
      { identityId: "identity-b", sourceProfileId: "Profile 4" },
      { identityId: "identity-c", sourceProfileId: "Profile 9" },
    ]);
    await watch.check("Profile 4"); await watch.check("Profile 9");
    assert.deepEqual([...changes.keys()].sort(), ["Profile 4", "Profile 9"]);
    assert.deepEqual(logins, [], "watching starts quietly");

    // Google rotates SIDCC and GitHub its session cookie: not a login.
    rows["Profile 4"] = ".google.com|SID|100\n.google.com|SIDCC|201\n.google.com|NID|300\n.github.com|_gh_sess|401";
    await watch.check("Profile 4");
    assert.deepEqual(logins, []);

    // A new Google sign-in makes a new SID.
    rows["Profile 4"] = ".google.com|SID|600\n.google.com|SIDCC|601\n.google.com|NID|300\n.github.com|_gh_sess|401";
    await watch.check("Profile 4");
    assert.deepEqual(logins, [["Profile 4", ["identity-a", "identity-b"]]]);

    // Signing in to a site adds its login cookie.
    rows["Profile 9"] = ".google.com|SID|500\n.github.com|user_session|700";
    await watch.check("Profile 9");
    assert.deepEqual(logins.at(-1), ["Profile 9", ["identity-c"]]);

    // A profile no longer imported stops being watched.
    watch.setSources([{ identityId: "identity-c", sourceProfileId: "Profile 9" }]);
    assert.deepEqual([...changes.keys()], ["Profile 9"]);
  } finally {
    watch.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome's login watcher reads a real cookie database, names and times only", async () => {
  const root = chromeFixture({ Default: [cookieRow(".google.com", "SID", "secret-value")] });
  const logins: string[] = [];
  const watch = new ChromeLoginWatch({ chromeRoot: root, watch: () => ({ close: () => {} }), onNewLogin: (source) => logins.push(source) });
  try {
    watch.setSources([{ identityId: "identity-a", sourceProfileId: "Default" }]);
    await watch.check("Default");
    execFileSync("/usr/bin/sqlite3", [path.join(root, "Default", "Cookies"), cookieRow(".github.com", "user_session", "x")]);
    await watch.check("Default");
    assert.deepEqual(logins, ["Default"]);
  } finally {
    watch.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
