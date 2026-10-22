import test from "node:test";
import assert from "node:assert/strict";

// The store reaches the app through window.tacit; this stands in for it with
// a folder tree in memory and a record of what was listed and watched.
type Listing = { type: "git"; paths: string[] } | { type: "lazy"; reason: "not-git" | "large" };

type WatchAnswer = { ok: true } | { ok: false; reason: "limit" | "gone" | "failed"; message: string };
type Failure = { dirPath: string; recursive: boolean; message: string };

function fakeTacit(tree: Record<string, string[] | Error>, listing: Listing) {
  const calls = { listAllFiles: 0, listDir: [] as string[], watched: new Set<string>(), unwatched: [] as string[] };
  // Folders main refuses to watch, and with what answer.
  const refuse = new Map<string, WatchAnswer>();
  const dirListeners = new Set<(dirPath: string) => void>();
  const failedListeners = new Set<(failures: Failure[]) => void>();
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
      watchDir: async (dirPath: string, recursive: boolean): Promise<WatchAnswer> => {
        const refused = refuse.get(dirPath);
        if (refused) return refused;
        calls.watched.add(`${recursive ? "tree" : "folder"}:${dirPath}`);
        return { ok: true };
      },
      unwatchDir: async (dirPath: string, recursive: boolean) => {
        const key = `${recursive ? "tree" : "folder"}:${dirPath}`;
        calls.unwatched.push(key);
        calls.watched.delete(key);
      },
      onDirChanged: (callback: (dirPath: string) => void) => {
        dirListeners.add(callback);
        return () => dirListeners.delete(callback);
      },
      onWatchFailed: (callback: (failures: Failure[]) => void) => {
        failedListeners.add(callback);
        return () => failedListeners.delete(callback);
      },
    },
    git: { onChanged: () => () => {} },
  };
  const changed = (dirPath: string) => dirListeners.forEach((listener) => listener(dirPath));
  // Main lost these watches: they're no longer watched there.
  const failed = (failures: Failure[]) => {
    for (const failure of failures) calls.watched.delete(`${failure.recursive ? "tree" : "folder"}:${failure.dirPath}`);
    failedListeners.forEach((listener) => listener(failures));
  };
  return { tacit, calls, changed, failed, refuse };
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

test("a folder main won't watch isn't counted as watched, the panel says why, and a refresh asks again", async () => {
  const { tacit, calls, refuse } = fakeTacit(
    { [HOME]: ["code/"], [`${HOME}/code`]: ["a.ts"] },
    { type: "lazy", reason: "not-git" },
  );
  refuse.set(`${HOME}/code`, { ok: false, reason: "limit", message: "Tacit is already watching 1000 folders" });
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "code/");
  await settle();
  assert.deepEqual(store.getState().byWorktree[HOME].paths.sort(), ["code/", "code/a.ts"], "the folder still opens");
  assert.equal(store.getState().byWorktree[HOME].watchProblem?.reason, "limit");

  // Room again: a refresh watches it, and the note goes.
  refuse.clear();
  await store.getState().refresh(HOME);
  await settle();
  assert.ok(calls.watched.has(`folder:${HOME}/code`));
  assert.equal(store.getState().byWorktree[HOME].watchProblem, null);
});

test("a refused watch is never unwatched: that would take a share of another project's watch", async () => {
  const { tacit, calls, refuse } = fakeTacit(
    { [HOME]: ["code/"], [`${HOME}/code`]: ["a.ts"] },
    { type: "lazy", reason: "not-git" },
  );
  refuse.set(`${HOME}/code`, { ok: false, reason: "limit", message: "full" });
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "code/");
  await settle();
  store.getState().release(HOME);
  assert.deepEqual(calls.unwatched, [`folder:${HOME}`]);
});

test("watches main lost are forgotten and noted, with nothing re-listed; a refresh watches them again", async () => {
  const { tacit, calls, failed } = fakeTacit(
    { [HOME]: ["code/", "notes/"], [`${HOME}/code`]: ["a.ts"], [`${HOME}/notes`]: ["n.md"] },
    { type: "lazy", reason: "not-git" },
  );
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(HOME);
  await settle();
  await store.getState().openFolder(HOME, "code/");
  await store.getState().openFolder(HOME, "notes/");
  await settle();

  calls.listDir.length = 0;
  failed([
    { dirPath: HOME, recursive: false, message: "macOS can't watch any more folders" },
    { dirPath: `${HOME}/code`, recursive: false, message: "macOS can't watch any more folders" },
    { dirPath: "/somewhere/else", recursive: false, message: "not ours" },
  ]);
  await settle();
  assert.deepEqual(calls.listDir, [], "a lost watch re-listed folders");
  assert.deepEqual(store.getState().byWorktree[HOME].watchProblem, { reason: "failed", message: "macOS can't watch any more folders" });

  // Letting go doesn't unwatch what main no longer holds.
  store.getState().release(HOME);
  assert.deepEqual(calls.unwatched, [`folder:${HOME}/notes`]);

  store.getState().acquire(HOME);
  await settle();
  assert.deepEqual([...calls.watched].sort(), [`folder:${HOME}`, `folder:${HOME}/code`, `folder:${HOME}/notes`]);
  assert.equal(store.getState().byWorktree[HOME].watchProblem, null);
});

test("a git project whose tree watch is lost says so until a refresh watches it again", async () => {
  const REPO = "/Users/me/tacit";
  const { tacit, calls, failed } = fakeTacit({}, { type: "git", paths: ["a.ts"] });
  (globalThis as { window?: unknown }).window = { tacit };
  const store = await freshStore();
  store.getState().acquire(REPO);
  await settle();
  failed([{ dirPath: REPO, recursive: true, message: "macOS can't watch any more folders" }]);
  await settle();
  assert.equal(calls.listAllFiles, 1, "a lost watch re-listed the project");
  assert.equal(store.getState().byWorktree[REPO].watchProblem?.reason, "failed");
  await store.getState().refresh(REPO);
  await settle();
  assert.ok(calls.watched.has(`tree:${REPO}`));
  assert.equal(store.getState().byWorktree[REPO].watchProblem, null);
});
