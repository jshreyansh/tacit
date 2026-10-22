import test from "node:test";
import assert from "node:assert/strict";

import {
  entryPaths,
  folderKeyFor,
  folderPathFor,
  loadedPaths,
  onlyChildFolder,
  unloadedFolders,
  withFolderListed,
  withoutFolder,
} from "../src/stores/folderListing.ts";

test("a folder's entries become tree paths, folders with a trailing slash", () => {
  assert.deepEqual(
    entryPaths("src/", [
      { name: "lib", isDirectory: true },
      { name: "main.ts", isDirectory: false },
    ]),
    ["src/lib/", "src/main.ts"],
  );
  assert.deepEqual(entryPaths("", [{ name: "README.md", isDirectory: false }]), ["README.md"]);
});

test("the tree shows every loaded folder's entries", () => {
  assert.deepEqual(loadedPaths({ "": ["src/", "a.txt"], "src/": ["src/x.ts"] }).sort(), ["a.txt", "src/", "src/x.ts"]);
});

test("re-listing a folder drops loaded folders under it that are gone, with everything beneath", () => {
  const folders = {
    "": ["src/", "old/"],
    "src/": ["src/x.ts"],
    "old/": ["old/deep/"],
    "old/deep/": ["old/deep/y.ts"],
    "older/": ["older/z.ts"],
  };
  const { folders: next, dropped } = withFolderListed(folders, "", ["src/", "older/"]);
  assert.deepEqual(dropped.sort(), ["old/", "old/deep/"]);
  assert.deepEqual(Object.keys(next).sort(), ["", "older/", "src/"]);
  assert.deepEqual(next[""], ["src/", "older/"]);
});

test("a folder that is still there keeps its loaded contents when its parent re-lists", () => {
  const { folders, dropped } = withFolderListed({ "": ["a/"], "a/": ["a/b/"], "a/b/": ["a/b/c.txt"] }, "a/", ["a/b/", "a/new.txt"]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(folders["a/b/"], ["a/b/c.txt"]);
});

test("dropping a folder drops everything loaded beneath it, and nothing beside it", () => {
  const { folders, dropped } = withoutFolder({ "": ["a/", "ab/"], "a/": [], "a/b/": [], "ab/": [] }, "a/");
  assert.deepEqual(dropped.sort(), ["a/", "a/b/"]);
  assert.deepEqual(Object.keys(folders).sort(), ["", "ab/"]);
});

test("a folder whose only entry is a folder loads that one too, but a chain can't run forever", () => {
  assert.equal(onlyChildFolder("src/", ["src/main/"]), "src/main/");
  assert.equal(onlyChildFolder("src/", ["src/main.ts"]), null);
  assert.equal(onlyChildFolder("src/", ["src/a/", "src/b/"]), null);
  const deep = `${"a/".repeat(40)}`;
  assert.equal(onlyChildFolder(deep, [`${deep}a/`]), null);
});

test("listed folders not loaded and not unreadable are the ones to load when opened", () => {
  assert.deepEqual(
    unloadedFolders(["src/", "Library/", "docs/", "a.txt"], { "": [], "src/": [] }, { "Library/": "EPERM" }),
    ["docs/"],
  );
});

test("folder keys map to and from absolute paths, and paths outside the project have none", () => {
  assert.equal(folderKeyFor("/u/home", "/u/home"), "");
  assert.equal(folderKeyFor("/u/home", "/u/home/src/lib"), "src/lib/");
  assert.equal(folderKeyFor("/u/home", "/u/homework"), null);
  assert.equal(folderKeyFor("/u/home", "/u"), null);
  assert.equal(folderPathFor("/u/home", ""), "/u/home");
  assert.equal(folderPathFor("/u/home", "src/lib/"), "/u/home/src/lib");
});
