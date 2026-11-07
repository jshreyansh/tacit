import test from "node:test";
import assert from "node:assert/strict";

import { orderEditors } from "../shared/editors.ts";
import { firstChangedLine, isDeletedInDiff } from "../src/utils/diffParser.ts";

const editors = [
  { id: "vscode", name: "VS Code" },
  { id: "cursor", name: "Cursor" },
  { id: "zed", name: "Zed" },
];

test("the chosen default comes first and the rest keep their order", () => {
  assert.deepEqual(orderEditors(editors, "zed").map((e) => e.id), ["zed", "vscode", "cursor"]);
});

test("with no default, or one since uninstalled, the first found is the default", () => {
  assert.deepEqual(orderEditors(editors, null).map((e) => e.id), ["vscode", "cursor", "zed"]);
  assert.deepEqual(orderEditors(editors, "sublime").map((e) => e.id), ["vscode", "cursor", "zed"]);
});

test("finds the first added line, counting the context before it", () => {
  const hunk = [
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,4 +10,5 @@ function a() {",
    " one",
    " two",
    "+three",
    " four",
  ].join("\n");
  assert.equal(firstChangedLine([hunk]), 12);
});

test("a removed line counts as a change, at the place it was", () => {
  assert.equal(firstChangedLine(["@@ -5,3 +5,2 @@\n keep\n-gone\n keep"]), 6);
});

test("the file headers aren't taken for changes", () => {
  assert.equal(firstChangedLine(["--- a/a.ts\n+++ b/a.ts"]), undefined);
  assert.equal(firstChangedLine([]), undefined);
});

test("a new file opens at its first line, and removing everything stays above zero", () => {
  assert.equal(firstChangedLine(["new file mode 100644\n@@ -0,0 +1,2 @@\n+a\n+b"]), 1);
  assert.equal(firstChangedLine(["@@ -1,2 +0,0 @@\n-a\n-b"]), 1);
});

test("the no-newline marker doesn't move the count", () => {
  assert.equal(firstChangedLine(["@@ -1,2 +1,3 @@\n a\n\\ No newline at end of file\n+b"]), 2);
});

test("recognises a deleted file", () => {
  assert.equal(isDeletedInDiff(["deleted file mode 100644\nindex 1..0\n--- a/a.ts\n+++ /dev/null"]), true);
  assert.equal(isDeletedInDiff(["@@ -1 +1 @@\n-deleted file mode \n+x"]), false);
});
