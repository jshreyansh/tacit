import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromiumTimestampToUnixSeconds,
  decryptChromiumCookie,
  deriveMacChromiumKey,
  discoverChromeProfiles,
  importChromeProfileCookies,
  importChromeProfilesAsIdentities,
} from "../electron/browser-profile-import";
import { isValidBrowserIdentityId, partitionForBrowserIdentity } from "../shared/browser-profile-import";
import { resolveIdentityClearPartition, validateChromeProfileImportRequest } from "../electron/browser-profile-ipc";

function chromeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-profile-test-"));
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: "Personal", user_name: "person@example.com", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_1" },
        "Profile 2": { name: "Work" },
        "../escape": { name: "Unsafe" },
      },
    },
  }));
  for (const profileId of ["Default", "Profile 2"]) {
    fs.mkdirSync(path.join(root, profileId), { recursive: true });
    fs.writeFileSync(path.join(root, profileId, "Preferences"), "{}");
    fs.writeFileSync(path.join(root, profileId, "Cookies"), "fixture");
  }
  return root;
}

function encryptV10Cookie(password: string, host: string, value: string): Buffer {
  const key = deriveMacChromiumKey(password);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([
    createHash("sha256").update(host).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plaintext),
    cipher.final(),
  ]);
}

function writeRealCookieDatabase(
  databasePath: string,
  encryptedCookie: Buffer,
): void {
  fs.rmSync(databasePath, { force: true });
  execFileSync("/usr/bin/sqlite3", [databasePath, [
    "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);",
    "INSERT INTO meta(key, value) VALUES('version', '24');",
    "CREATE TABLE cookies(host_key TEXT, name TEXT, path TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);",
    `INSERT INTO cookies VALUES('.example.com', 'session', '/', '', X'${encryptedCookie.toString("hex")}', 0, 1, 1, -1);`,
  ].join("\n")]);
}

test("Chrome profile discovery exposes names but rejects unsafe profile paths", () => {
  const root = chromeFixture();
  try {
    assert.deepEqual(discoverChromeProfiles(root), [
      { source: "chrome", profileId: "Default", name: "Personal", accountHint: "person@example.com", avatarHint: "chrome://theme/IDR_PROFILE_AVATAR_1" },
      { source: "chrome", profileId: "Profile 2", name: "Work" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Chromium v10 cookies decrypt with host authentication", () => {
  const host = ".chatgpt.com";
  const value = "signed-in-session";
  const key = deriveMacChromiumKey("safe-storage-secret");
  const encrypted = encryptV10Cookie("safe-storage-secret", host, value);
  assert.equal(decryptChromiumCookie(encrypted.toString("hex"), key, host, 24), value);
  assert.equal(
    decryptChromiumCookie(Buffer.from("v20not-portable").toString("hex"), key, host, 24),
    null,
  );
});

test("Chrome session import reads and decrypts a real SQLite cookie database", async () => {
  const root = chromeFixture();
  const password = "synthetic-safe-storage-secret";
  const privateValue = "synthetic-private-value";
  const databasePath = path.join(root, "Default", "Cookies");
  const written: Array<Record<string, unknown>> = [];
  const removed: Array<{ url: string; name: string }> = [];
  try {
    writeRealCookieDatabase(
      databasePath,
      encryptV10Cookie(password, ".example.com", privateValue),
    );
    const result = await importChromeProfileCookies(
      "Default",
      {
        set: async (cookie) => { written.push(cookie); },
        remove: async (url, name) => { removed.push({ url, name }); },
      },
      {
        chromeRoot: root,
        isChromeRunning: async () => false,
        readChromeSafeStoragePassword: async () => password,
      },
    );

    assert.equal(result.importedCookies, 1);
    assert.equal(result.failedCookies, 0);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(written[0]?.url, "https://example.com/");
    assert.equal(written[0]?.value, privateValue);
    assert.equal(written[0]?.domain, ".example.com");
    assert.deepEqual(removed, [{ url: "https://example.com/", name: "session" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome session import writes only counts back and refuses a running browser", async () => {
  const root = chromeFixture();
  const written: Array<Record<string, unknown>> = [];
  const removed: Array<{ url: string; name: string }> = [];
  try {
    const result = await importChromeProfileCookies(
      "Default",
      {
        set: async (cookie) => { written.push(cookie); },
        remove: async (url, name) => { removed.push({ url, name }); },
      },
      {
        chromeRoot: root,
        isChromeRunning: async () => false,
        readCookieRows: async () => ({
          schemaVersion: 24,
          rows: [{
            host_key: ".example.com",
            name: "session",
            path: "/",
            value: "private-value",
            encrypted_value_hex: "",
            expires_utc: 0,
            is_secure: 1,
            is_httponly: 1,
            samesite: -1,
          }, {
            host_key: "chatgpt.com",
            name: "__Host-session",
            path: "/",
            value: "host-only-private-value",
            encrypted_value_hex: "",
            expires_utc: 0,
            is_secure: 1,
            is_httponly: 1,
            samesite: 1,
          }],
        }),
      },
    );
    assert.equal(result.importedCookies, 2);
    assert.equal(result.skippedCookies, 0);
    assert.equal(JSON.stringify(result).includes("private-value"), false);
    assert.equal(written[0]?.url, "https://example.com/");
    assert.equal(written[0]?.value, "private-value");
    assert.equal(written[0]?.domain, ".example.com");
    assert.equal(written[1]?.url, "https://chatgpt.com/");
    assert.equal(written[1]?.domain, undefined);
    assert.equal(written[1]?.value, "host-only-private-value");
    assert.deepEqual(removed, [
      { url: "https://example.com/", name: "session" },
      { url: "https://chatgpt.com/", name: "__Host-session" },
    ]);

    await assert.rejects(
      importChromeProfileCookies(
        "Default",
        { set: async () => {}, remove: async () => {} },
        { chromeRoot: root, isChromeRunning: async () => true },
      ),
      /Quit Google Chrome completely/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chromium timestamps convert from the 1601 epoch", () => {
  assert.equal(chromiumTimestampToUnixSeconds(0), undefined);
  assert.equal(chromiumTimestampToUnixSeconds(11_644_473_600_000_000), 0);
  assert.equal(chromiumTimestampToUnixSeconds(11_644_473_601_000_000), 1);
});

test("identity partitions use the shared strict id rule", () => {
  const id = "identity-00000000-0000-4000-8000-000000000001";
  assert.equal(isValidBrowserIdentityId(id), true);
  assert.equal(partitionForBrowserIdentity(id), `persist:identity-${id}`);
  assert.equal(isValidBrowserIdentityId("identity-../../Default"), false);
  assert.throws(() => partitionForBrowserIdentity("identity-../../Default"));
});

test("IPC validation keeps identity resolution in main and permits explicit Default deletion", () => {
  assert.equal(resolveIdentityClearPartition("identity-default"), "persist:identity-identity-default");
  assert.equal(resolveIdentityClearPartition("identity-safe-1"), "persist:identity-identity-safe-1");
  assert.throws(() => resolveIdentityClearPartition("persist:identity-default"), /invalid/i);
  assert.deepEqual(validateChromeProfileImportRequest({
    profileIds: ["Default"], existingIdentityNames: ["Default"],
  }), { profileIds: ["Default"], existingIdentityNames: ["Default"] });
  assert.throws(() => validateChromeProfileImportRequest({ profileIds: [], existingIdentityNames: [] }));
  assert.throws(() => validateChromeProfileImportRequest({ profileIds: ["Default"], existingIdentityNames: [42] }));
  assert.throws(() => validateChromeProfileImportRequest({ profileIds: Array(101).fill("Default"), existingIdentityNames: [] }));
});

test("all app-bound cookies create an identity with unsupported cookie status", async () => {
  const root = chromeFixture();
  let keychainRead = false;
  try {
    const result = await importChromeProfilesAsIdentities(["Default"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => "00000000-0000-4000-8000-000000000001",
      readChromeSafeStoragePassword: async () => { keychainRead = true; throw new Error("must not read"); },
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "session", path: "/", value: "", encrypted_value_hex: Buffer.from("v20app-bound").toString("hex"), expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: () => ({ cookies: { set: async () => {}, remove: async () => {} }, flushStorageData: async () => {}, clearStorageData: async () => { throw new Error("must not clear"); } }),
    });
    assert.equal(keychainRead, false);
    assert.equal(result.results[0]?.status, "completed");
    assert.equal(result.results[0]?.status === "completed" ? result.results[0].identity.provenance.categories.cookies.status : "", "unsupported");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("all expired cookies create an identity with empty cookie status", async () => {
  const root = chromeFixture();
  let keychainRead = false;
  try {
    const result = await importChromeProfilesAsIdentities(["Default"], [], {
      chromeRoot: root, isChromeRunning: async () => false,
      createIdentityId: () => "00000000-0000-4000-8000-000000000001",
      readChromeSafeStoragePassword: async () => { keychainRead = true; throw new Error("must not read"); },
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "old", path: "/", value: "", encrypted_value_hex: Buffer.from("v10expired").toString("hex"), expires_utc: 11_644_473_601_000_000, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: () => ({ cookies: { set: async () => {}, remove: async () => {} }, flushStorageData: async () => {}, clearStorageData: async () => { throw new Error("must not clear"); } }),
    });
    assert.equal(result.results[0]?.status, "completed");
    assert.equal(keychainRead, false);
    assert.equal(result.results[0]?.status === "completed" ? result.results[0].identity.provenance.categories.cookies.status : "", "empty");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("batch import creates isolated identities, disambiguates names, and reports unsupported categories", async () => {
  const root = chromeFixture();
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: {
    Default: { name: "Work", user_name: "person@example.com", avatar_icon: "chrome://theme/avatar" },
    "Profile 2": { name: "Work" },
  } } }));
  const partitions = new Map<string, { values: string[]; cleared: boolean }>();
  const uuids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  try {
    const result = await importChromeProfilesAsIdentities(["Default", "Profile 2"], ["Default", "Work"], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => uuids.shift()!,
      now: () => 1234,
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "session", path: "/", value: "secret", encrypted_value_hex: "", expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: (partitionName) => {
        assert.notEqual(partitionName, "persist:identity-identity-default");
        const state = { values: [] as string[], cleared: false };
        partitions.set(partitionName, state);
        return {
          cookies: { set: async (cookie) => { state.values.push(cookie.value); }, remove: async () => {}, flushStore: async () => {} },
          flushStorageData: async () => {},
          clearStorageData: async () => { state.cleared = true; state.values = []; },
        };
      },
    });
    assert.equal(result.results.length, 2);
    assert.equal(partitions.size, 2);
    assert.deepEqual([...partitions.values()].map((state) => state.values), [["secret"], ["secret"]]);
    const completed = result.results.filter((entry) => entry.status === "completed");
    assert.deepEqual(completed.map((entry) => entry.status === "completed" && entry.identity.name), ["Work 2", "Work 3"]);
    assert.equal(completed[0]?.status === "completed" && completed[0].identity.provenance.categories.savedPasswords.status, "unsupported");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch import rolls back a failed identity while preserving another success", async () => {
  const root = chromeFixture();
  let partitionNumber = 0;
  const cleared: string[] = [];
  try {
    const result = await importChromeProfilesAsIdentities(["Default", "Profile 2"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => `00000000-0000-4000-8000-00000000000${++partitionNumber}`,
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "session", path: "/", value: "private", encrypted_value_hex: "", expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: (partitionName) => ({
        cookies: { set: async () => { if (partitionName.endsWith("2")) throw new Error("write failed"); }, remove: async () => {}, flushStore: async () => {} },
        flushStorageData: async () => {},
        clearStorageData: async () => { cleared.push(partitionName); },
      }),
    });
    assert.deepEqual(result.results.map((entry) => entry.status), ["completed", "failed"]);
    assert.equal(cleared.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed profiles do not reserve a display name", async () => {
  const root = chromeFixture();
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: {
    Default: { name: "Work" }, "Profile 2": { name: "Work" },
  } } }));
  let partitionNumber = 0;
  try {
    const result = await importChromeProfilesAsIdentities(["Default", "Profile 2"], [], {
      chromeRoot: root, isChromeRunning: async () => false,
      createIdentityId: () => `00000000-0000-4000-8000-00000000000${++partitionNumber}`,
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "session", path: "/", value: "private", encrypted_value_hex: "", expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: (partitionName) => ({
        cookies: { set: async () => { if (partitionName.endsWith("1")) throw new Error("write failed"); }, remove: async () => {} },
        flushStorageData: async () => {}, clearStorageData: async () => {},
      }),
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[1]?.status === "completed" ? result.results[1].identity.name : "", "Work");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("batch import does not expose snapshot filesystem paths in failure results", async () => {
  const root = chromeFixture();
  try {
    const result = await importChromeProfilesAsIdentities(["Default"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => "00000000-0000-4000-8000-000000000001",
      readCookieRows: async (cookieDbPath) => {
        throw new Error(`could not open snapshot at ${cookieDbPath}`);
      },
      fromPartition: () => ({
        cookies: { set: async () => {}, remove: async () => {} },
        flushStorageData: async () => {},
        clearStorageData: async () => {},
      }),
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.status === "failed" ? result.results[0].errorCode : "", "profile_import_failed");
    assert.equal(result.results[0]?.status === "failed" ? result.results[0].cleanup : "", "completed");
    assert.equal(JSON.stringify(result).includes("tacit-chrome-import-"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rollback failure stays profile-scoped and does not discard other batch results", async () => {
  const root = chromeFixture();
  let partitionNumber = 0;
  try {
    const result = await importChromeProfilesAsIdentities(["Default", "Profile 2"], [], {
      chromeRoot: root,
      isChromeRunning: async () => false,
      createIdentityId: () => `00000000-0000-4000-8000-00000000000${++partitionNumber}`,
      readCookieRows: async () => ({ schemaVersion: 24, rows: [{ host_key: ".example.com", name: "session", path: "/", value: "private", encrypted_value_hex: "", expires_utc: 0, is_secure: 1, is_httponly: 1, samesite: -1 }] }),
      fromPartition: (partitionName) => ({
        cookies: { set: async () => { if (partitionName.endsWith("1")) throw new Error("write failed"); }, remove: async () => {} },
        flushStorageData: async () => {},
        clearStorageData: async () => { if (partitionName.endsWith("1")) throw new Error("clear failed"); },
      }),
    });
    assert.deepEqual(result.results.map((entry) => entry.status), ["failed", "completed"]);
    assert.match(result.results[0]?.status === "failed" ? result.results[0].error : "", /rollback/i);
    assert.equal(result.results[0]?.status === "failed" ? result.results[0].errorCode : "", "cleanup_failed");
    assert.equal(result.results[0]?.status === "failed" ? result.results[0].cleanup : "", "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
