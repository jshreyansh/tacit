import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const extensionRoot = path.join(process.cwd(), "browser-extension");

test("connected-browser extension requests only narrow permissions", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
  ) as { permissions?: string[]; host_permissions?: string[] };
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.ok(manifest.permissions?.includes("activeTab"));
  assert.ok(manifest.permissions?.includes("debugger"));
  assert.ok(!manifest.permissions?.includes("cookies"));
  assert.ok(!manifest.permissions?.includes("history"));
  assert.ok(!manifest.host_permissions?.includes("<all_urls>"));
});

test("the extension shares an explicitly active tab and cannot run raw eval actions", () => {
  const popup = fs.readFileSync(path.join(extensionRoot, "popup.js"), "utf8");
  const worker = fs.readFileSync(path.join(extensionRoot, "service-worker.js"), "utf8");
  assert.match(popup, /active:\s*true,\s*currentWindow:\s*true/);
  assert.match(popup, /type:\s*"connect-tab"/);
  assert.doesNotMatch(worker, /case\s+["']eval["']/);
  assert.match(worker, /\/browser-connect\/revoke/);
});

test("packaged Tacit builds include the reviewable unpacked extension", () => {
  const builder = fs.readFileSync(path.join(process.cwd(), "electron-builder.yml"), "utf8");
  assert.match(builder, /from:\s*browser-extension\s+to:\s*browser-extension/);
});
