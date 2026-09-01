import test from "node:test";
import assert from "node:assert/strict";
import {
  chatDeliveryFailureMessage,
  overrideForUrl,
  pickChatInput,
  resolveReplyTargets,
  scoreChatInput,
  type ChatInputCandidate,
} from "../shared/chat-delivery";
import { buildChatDeliveryScript } from "../shared/chat-delivery-script";

const input = (over: Partial<ChatInputCandidate> = {}): ChatInputCandidate => ({
  tag: "textarea",
  editable: false,
  disabled: false,
  width: 600,
  height: 48,
  bottomGap: 120,
  viewportHeight: 900,
  ...over,
});

test("unusable candidates are disqualified, never merely ranked low", () => {
  // A disqualified candidate must not win by being the only one on the page.
  assert.equal(scoreChatInput(input({ disabled: true })), null);
  assert.equal(scoreChatInput(input({ width: 40 })), null, "too narrow to be a composer");
  assert.equal(scoreChatInput(input({ height: 8 })), null);
  assert.equal(scoreChatInput(input({ tag: "div", editable: false })), null, "a plain div is not typable");
  assert.equal(pickChatInput([input({ disabled: true })]), null);
  assert.equal(pickChatInput([]), null);
});

test("a send button beside it outweighs geometry", () => {
  // The case this rule exists for: a wide search box at the top versus a
  // smaller composer at the bottom with a send button.
  const searchAtTop = input({ width: 900, bottomGap: 850, hasNearbySend: false });
  const composer = input({ width: 500, bottomGap: 90, hasNearbySend: true });
  assert.equal(pickChatInput([searchAtTop, composer]), 1);
});

test("a contenteditable composer beats a textarea when otherwise equal", () => {
  // ChatGPT and Gemini both use contenteditable; a bare input is a search box.
  const textarea = input({ tag: "textarea", editable: false });
  const editable = input({ tag: "div", editable: true });
  assert.equal(pickChatInput([textarea, editable]), 1);

  const plainInput = input({ tag: "input", editable: false });
  assert.equal(pickChatInput([plainInput, textarea]), 1, "textarea outranks a bare input");
});

test("ties resolve to document order, so delivery lands in the same place tomorrow", () => {
  const a = input({ hasNearbySend: true });
  const b = input({ hasNearbySend: true });
  assert.equal(pickChatInput([a, b]), 0);
});

test("only outgoing sends-replies-to wires are delivery targets", () => {
  const wires = [
    { id: "w1", from: { kind: "terminal", id: "t1" }, to: { kind: "browser", id: "b1" }, type: "sends-replies-to" },
    // Same pair, wrong meaning.
    { id: "w2", from: { kind: "terminal", id: "t1" }, to: { kind: "browser", id: "b2" }, type: "controls" },
    // Pointing AT the agent is a different relationship entirely.
    { id: "w3", from: { kind: "browser", id: "b3" }, to: { kind: "terminal", id: "t1" }, type: "sends-replies-to" },
    // Another agent's wire.
    { id: "w4", from: { kind: "terminal", id: "t2" }, to: { kind: "browser", id: "b4" }, type: "sends-replies-to" },
    // Untyped terminal→browser infers `controls`, so it must not deliver.
    { id: "w5", from: { kind: "terminal", id: "t1" }, to: { kind: "browser", id: "b5" } },
  ];
  assert.deepEqual(
    resolveReplyTargets("t1", wires).map((t) => t.id),
    ["b1"],
  );

  // Several targets is legitimate — a voice chat and a second opinion.
  const two = resolveReplyTargets("t1", [
    ...wires,
    { id: "w6", from: { kind: "terminal", id: "t1" }, to: { kind: "browser", id: "b6" }, type: "sends-replies-to" },
  ]);
  assert.deepEqual(two.map((t) => t.id), ["b1", "b6"]);
});

test("a per-host override is matched by host, not by prefix", () => {
  const overrides = [{ host: "chatgpt.com", selector: "#prompt-textarea" }];
  assert.equal(overrideForUrl("https://chatgpt.com/c/abc", overrides), "#prompt-textarea");
  assert.equal(overrideForUrl("https://CHATGPT.com/c/abc", overrides), "#prompt-textarea");
  assert.equal(overrideForUrl("https://notchatgpt.com/c/abc", overrides), undefined);
  assert.equal(overrideForUrl("https://gemini.google.com/app", overrides), undefined);
  assert.equal(overrideForUrl("not a url", overrides), undefined);
});

test("failure messages name the target and say what to do", () => {
  const msg = chatDeliveryFailureMessage("no-input-found", "ChatGPT");
  assert.match(msg, /ChatGPT/);
  assert.match(msg, /click the box once/i, "the fix is offered, not just the failure");

  // The one that must not read as success: the text is in the box, unsent.
  assert.match(chatDeliveryFailureMessage("submit-failed", "Gemini"), /still in the box/i);
});

test("the script is one expression carrying the scorer and the payload", () => {
  const script = buildChatDeliveryScript({ text: 'hi "there"\nsecond line', selector: "#box" });

  // Atomicity is the whole design constraint: typing and sending split across
  // evaluations lets the page lose focus and the send silently no-ops.
  assert.match(script, /^\(async \(\) => \{/);
  assert.match(script, /\}\)\(\)$/);

  // The scorer is inlined rather than reimplemented, so page and tests cannot
  // drift. If scoreChatInput ever closes over anything, this stops being true.
  assert.ok(script.includes("hasNearbySend"), "scorer body is present");
  assert.ok(!/\bimport\b|\brequire\(/.test(script), "the script cannot import anything");

  // Quotes and newlines survive into the page.
  assert.ok(script.includes(JSON.stringify('hi "there"\nsecond line')));
  assert.ok(script.includes('"selector":"#box"'));

  // Submitting is the default; opting out must be explicit.
  assert.ok(buildChatDeliveryScript({ text: "x" }).includes('"submit":true'));
  assert.ok(buildChatDeliveryScript({ text: "x", submit: false }).includes('"submit":false'));
});
