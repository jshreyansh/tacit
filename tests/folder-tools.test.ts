import test from "node:test";
import assert from "node:assert/strict";
import { folderToolId, parseFolderToolId } from "../src/actions/folderTools";

test("a folder view's id carries its kind, folder and the file to open first", () => {
  assert.equal(folderToolId({ kind: "changes", path: "/code/tacit" }), "changes:/code/tacit");
  assert.equal(folderToolId({ kind: "changes", path: "/code/tacit", focus: "src/a.ts" }), "changes:/code/tacit#src/a.ts");
  assert.deepEqual(parseFolderToolId("changes:/code/tacit#src/a.ts"), { kind: "changes", path: "/code/tacit", focus: "src/a.ts" });
  assert.deepEqual(parseFolderToolId("history:/code/tacit"), { kind: "history", path: "/code/tacit" });
  assert.deepEqual(parseFolderToolId("memory:/code/tacit"), { kind: "memory", path: "/code/tacit" });
});

test("ids that aren't a folder view read as nothing", () => {
  assert.equal(parseFolderToolId("files:/code/tacit"), null);
  assert.equal(parseFolderToolId("changes:"), null);
  assert.equal(parseFolderToolId("nonsense"), null);
});
