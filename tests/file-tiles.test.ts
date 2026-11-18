import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTiles, isInsideFolders, workdeskFolders } from "../electron/file-tiles";
import { fileTileKindByName, formatFileSize, isStreamedKind } from "../shared/file-tiles";
import { coerceFileTiles } from "../src/stores/fileTileStore";
import { buildSceneDocument } from "../src/canvas/sceneProjection";
import { placeRow } from "../src/files/fileTilePlacement";

test("a file's kind by its name: media by extension, anything else is read to tell", () => {
  assert.equal(fileTileKindByName("/a/hero.PNG"), "image");
  assert.equal(fileTileKindByName("/a/demo.mov"), "video");
  assert.equal(fileTileKindByName("/a/voice.m4a"), "audio");
  assert.equal(fileTileKindByName("/a/spec.pdf"), "pdf");
  assert.equal(fileTileKindByName("/a/index.ts"), null);
  assert.equal(fileTileKindByName("/a/.env"), null);
  assert.equal(isStreamedKind("video"), true);
  assert.equal(isStreamedKind("text"), false);
  assert.equal(formatFileSize(512), "512 bytes");
  assert.equal(formatFileSize(2.4 * 1024 * 1024), "2.4 MB");
});

test("every workdesk's folders and worktrees come from the saved state", () => {
  const state = {
    scene: { projects: [{ path: "/code/lantern", worktrees: [{ path: "/code/lantern-wt" }] }] },
    workspace: {
      canvases: [
        { scene: { projects: [{ path: "/code/tacit", worktrees: [] }] } },
        { scene: { projects: [{ path: "relative/ignored" }] } },
      ],
    },
  };
  assert.deepEqual(workdeskFolders(state).sort(), ["/code/lantern", "/code/lantern-wt", "/code/tacit"]);
  assert.deepEqual(workdeskFolders(null), []);
});

test("only paths inside a folder count; a sibling with the same prefix doesn't", () => {
  const folders = ["/code/lantern"];
  assert.equal(isInsideFolders("/code/lantern/src/a.ts", folders), true);
  assert.equal(isInsideFolders("/code/lantern-other/a.ts", folders), false);
  assert.equal(isInsideFolders("/code/lantern/../secret.txt", folders), false);
  assert.equal(isInsideFolders("/code/lantern", folders), false);
});

test("inspect: media gets a streaming URL, text and binaries are told apart, outside paths are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tiles-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "file-tiles-out-"));
  try {
    fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.from([0, 0, 0, 24]));
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "deck.key"), Buffer.from([80, 75, 3, 4, 0, 0]));
    fs.writeFileSync(path.join(outside, "secret.txt"), "no");
    fs.mkdirSync(path.join(dir, "sub"));
    const tiles = new FileTiles(() => [dir]);

    const video = tiles.inspect(path.join(dir, "clip.mp4"));
    assert.ok(video.ok && video.kind === "video" && video.url?.startsWith("tc-attachment://file/"));
    const id = video.ok ? video.url!.slice("tc-attachment://file/".length) : "";
    assert.equal(tiles.pathFor(id), path.join(dir, "clip.mp4"));
    assert.equal(tiles.pathFor("not-an-id"), null);

    const text = tiles.inspect(path.join(dir, "notes.txt"));
    assert.ok(text.ok && text.kind === "text" && text.url === undefined && text.size === 6);
    const other = tiles.inspect(path.join(dir, "deck.key"));
    assert.ok(other.ok && other.kind === "other");

    assert.deepEqual(tiles.inspect(path.join(outside, "secret.txt")), { ok: false, error: "outside-folders" });
    assert.deepEqual(tiles.inspect(path.join(dir, "gone.png")), { ok: false, error: "missing" });
    assert.deepEqual(tiles.inspect(path.join(dir, "sub")), { ok: false, error: "not-a-file" });
    assert.deepEqual(tiles.inspect("relative.txt"), { ok: false, error: "invalid" });
    assert.deepEqual(tiles.inspect(42), { ok: false, error: "invalid" });
    assert.equal(tiles.checked(path.join(outside, "secret.txt")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a link inside a folder that leads out of it is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tiles-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "file-tiles-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.png"), Buffer.from([137, 80]));
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(dir, "link.png"));
    fs.writeFileSync(path.join(dir, "own.png"), Buffer.from([137, 80]));
    fs.symlinkSync(path.join(dir, "own.png"), path.join(dir, "alias.png"));
    const tiles = new FileTiles(() => [dir]);
    assert.deepEqual(tiles.inspect(path.join(dir, "link.png")), { ok: false, error: "outside-folders" });
    assert.ok(tiles.inspect(path.join(dir, "alias.png")).ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a streamed file stops being served once its folder leaves the workdesk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tiles-"));
  try {
    fs.writeFileSync(path.join(dir, "a.png"), Buffer.from([137, 80, 78, 71]));
    let folders = [dir];
    const tiles = new FileTiles(() => folders);
    const info = tiles.inspect(path.join(dir, "a.png"));
    assert.ok(info.ok && info.url);
    const id = info.url!.slice("tc-attachment://file/".length);
    folders = [];
    assert.equal(tiles.pathFor(id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved tiles keep only well-formed entries, and travel in the scene", () => {
  const tiles = coerceFileTiles({
    a: { id: "a", path: "/code/x.png", x: 1, y: 2, w: 300, h: 200 },
    b: { id: "b", path: "", x: 1, y: 2, w: 300, h: 200 },
    c: { id: "c", path: "/code/y.png", x: "1", y: 2, w: 300, h: 200 },
    d: null,
  });
  assert.deepEqual(Object.keys(tiles), ["a"]);
  assert.deepEqual(buildSceneDocument({ fileTiles: tiles }).fileTiles, tiles);
  assert.equal("fileTiles" in buildSceneDocument({ fileTiles: {} }), false);
});

test("a row of new tiles sits side by side, moved clear of what's already there", () => {
  const sizes = [{ w: 100, h: 80 }, { w: 200, h: 120 }];
  assert.deepEqual(placeRow(sizes, { x: 0, y: 0 }, []), [
    { x: 0, y: 0, w: 100, h: 80 },
    { x: 124, y: 0, w: 200, h: 120 },
  ]);
  const taken = [{ x: 50, y: 50, w: 400, h: 300 }];
  const row = placeRow(sizes, { x: 0, y: 0 }, taken);
  const clear = row.every((r) => r.x + r.w + 24 <= taken[0].x || r.x >= taken[0].x + taken[0].w + 24 || r.y + r.h + 24 <= taken[0].y || r.y >= taken[0].y + taken[0].h + 24);
  assert.equal(clear, true);
  assert.equal(row[1].x - row[0].x, 124);
});
