import test from "node:test";
import assert from "node:assert/strict";
import { FONT_REGISTRY, downloadableFont } from "../shared/font-registry";

test("only the registry's downloadable fonts are named by file", () => {
  for (const font of FONT_REGISTRY.filter((f) => f.source !== "builtin")) {
    assert.equal(downloadableFont(font.fileName), font);
  }
  // A built-in font has no file; anything else names no font.
  for (const name of ["", "../../.ssh/id_rsa", "/etc/passwd", "JetBrainsMono-Regular.ttf/..", "jetbrainsmono-regular.ttf", null, 3]) {
    assert.equal(downloadableFont(name), null, String(name));
  }
});

test("each downloadable font says where to download it from", () => {
  for (const font of FONT_REGISTRY.filter((f) => f.source !== "builtin")) {
    assert.match(font.url, /^https:\/\/github\.com\//);
    assert.match(font.fileName, /^[A-Za-z0-9-]+\.ttf$/);
  }
});
