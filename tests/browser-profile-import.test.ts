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
} from "../electron/browser-profile-import";

function chromeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-profile-test-"));
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: "Personal" },
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
      { source: "chrome", profileId: "Default", name: "Personal" },
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
