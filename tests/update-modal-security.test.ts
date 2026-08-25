import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("update release notes use the shared sanitized markdown renderer", () => {
  const source = fs.readFileSync(
    path.join(root, "src/components/UpdateModal.tsx"),
    "utf8",
  );

  assert.match(source, /import \{ renderMarkdown \}/);
  assert.match(source, /const changelogHtml = notes \? renderMarkdown\(notes\) : ""/);
  assert.doesNotMatch(source, /marked\.parse\(notes/);
});

test("the privileged renderer has a restrictive content security policy", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-eval'/);
});
