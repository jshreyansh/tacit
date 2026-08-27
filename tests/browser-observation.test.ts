import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  elementLabel,
  elementRole,
  isSecretField,
  isNearDuplicateText,
  isWellFormedObservation,
  normalizeLabel,
  normalizePageText,
  MAX_LABEL_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  type ObservableElement,
} from "../shared/browser-observation";
import { isRedactedUrl, redactionRuleFor } from "../shared/browser-redaction";
import { identityIdFromPartition, partitionForBrowserIdentity } from "../shared/browser-profile-import";
import { BrowserObservationStore } from "../electron/browser-observation-store";
import { resolvePopupDisposition } from "../electron/browser-popup";

/** Minimal stand-in for a DOM element; the preload passes a real one. */
function el(
  tagName: string,
  attrs: Record<string, string> = {},
  textContent?: string,
): ObservableElement {
  return {
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
    textContent: textContent ?? null,
  };
}

test("roles are derived from the tag when none is declared", () => {
  assert.equal(elementRole(el("BUTTON")), "button");
  assert.equal(elementRole(el("A", { href: "/x" })), "link");
  assert.equal(elementRole(el("A")), "generic", "an anchor without href is not a link");
  assert.equal(elementRole(el("INPUT", { type: "checkbox" })), "checkbox");
  assert.equal(elementRole(el("INPUT", { type: "submit" })), "button");
  assert.equal(elementRole(el("INPUT")), "textbox");
  assert.equal(elementRole(el("DIV", { role: "TAB  extra" })), "tab", "explicit role wins");
});

test("labels resolve in accessibility order and are capped", () => {
  assert.equal(elementLabel(el("BUTTON", { "aria-label": "Approve" }, "ignored")), "Approve");
  assert.equal(elementLabel(el("BUTTON", {}, "  Send \n invite ")), "Send invite");
  assert.equal(elementLabel(el("INPUT", { id: "f" }), () => "Email"), "Email");
  assert.equal(elementLabel(el("INPUT", {})), undefined);

  const long = "x".repeat(MAX_LABEL_LENGTH + 40);
  const capped = normalizeLabel(long) ?? "";
  assert.equal(capped.length, MAX_LABEL_LENGTH);
  assert.ok(capped.endsWith("…"));
});

test("secret fields are recognised and never described by value", () => {
  assert.equal(isSecretField(el("INPUT", { type: "password" })), true);
  assert.equal(isSecretField(el("INPUT", { autocomplete: "cc-number" })), true);
  assert.equal(isSecretField(el("INPUT", { autocomplete: "one-time-code" })), true);
  assert.equal(isSecretField(el("INPUT", { type: "text" })), false);
  assert.equal(isSecretField(el("DIV", { type: "password" })), false);

  // The label of a password box is safe; its contents are not reachable at all.
  const secret = el("INPUT", { type: "password", placeholder: "Password", value: "hunter2" });
  assert.equal(elementLabel(secret), "Password");

  // No element type resolves its label from `value`, which is the rule that
  // keeps field contents out of the record for ordinary inputs too.
  assert.equal(elementLabel(el("INPUT", { type: "submit", value: "Pay now" })), undefined);
  assert.equal(elementLabel(el("INPUT", { type: "text", value: "my home address" })), undefined);
});

test("page text is collapsed and truncated honestly", () => {
  // Lines are trimmed individually, so markup indentation does not show up as
  // a difference between two captures of the same page.
  assert.deepEqual(normalizePageText("  a \t b \n\n\n c  "), { text: "a b\n\nc", truncated: false });
  const big = normalizePageText("y".repeat(MAX_PAGE_TEXT_LENGTH + 500));
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, MAX_PAGE_TEXT_LENGTH);
});

test("malformed observations are rejected rather than repaired", () => {
  const good = { type: "interaction", kind: "click", role: "button", url: "https://a.test/", at: 1 };
  assert.equal(isWellFormedObservation(good), true);
  assert.equal(isWellFormedObservation({ ...good, kind: "keystroke" }), false);
  assert.equal(isWellFormedObservation({ ...good, url: "" }), false);
  assert.equal(isWellFormedObservation({ ...good, at: Number.NaN }), false);
  assert.equal(isWellFormedObservation({ ...good, label: 42 }), false);
  assert.equal(isWellFormedObservation(null), false);
  assert.equal(isWellFormedObservation({ type: "page_text", url: "https://a.test/", at: 1 }), false);
});

test("redaction matches on a label boundary, not a bare suffix", () => {
  assert.equal(isRedactedUrl("https://secure.chase.com/accounts"), true);
  assert.equal(isRedactedUrl("https://chase.com/"), true);
  assert.equal(isRedactedUrl("https://notchase.com/"), false, "suffix must not match mid-label");
  assert.equal(isRedactedUrl("https://github.com/"), false);
  assert.equal(isRedactedUrl("not a url"), false);
  assert.equal(isRedactedUrl("file:///etc/passwd"), false, "only http(s) is a web page");
  assert.equal(redactionRuleFor("https://1password.com/vault")?.category, "password-manager");
  assert.equal(redactionRuleFor("https://accounts.google.com/signin")?.category, "authentication");
});

test("partition round-trips to the profile that owns it", () => {
  for (const id of ["identity-default", "identity-00000000-0000-4000-8000-000000000001"]) {
    assert.equal(identityIdFromPartition(partitionForBrowserIdentity(id)), id);
  }
  assert.equal(identityIdFromPartition("persist:something-else"), null);
  assert.equal(identityIdFromPartition("persist:identity-../../escape"), null);
  assert.equal(identityIdFromPartition(undefined), null);
});

function store(rootDir: string, lines: string[]) {
  return new BrowserObservationStore({
    rootDir,
    appendFile: (_file, line) => { lines.push(line); },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
}

test("redacted sites keep the visit and lose the page text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
  const lines: string[] = [];
  const s = store(root, lines);
  try {
    const outcome = s.record("identity-a", {
      type: "page_text",
      url: "https://secure.chase.com/summary",
      title: "Accounts",
      text: "Checking balance $12,345.67",
      truncated: false,
      at: 1,
    });
    assert.deepEqual(outcome, { written: true, redacted: true });

    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.redacted, true);
    assert.equal(entry.observation.text, "", "page text must not survive redaction");
    assert.equal(entry.observation.url, "https://secure.chase.com/summary", "the visit is still recorded");
    assert.ok(!lines[0]!.includes("12,345"), "no balance anywhere in the written line");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repeated page text is not written twice, and a real change is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
  const lines: string[] = [];
  const s = store(root, lines);
  const page = { type: "page_text" as const, url: "https://work.test/t/1", title: "T", truncated: false, at: 1 };
  try {
    assert.deepEqual(s.record("identity-a", { ...page, text: "first" }), { written: true, redacted: false });
    assert.deepEqual(s.record("identity-a", { ...page, text: "first" }), { written: false, reason: "duplicate" });
    assert.deepEqual(s.record("identity-a", { ...page, text: "second" }), { written: true, redacted: false });
    assert.equal(lines.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the store refuses unusable profile ids and malformed observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
  const lines: string[] = [];
  const s = store(root, lines);
  try {
    const click = { type: "interaction", kind: "click", role: "button", url: "https://a.test/", at: 1 };
    assert.deepEqual(s.record("../../escape", click), { written: false, reason: "unknown-profile" });
    assert.deepEqual(s.record("identity-a", { type: "nonsense" }), { written: false, reason: "malformed" });
    assert.equal(lines.length, 0, "nothing rejected may reach disk");

    assert.deepEqual(s.record("identity-a", click), { written: true, redacted: false });
    assert.equal(s.fileFor("identity-a"), path.join(root, "identity-a.jsonl"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("popups open on the canvas, except where only the real browser can finish", () => {
  const authHosts = ["accounts.google.com", "login.microsoftonline.com"];
  const isAuthBlocked = (url: string) => authHosts.some((h) => url.includes(h));
  const isSafeExternal = (url: string) => url.startsWith("https://") || url.startsWith("http://");
  const resolve = (url: string, profileId: string | undefined) =>
    resolvePopupDisposition({ url, profileId, isAuthBlocked, isSafeExternal });

  // The case the whole change exists for: an ordinary target="_blank" stays.
  assert.deepEqual(resolve("https://docs.test/page", "identity-a"), {
    action: "canvas-node",
    url: "https://docs.test/page",
    profileId: "identity-a",
  });

  // Sign-in must still leave, or it lands on a dead-end page inside the node.
  assert.deepEqual(resolve("https://accounts.google.com/signin", "identity-a"), {
    action: "system-browser",
    url: "https://accounts.google.com/signin",
    reason: "auth",
  });

  // A guest with no profile of ours has no partition to inherit.
  assert.deepEqual(resolve("https://docs.test/page", undefined), {
    action: "system-browser",
    url: "https://docs.test/page",
    reason: "no-profile",
  });

  // A canvas tile is not a safer home for a hostile scheme than anywhere else.
  assert.deepEqual(resolve("file:///etc/passwd", "identity-a"), { action: "ignore" });
  assert.deepEqual(resolve("javascript:alert(1)", "identity-a"), { action: "ignore" });
  assert.deepEqual(resolve("javascript:alert(1)", undefined), { action: "ignore" });

  // Auth on an unsafe scheme is refused rather than opened for being auth.
  assert.deepEqual(
    resolve("javascript:fetch('//accounts.google.com')", "identity-a"),
    { action: "ignore" },
  );
});

test("a live page is not recorded once per render", () => {
  // Shapes taken from a real session, where exact-match de-duplication let one
  // page be written 104 times.
  const base = "y".repeat(6806);
  assert.equal(isNearDuplicateText(base, base + "7"), true, "a ticking counter is the same screen");
  // Similarity is proportional, so a badge tick is noise in a real page and
  // meaningful in a tiny one. Page text is thousands of characters; a 16-char
  // "page" where one character is 6% of the content is correctly a change.
  const inbox = (n: number) => `Inbox (${n})\n` + "message subject line\n".repeat(60);
  assert.equal(isNearDuplicateText(inbox(3), inbox(4)), true, "an unread badge is not news");
  assert.equal(isNearDuplicateText("Inbox (3)", "Inbox (4)"), false, "but in nine characters it is");
  assert.equal(isNearDuplicateText(`spinner ${"z".repeat(400)} end`, `spinnee ${"z".repeat(400)} end`), true);

  // But a reply actually arriving must survive: this is the case the rate
  // limit alone would lose, and the whole point of the record.
  assert.equal(isNearDuplicateText("Conversation with Gemini", "Conversation with Gemini\n\nHere is the answer"), false);
  assert.equal(isNearDuplicateText("a".repeat(100), "b".repeat(100)), false);
  assert.equal(isNearDuplicateText("", "anything"), false);
  assert.equal(isNearDuplicateText("same", "same"), true);
});

test("the store drops re-renders but keeps a page that changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
  const lines: string[] = [];
  const s = store(root, lines);
  const page = { type: "page_text" as const, url: "https://chat.test/c/1", title: "T", truncated: false, at: 1 };
  try {
    assert.equal(s.record("identity-a", { ...page, text: "Reply: " + "x".repeat(500) }).written, true);
    // Same screen, one character different — the case that used to be written.
    assert.equal(
      s.record("identity-a", { ...page, text: "Reply: " + "x".repeat(500) + "y" }).written,
      false,
    );
    // Genuinely new content.
    assert.equal(s.record("identity-a", { ...page, text: "Reply: " + "z".repeat(900) }).written, true);
    // Same text, different page: a different screen, so it is recorded.
    assert.equal(
      s.record("identity-a", { ...page, url: "https://chat.test/c/2", text: "Reply: " + "z".repeat(900) }).written,
      true,
    );
    assert.equal(lines.length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
