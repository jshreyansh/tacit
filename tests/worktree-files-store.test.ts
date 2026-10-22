import test from "node:test";
import assert from "node:assert/strict";

// The store reaches the app through window.tacit; this stands in for it with
// a folder tree in memory and a record of what was listed and watched.
type Listing = { type: "git"; paths: string[] } | { type: "lazy"; reason: "not-git" | "large" };

function fakeTacit(tree: Record<string, string[] | Error>, listing: Listing) {
  const calls = { listAllFiles: 0, listDir: [] as string[], watched: new Set<string>() };
  const dirListeners = new Set<(dirPath: string) => void>();
  const tacit = {
    fs: {
      listAllFiles: async () => {
        calls.listAllFiles += 1;
        return listing;
      },
      listIgnoredFiles: async () => [],
      listDir: async (dirPath: string) => {
        calls.listDir.push(dirPath);
        const entries = tree[dirPath];
        if (entries instanceof Error) return { error: entries.message };
        if (!entries) return { error: "it no longer exists" };
        return { entries: entries.map((name) => ({ name: name.replace(/\/$/, ""), isDirectory: name.endsWith("/") })) };
      },
      watchDir: async (dirPath: string, recursive?: boolean) => {
        calls.watched.add(`${recursive === false ? "folder" : "tree"}:${dirPath}`);
      },
      unwatchDir: async (dirPath: string, recursive?: boolean) => {
        calls.watched.delete(`${recursive === false ? "folder" : "tree"}:${dirPath}`);
      },
      onDirChanged: (callback: (dirPath: string) => void) => {
        dirListeners.add(callback);
        return () => dirListeners.delete(callback);
      },
    },
    git: { onChanged: () => () => {} },
  };
  const changed = (dirPath: string) => dirListeners.forEach((listener) => listener(dirPath));
  return { tacit, calls, changed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await flush();
}

async function freshStore() {
  // A new module instance per test: the store keeps its watch bookkeeping
  // at module level.
  const mod = await import(`../src/stores/worktreeFilesStore.ts?test=${Math.random()}`);
  return mod.useWorktreeFilesStore as typeof import("../src/stores/worktreeFilesStore.ts").useWorktreeFilesStore;
}

const HOME = "/Users/me";

test("a folder that isn't a git repository shows its top level, watched one level deep, never whole", async () => {
  const { tacit, calls } = fakeTacit(
    { [HOME]: ["Library/", "code/", ".zshrc"], [`${HOME}/code`]: ["app/"] },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();

  const entry = store.getState().byWorktree[HOME];
  assert.equal(entry.mode, "lazy");
  assert.deepEqual([...entry.paths].sort(), [".zshrc", "Library/", "code/"]);
  assert.deepEqual(calls.listDir, [HOME], "listed more than the top level before anything was opened");
  assert.deepEqual([...calls.watched], [`folder:${HOME}`]);
});

test("opening a folder loads it alone; a change re-lists only the folder it happened in", async () => {
  const { tacit, calls, changed } = fakeTacit(
    { [HOME]: ["code/", "notes/"], [`${HOME}/code`]: ["a.ts", "b.ts"], [`${HOME}/notes`]: ["n.md"] },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "code/");
  await settle();
  assert.deepEqual([...store.getState().byWorktree[HOME].paths].sort(), ["code/", "code/a.ts", "code/b.ts", "notes/"]);
  assert.ok(calls.watched.has(`folder:${HOME}/code`));

  calls.listDir.length = 0;
  changed(`${HOME}/code`);
  changed(`${HOME}/notes`); // not loaded: nothing to re-list
  changed("/somewhere/else");
  await settle();
  assert.deepEqual(calls.listDir, [`${HOME}/code`]);
  assert.equal(calls.listAllFiles, 1, "a change re-ran the whole-project listing");
});

test("a folder whose only entry is a folder loads that one too", async () => {
  const { tacit } = fakeTacit(
    { [HOME]: ["src/"], [`${HOME}/src`]: ["main/"], [`${HOME}/src/main`]: ["java/", "res/"] },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  const folders = Object.keys(store.getState().byWorktree[HOME].folders).sort();
  assert.deepEqual(folders, ["", "src/", "src/main/"]);
});

test("a folder that can't be read is marked, shown without contents, and not retried until a refresh", async () => {
  const { tacit, calls } = fakeTacit(
    { [HOME]: ["Library/"], [`${HOME}/Library`]: new Error("EPERM: operation not permitted") },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "Library/");
  await store.getState().openFolder(HOME, "Library/");
  await settle();
  const entry = store.getState().byWorktree[HOME];
  assert.match(entry.unreadable["Library/"], /EPERM/);
  assert.deepEqual(entry.paths, ["Library/"]);
  assert.equal(calls.listDir.filter((dir) => dir.endsWith("Library")).length, 1);
});

test("a folder gone from its parent's listing is dropped and stops being watched", async () => {
  const tree: Record<string, string[]> = { [HOME]: ["tmp/"], [`${HOME}/tmp`]: ["x.txt"] };
  const { tacit, calls, changed } = fakeTacit(tree, { type: "lazy", reason: "not-git" });
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "tmp/");
  await settle();
  tree[HOME] = [];
  delete tree[`${HOME}/tmp`];
  changed(HOME);
  await settle();
  assert.deepEqual(store.getState().byWorktree[HOME].paths, []);
  assert.ok(!calls.watched.has(`folder:${HOME}/tmp`));
});

test("letting go of the panel stops every watch", async () => {
  const { tacit, calls } = fakeTacit(
    { [HOME]: ["code/"], [`${HOME}/code`]: ["a.ts"] },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "code/");
  await settle();
  store.getState().release(HOME);
  assert.deepEqual([...calls.watched], []);
});

test("a git project is watched whole, and only its own changes re-list it", async () => {
  const REPO = "/Users/me/tacit";
  const { tacit, calls, changed } = fakeTacit({}, { type: "git", paths: ["a.ts", "src/b.ts"] });
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(REPO);
  await settle();
  assert.equal(store.getState().byWorktree[REPO].mode, "full");
  assert.deepEqual(store.getState().byWorktree[REPO].paths, ["a.ts", "src/b.ts"]);
  assert.deepEqual([...calls.watched], [`tree:${REPO}`]);

  changed("/Users/me/other-project");
  await settle();
  assert.equal(calls.listAllFiles, 1, "another project's change re-listed this one");
  changed(REPO);
  await settle();
  assert.equal(calls.listAllFiles, 2);
});
