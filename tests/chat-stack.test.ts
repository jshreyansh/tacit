import test from "node:test";
import assert from "node:assert/strict";
import type { ChatQuestion } from "../shared/chat-events";
import { claudeApprovalLine, claudeDenyMessage } from "../shared/chat-stream-claude";
import { answersFor, decideDraft, receiptsFor, stepAfter, type QuestionDraft } from "../src/toolbar/chat/questionModel";
import { diffTotals } from "../src/toolbar/chat/chatPlaceModel";

const q = (id: string, header: string, options?: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
  id,
  question: `${header}?`,
  header,
  options: options ? options.map((label) => ({ label })) : null,
  multiSelect: false,
  allowOther: false,
  secret: false,
  ...extra,
});
const none: QuestionDraft = { picked: [], other: "", otherOn: false };

test("several questions go one to the next, then to a review; a single one submits", () => {
  assert.deepEqual(stepAfter(0, 3), { question: 1 });
  assert.deepEqual(stepAfter(1, 3), { question: 2 });
  assert.equal(stepAfter(2, 3), "review");
  assert.equal(stepAfter(0, 1), "submit");
});

test("answers given so far show as receipts, not the one open now; secrets as dots", () => {
  const questions = [q("a", "Scope", ["Fix it", "Report"]), q("b", "Tests", ["Render", "Screenshot"], { multiSelect: true }), q("c", "Key", undefined, { secret: true })];
  const drafts: QuestionDraft[] = [
    { picked: ["Fix it"], other: "", otherOn: false },
    { picked: ["Render", "Screenshot"], other: "", otherOn: false },
    { picked: [], other: "sk-123", otherOn: true },
  ];
  assert.deepEqual(receiptsFor(questions, drafts, 1), [
    { index: 0, label: "Scope", answer: "Fix it" },
    { index: 2, label: "Key", answer: "••••••" },
  ]);
  // Nothing answered: no receipts.
  assert.deepEqual(receiptsFor(questions, [none, none, none], 0), []);
});

test("letting the agent decide answers in the person's words, even where only options were offered", () => {
  const questions = [q("a", "Ship", ["Tonight", "Tomorrow"])];
  const answers = answersFor(questions, [decideDraft("You decide: use your best judgement.")]);
  assert.deepEqual(answers, { a: ["You decide: use your best judgement."] });
});

test("a branch's changes add up, binary files counted only as files", () => {
  assert.deepEqual(
    diffTotals([
      { additions: 40, deletions: 5 },
      { additions: 2, deletions: 2 },
      { additions: 0, deletions: 0, binary: true },
    ]),
    { additions: 42, deletions: 7, files: 3 },
  );
  assert.deepEqual(diffTotals([]), { additions: 0, deletions: 0, files: 0 });
});

test("Claude hears what to do instead when a tool is denied with words; else the plain refusal", () => {
  assert.equal(claudeDenyMessage("   "), undefined);
  const said = claudeDenyMessage("use pnpm instead");
  assert.match(said ?? "", /use pnpm instead/);
  const line = JSON.parse(claudeApprovalLine("r1", false, undefined, said));
  assert.equal(line.response.response.behavior, "deny");
  assert.match(line.response.response.message, /use pnpm instead/);
  const plain = JSON.parse(claudeApprovalLine("r2", false, undefined, claudeDenyMessage(undefined)));
  assert.equal(plain.response.response.message, "The person declined this in Tacit.");
});

import { buildChatList, folderDot, orderLive } from "../src/toolbar/chatListModel";

test("the navigator keeps every folder of the workdesk, even with no chats; a search hides the empty ones", () => {
  const folders = [
    { id: "a", name: "lantern", path: "/w/lantern", worktreePaths: ["/w/lantern"] },
    { id: "b", name: "wallpaper", path: "/w/wallpaper", worktreePaths: ["/w/wallpaper"] },
  ];
  assert.deepEqual(buildChatList(folders, [], [], { keepEmpty: true }).map((f) => f.name), ["lantern", "wallpaper"]);
  assert.deepEqual(buildChatList(folders, [], []).map((f) => f.name), []);
  assert.deepEqual(buildChatList(folders, [], [], { keepEmpty: true, query: "x" }).map((f) => f.name), []);
});

test("a folder's chats put the one that needs you first; its dot says the same", () => {
  const items = [{ id: 1, state: "idle" }, { id: 2, state: "active" }, { id: 3, state: "attention" }] as const;
  assert.deepEqual(orderLive(items as never as { id: number; state: "idle" | "active" | "attention" }[]).map((i) => i.id), [3, 2, 1]);
  assert.equal(folderDot(items as never), "need");
  assert.equal(folderDot([{ state: "active" }] as never), "run");
  assert.equal(folderDot([{ state: "idle" }] as never), null);
});
