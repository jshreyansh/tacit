import test from "node:test";
import assert from "node:assert/strict";

import { groupContentMatches, searchFiles } from "../src/toolbar/fileSearchModel.ts";

const folders = [
  { path: "/w/tacit", label: "tacit", files: ["src/toolbar/ChatList.tsx", "src/toolbar/chatListModel.ts", "tests/chat-list-model.test.ts", "README.md"] },
  { path: "/w/site", label: "site", files: ["pages/chat.tsx", "docs/list.md"] },
];

test("every word has to be in the path, in any case", () => {
  const { hits } = searchFiles(folders, "CHAT list");
  assert.deepEqual(hits.map((h) => h.relPath).sort(), ["src/toolbar/ChatList.tsx", "src/toolbar/chatListModel.ts", "tests/chat-list-model.test.ts"]);
});

test("files named for the words come first, across folders", () => {
  const { hits } = searchFiles(folders, "chat");
  assert.equal(hits[0].relPath, "pages/chat.tsx");
  assert.equal(hits[0].folderLabel, "site");
  assert.equal(hits[0].absPath, "/w/site/pages/chat.tsx");
  assert.equal(hits[0].dir, "pages");
});

test("an empty search finds nothing, and the total counts past the limit", () => {
  assert.deepEqual(searchFiles(folders, "  "), { hits: [], total: 0 });
  const many = [{ path: "/w/x", label: "x", files: Array.from({ length: 50 }, (_, i) => `f${i}.ts`) }];
  const { hits, total } = searchFiles(many, "f", 30);
  assert.equal(hits.length, 30);
  assert.equal(total, 50);
});

test("lines found inside files group by file, under their folder, a few per file", () => {
  const { files, lines } = groupContentMatches(
    [{ path: "/w/tacit", label: "tacit" }, { path: "/w/tacit-site", label: "site" }],
    [
      { filePath: "/w/tacit/docs/release.md", line: 9, preview: "after these steps" },
      { filePath: "/w/tacit/docs/release.md", line: 3, preview: "four steps" },
      { filePath: "/w/tacit-site/a.md", line: 1, preview: "steps" },
      { filePath: "/w/tacit/docs/release.md", line: 3, preview: "four steps" },
      { filePath: "/w/tacit/docs/release.md", line: 12, preview: "x" },
      { filePath: "/w/tacit/docs/release.md", line: 20, preview: "y" },
    ],
    3,
  );
  assert.equal(lines, 5);
  assert.deepEqual(files.map((f) => [f.name, f.folderLabel, f.dir, f.lines.map((l) => l.line), f.more]), [
    ["release.md", "tacit", "docs", [3, 9, 12], 1],
    ["a.md", "site", "", [1], 0],
  ]);
});
