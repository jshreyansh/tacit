import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEDIA_MAX_BYTES, mediaFileName, saveWorkdeskMedia, sniffMedia } from "../electron/workdesk-media.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const text = (s: string) => new TextEncoder().encode(s);
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "workdesk-media-"));
const NOW = new Date(2026, 10, 23, 14, 5, 9);

test("files are recognised by their content, not their name", () => {
  assert.deepEqual(sniffMedia(PNG), { kind: "image", ext: "png" });
  assert.deepEqual(sniffMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), { kind: "image", ext: "jpg" });
  assert.deepEqual(sniffMedia(text("GIF89a....")), { kind: "image", ext: "gif" });
  assert.deepEqual(sniffMedia(text("RIFF\0\0\0\0WEBPVP8 ")), { kind: "image", ext: "webp" });
  assert.deepEqual(sniffMedia(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), { kind: "image", ext: "svg" });
  assert.deepEqual(sniffMedia(text("%PDF-1.7\n")), { kind: "pdf", ext: "pdf" });
  assert.deepEqual(sniffMedia(text("\0\0\0\x18ftypqt  ")), { kind: "video", ext: "mov" });
  assert.deepEqual(sniffMedia(text("\0\0\0\x18ftypisom")), { kind: "video", ext: "mp4" });
  assert.deepEqual(sniffMedia(text("\0\0\0\x18ftypM4A ")), { kind: "audio", ext: "m4a" });
  assert.deepEqual(sniffMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])), { kind: "video", ext: "webm" });
  assert.deepEqual(sniffMedia(text("ID3\x04\0")), { kind: "audio", ext: "mp3" });
  assert.deepEqual(sniffMedia(text("RIFF\0\0\0\0WAVEfmt ")), { kind: "audio", ext: "wav" });
  assert.equal(sniffMedia(text("<html><script>alert(1)</script>")), null);
  assert.equal(sniffMedia(text("#!/bin/sh\nrm -rf /")), null);
});

test("names: no folders or odd characters, the extension from the content, a pasted image named by time", () => {
  assert.equal(mediaFileName("../../etc/passwd", "png", NOW), "passwd.png");
  assert.equal(mediaFileName("Sketch: v2?.jpeg", "jpg", NOW), "Sketch- v2.jpg");
  assert.equal(mediaFileName("notes.exe", "pdf", NOW), "notes.pdf");
  assert.equal(mediaFileName("image.png", "png", NOW), "Pasted 2026-11-23 at 14.05.09.png");
  assert.equal(mediaFileName("", "png", NOW), "Pasted 2026-11-23 at 14.05.09.png");
  assert.equal(mediaFileName(42, "png", NOW), "Pasted 2026-11-23 at 14.05.09.png");
});

test("saved under .tacit/media in the workdesk folder, kept out of git, the same file once", () => {
  const root = folder();
  const a = saveWorkdeskMedia([root], root, PNG, "shot.png", NOW);
  const again = saveWorkdeskMedia([root], root, PNG, "shot.png", NOW);
  assert.deepEqual(a, { ok: true, path: path.join(root, ".tacit", "media", "shot.png") });
  assert.deepEqual(again, a);
  assert.match(fs.readFileSync(path.join(root, ".tacit", "media", ".gitignore"), "utf8"), /^\*$/m);
  // A different picture with the same name doesn't replace it.
  const other = new Uint8Array([...PNG, 1]);
  assert.deepEqual(saveWorkdeskMedia([root], root, other, "shot.png", NOW), { ok: true, path: path.join(root, ".tacit", "media", "shot 2.png") });
  assert.deepEqual(fs.readFileSync(path.join(root, ".tacit", "media", "shot.png")), Buffer.from(PNG));
});

test("refused: a folder that isn't the workdesk's, not media, too large, empty, or not bytes", () => {
  const root = folder();
  const elsewhere = folder();
  assert.deepEqual(saveWorkdeskMedia([root], elsewhere, PNG, "a.png"), { ok: false, reason: "not_a_folder" });
  assert.deepEqual(saveWorkdeskMedia([root], path.join(root, "sub"), PNG, "a.png"), { ok: false, reason: "not_a_folder" });
  assert.deepEqual(saveWorkdeskMedia([root], "relative", PNG, "a.png"), { ok: false, reason: "not_a_folder" });
  assert.deepEqual(saveWorkdeskMedia([root], root, text("hello"), "a.png"), { ok: false, reason: "unsupported" });
  const big = new Uint8Array(MEDIA_MAX_BYTES.image + 1);
  big.set(PNG);
  assert.deepEqual(saveWorkdeskMedia([root], root, big, "big.png"), { ok: false, reason: "too_large" });
  assert.deepEqual(saveWorkdeskMedia([root], root, new Uint8Array(0), "x"), { ok: false, reason: "empty" });
  assert.deepEqual(saveWorkdeskMedia([root], root, "/etc/passwd", "x"), { ok: false, reason: "empty" });
  assert.equal(fs.existsSync(path.join(root, ".tacit")), false);
  assert.equal(fs.existsSync(path.join(elsewhere, ".tacit")), false);
});

test("any other file keeps its own extension, unless it pretends to be media", () => {
  const root = folder();
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
  assert.deepEqual(saveWorkdeskMedia([root], root, zip, "Report.zip", NOW), { ok: true, path: path.join(root, ".tacit", "media", "Report.zip") });
  assert.deepEqual(saveWorkdeskMedia([root], root, text("hello"), "notes.md", NOW), { ok: true, path: path.join(root, ".tacit", "media", "notes.md") });
  assert.deepEqual(saveWorkdeskMedia([root], root, text("all"), "Makefile", NOW), { ok: true, path: path.join(root, ".tacit", "media", "Makefile") });
  assert.deepEqual(saveWorkdeskMedia([root], root, text("<html><script>x</script>"), "photo.svg", NOW), { ok: false, reason: "unsupported" });
  assert.deepEqual(saveWorkdeskMedia([root], root, text("not a png"), "photo.png", NOW), { ok: false, reason: "unsupported" });
  // A picture named wrongly is saved under what it really is.
  assert.deepEqual(saveWorkdeskMedia([root], root, PNG, "diagram.pdf", NOW), { ok: true, path: path.join(root, ".tacit", "media", "diagram.png") });
});
