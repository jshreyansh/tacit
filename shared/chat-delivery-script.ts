/**
 * The script that puts a reply into a chat page and sends it.
 *
 * Built as one string and evaluated once, because that is the only thing that
 * works. Typing and submitting split across separate evaluations lets the page
 * lose focus in between, and the send silently does nothing — leaving the text
 * sitting in the composer looking delivered. That failure was observed before
 * this existed, so atomicity is the whole design constraint, not a nicety.
 *
 * The candidate scoring is stringified in from shared/chat-delivery.ts rather
 * than rewritten here, so the page and the unit tests cannot drift apart. That
 * is also why those functions must stay closure-free.
 */

import { scoreChatInput } from "./chat-delivery";

/**
 * Everything the script needs, serialized in. Kept to plain data so the whole
 * payload survives `JSON.stringify` into an `executeJavaScript` string.
 */
export interface ChatDeliveryRequest {
  text: string;
  /** A box the user pointed at for this host; tried before the heuristic. */
  selector?: string;
  /** Submit after typing. False types and stops, for testing a target safely. */
  submit?: boolean;
}

/**
 * The result shape the script resolves with. Mirrors ChatDeliveryOutcome's
 * reasons so the caller can map it without interpreting free text.
 */
export interface ChatDeliveryScriptResult {
  ok: boolean;
  reason?: "no-input-found" | "page-not-ready" | "empty-reply" | "submit-failed";
  /** Which route found the box, for telling the user why it went where it did. */
  via?: "override" | "heuristic";
}

export function buildChatDeliveryScript(request: ChatDeliveryRequest): string {
  const payload = JSON.stringify({
    text: request.text,
    selector: request.selector ?? null,
    submit: request.submit !== false,
  });

  // An async IIFE: executeJavaScript resolves the completion value, and the
  // awaits between typing and sending are what let a framework-controlled
  // composer register the input before the Enter arrives.
  return `(async () => {
  const req = ${payload};
  const score = ${String(scoreChatInput)};

  if (!document.body) return { ok: false, reason: "page-not-ready" };
  if (!req.text || !req.text.trim()) return { ok: false, reason: "empty-reply" };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  const SEND = /send|submit|post|ask|prompt|arrow/i;
  const nearbySend = (el) => {
    // Two hops up covers the usual composer wrapper without walking into the
    // page chrome, where every unrelated button would count as a send.
    let scope = el.parentElement?.parentElement ?? el.parentElement ?? document.body;
    const buttons = scope.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
      if (SEND.test(label) || b.getAttribute("type") === "submit") return true;
      if (!label && b.querySelector("svg") && visible(b)) return true;
    }
    return false;
  };

  let target = null;
  let via = "heuristic";

  if (req.selector) {
    try {
      const chosen = document.querySelector(req.selector);
      if (chosen && visible(chosen)) { target = chosen; via = "override"; }
    } catch {
      // A selector the user's page no longer matches: fall through to the
      // heuristic rather than failing, so a site redesign degrades instead of
      // breaking outright.
    }
  }

  if (!target) {
    const nodes = Array.from(document.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], input[type="search"]'
    )).filter(visible);
    const vh = window.innerHeight || 1;
    const candidates = nodes.map((el) => {
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      return {
        tag,
        editable: el.isContentEditable === true,
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.readOnly === true,
        width: r.width,
        height: r.height,
        bottomGap: vh - r.top,
        viewportHeight: vh,
        hasNearbySend: nearbySend(el),
      };
    });
    let best = -Infinity, bestIndex = -1;
    candidates.forEach((c, i) => {
      const s = score(c);
      if (s === null || s <= best) return;
      best = s; bestIndex = i;
    });
    if (bestIndex >= 0) target = nodes[bestIndex];
  }

  if (!target) return { ok: false, reason: "no-input-found" };

  target.scrollIntoView({ block: "center" });
  target.focus();
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  // Two ways to fill a composer, because the sites differ: a real textarea
  // takes .value plus an input event, a contenteditable needs an insertion the
  // editor's own listeners will see.
  if (target.isContentEditable) {
    document.execCommand("selectAll", false, undefined);
    document.execCommand("insertText", false, req.text);
  } else {
    target.value = req.text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }

  await new Promise((r) => setTimeout(r, 120));

  const filled = target.isContentEditable
    ? (target.textContent || "").trim().length > 0
    : String(target.value || "").trim().length > 0;
  if (!filled) return { ok: false, reason: "no-input-found", via };

  if (!req.submit) return { ok: true, via };

  // Prefer the button: a real click is what the page expects, and Enter is
  // ambiguous in composers that use it for newlines.
  let sent = false;
  const scope = target.closest("form") ?? target.parentElement?.parentElement ?? document.body;
  for (const b of scope.querySelectorAll('button, [role="button"], input[type="submit"]')) {
    const label = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
    if (b.disabled) continue;
    if (SEND.test(label) || b.getAttribute("type") === "submit") { b.click(); sent = true; break; }
  }

  if (!sent) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    sent = true;
  }

  await new Promise((r) => setTimeout(r, 250));

  // Emptied means the page took it. Still full means it did not, and saying so
  // is better than reporting a send that never happened.
  const cleared = target.isContentEditable
    ? (target.textContent || "").trim().length === 0
    : String(target.value || "").trim().length === 0;
  return cleared ? { ok: true, via } : { ok: false, reason: "submit-failed", via };
})()`;
}
