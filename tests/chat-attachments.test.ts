import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachmentKind, mentionOf, splitMentions, withMentions } from "../shared/chat-attachments";
import { codexUserInput } from "../shared/chat-stream-codex";
import { claudeCapabilities } from "../shared/chat-stream-claude";
import { timelineToChatEvents } from "../shared/chat-history";
import { replayChat } from "../shared/chat-transcript";
import { ChatAttachments, imageExtension } from "../electron/manager-chat/chat-attachments";
import { toThreadMessages } from "../src/toolbar/chat/threadMessages";
import { previewKind } from "../src/toolbar/chat/attachmentPreview";
import type { TimelineEvent } from "../shared/sessions";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("files go after the text as @path lines, quoted when the path has spaces, and come back from history", () => {
  assert.equal(mentionOf("/repo/src/a.ts"), "@/repo/src/a.ts");
  assert.equal(mentionOf("/Users/me/My Shots/one.png"), '@"/Users/me/My Shots/one.png"');
  const sent = withMentions("Look at these", ["/repo/src/a.ts", "/Users/me/My Shots/one.png"]);
  assert.equal(sent, 'Look at these\n\n@/repo/src/a.ts\n@"/Users/me/My Shots/one.png"');
  assert.deepEqual(splitMentions(sent), {
    text: "Look at these",
    attachments: [
      { name: "a.ts", path: "/repo/src/a.ts", kind: "file" },
      { name: "one.png", path: "/Users/me/My Shots/one.png", kind: "image" },
    ],
  });
  // Only files: the mentions are the whole message.
  assert.deepEqual(splitMentions(withMentions("", ["/x/y.md"])), { text: "", attachments: [{ name: "y.md", path: "/x/y.md", kind: "file" }] });
  // An @name in what the person wrote stays text.
  assert.deepEqual(splitMentions("ping @alice"), { text: "ping @alice", attachments: [] });
  assert.deepEqual(splitMentions("see\n@src/a.ts"), { text: "see\n@src/a.ts", attachments: [] });
  assert.deepEqual(splitMentions("line one\n@/abs/a.ts"), { text: "line one\n@/abs/a.ts", attachments: [] });
  assert.equal(attachmentKind("Shot.JPEG"), "image");
  assert.equal(attachmentKind("notes.pdf"), "file");
});

test("Codex gets each image as a picture and other files as paths in the text", () => {
  assert.deepEqual(
    codexUserInput("Fix it", [
      { name: "a.ts", path: "/r/a.ts", kind: "file" },
      { name: "s.png", path: "/r/s.png", kind: "image" },
    ]),
    [
      { type: "text", text: "Fix it\n\n@/r/a.ts", text_elements: [] },
      { type: "localImage", path: "/r/s.png" },
    ],
  );
  assert.deepEqual(codexUserInput("", [{ name: "s.png", path: "/r/s.png", kind: "image" }]), [{ type: "localImage", path: "/r/s.png" }]);
});

test("a message reopened from history shows its files again, as assistant-ui attachments", () => {
  const events = timelineToChatEvents([
    { type: "user_prompt", index: 0, timestamp: "2026-10-18T10:00:00Z", textPreview: "What's here?\n\n@/r/shot.png" } as TimelineEvent,
  ]);
  const t = replayChat(events);
  const user = t.messages[0];
  assert.equal(user.role, "user");
  if (user.role !== "user") return;
  assert.equal(user.text, "What's here?");
  assert.deepEqual(user.attachments, [{ name: "shot.png", path: "/r/shot.png", kind: "image" }]);
  const [thread] = toThreadMessages([{ ...user, attachments: [{ name: "shot.png", path: "/r/shot.png", kind: "image", preview: "data:image/png;base64,AA" }] }]);
  assert.deepEqual(thread.attachments, [
    { id: `unheld:${user.id}-0`, type: "image", name: "shot.png", status: { type: "complete" }, content: [{ type: "image", image: "data:image/png;base64,AA" }] },
  ]);
  // Only files: no text bubble.
  assert.deepEqual(toThreadMessages([{ ...user, text: "" }])[0].content, []);
});

test("only files the person chose can be sent, by id; a pasted image is saved as a file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-attach-"));
  try {
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "hello");
    const store = new ChatAttachments({ dir: path.join(dir, "pasted"), preview: async (p) => (p.endsWith(".png") ? "data:image/png;base64,AA" : undefined) });
    const picked = await store.addPath(file);
    assert.deepEqual([picked.name, picked.kind, picked.size, picked.preview], ["notes.md", "file", 5, undefined]);
    await assert.rejects(store.addPath("relative/notes.md"), /not a file path/);
    await assert.rejects(store.addPath(dir), /isn't a file/);
    const pasted = await store.addImage("", PNG);
    assert.equal(pasted.kind, "image");
    assert.equal(pasted.preview, "data:image/png;base64,AA");
    assert.ok(pasted.path.startsWith(path.join(dir, "pasted")) && fs.existsSync(pasted.path));
    await assert.rejects(store.addImage("x.png", new Uint8Array([1, 2, 3])), /only PNG/);
    assert.deepEqual(store.resolve([picked.id]), [{ id: picked.id, name: "notes.md", path: file, kind: "file" }]);
    assert.deepEqual(store.resolve(undefined), []);
    assert.throws(() => store.resolve(["nope"]), /no longer available/);
    assert.equal(store.get(picked.id)?.path, file);
    assert.equal(store.get("nope"), null);
    // A file a reopened chat mentions is held again, under the same id once held.
    assert.equal((await store.rehold({ name: "notes.md", path: file, kind: "file" })).id, picked.id);
    const other = path.join(dir, "other.txt");
    fs.writeFileSync(other, "x");
    assert.ok((await store.rehold({ name: "other.txt", path: other, kind: "file" })).id);
    assert.equal((await store.rehold({ name: "gone.txt", path: path.join(dir, "gone.txt"), kind: "file" })).id, undefined);
    assert.equal(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each file opens the way it can be shown: in the chat's viewer, or Quick Look", () => {
  assert.deepEqual(
    ["a.MP4", "b.mov", "c.mp3", "README.md", "x.ts", "deck.pptx", "paper.pdf", "shot.png", "noext"].map(previewKind),
    ["video", "video", "audio", "markdown", "text", "quicklook", "quicklook", "image", "quicklook"],
  );
});

test("Claude's default model chip says which model it is", () => {
  const caps = claudeCapabilities({
    models: [
      { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { value: "haiku", displayName: "Haiku 5.5", description: "Fastest" },
    ],
  });
  assert.deepEqual(caps.models.map((m) => m.short ?? m.label), ["Opus 5.5", "Haiku 5.5"]);
  assert.equal(caps.modes.find((m) => m.id === "default")?.short, "Ask");
});
