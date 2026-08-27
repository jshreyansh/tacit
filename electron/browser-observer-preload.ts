/**
 * Runs inside every page loaded in a managed browser node.
 *
 * This file is the reason `will-attach-webview` no longer deletes the guest
 * preload. It is also the most exposed code in the app: it executes inside
 * pages the user is genuinely logged into, so two properties are structural
 * rather than best-effort.
 *
 *  - **It gives the page nothing.** There is no `contextBridge` call here and
 *    no global is assigned. With `contextIsolation` on, the page cannot reach
 *    `ipcRenderer` or anything else in this scope. A page that wants to talk to
 *    Tacit has no channel to do it on.
 *  - **It never changes what the page does.** Every listener is passive and in
 *    the capture phase, nothing calls `preventDefault` or `stopPropagation`,
 *    and every handler is wrapped so a throw inside observation cannot surface
 *    as a broken click. Recording is allowed to fail; the user's work is not.
 *
 * Field values are never read — see shared/browser-observation.ts for why there
 * is no allowlist. What leaves here is an element's role, its accessible name,
 * and the visible text of the page.
 */

import { ipcRenderer } from "electron";
import {
  BROWSER_OBSERVATION_CHANNEL,
  elementLabel,
  elementRole,
  normalizePageText,
  type BrowserInteractionKind,
  type BrowserObservation,
} from "../shared/browser-observation";

/** Page text is re-read this long after things stop changing. */
const TEXT_SETTLE_MS = 1_200;
/** Scroll depth is reported this long after scrolling stops. */
const SCROLL_SETTLE_MS = 600;
/** Below this change in depth, a scroll is not worth an entry. */
const SCROLL_MIN_DELTA = 15;

function post(observation: BrowserObservation): void {
  try {
    ipcRenderer.send(BROWSER_OBSERVATION_CHANNEL, observation);
  } catch {
    // The host may be tearing down. A lost observation is not an error the
    // page should ever learn about.
  }
}

/** Only observe real web pages: not about:blank, devtools, or file views. */
function isObservablePage(): boolean {
  const p = location.protocol;
  return p === "http:" || p === "https:";
}

/**
 * The thing the user meant to click, which is usually an ancestor of what they
 * actually hit — the span inside the button, the icon inside the link.
 */
function interactiveAncestor(start: Element | null): Element | null {
  let el: Element | null = start;
  for (let depth = 0; el && depth < 12; depth += 1) {
    const tag = el.tagName.toLowerCase();
    if (
      tag === "a" || tag === "button" || tag === "select" ||
      tag === "textarea" || tag === "input" || tag === "summary" ||
      el.hasAttribute("role") ||
      el.hasAttribute("onclick") ||
      (el as HTMLElement).tabIndex >= 0
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return start;
}

/** Resolve a `<label for=id>` the way the accessibility tree would. */
function labelTextFor(id: string): string | null {
  try {
    const escaped = (window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&"));
    return document.querySelector(`label[for="${escaped}"]`)?.textContent ?? null;
  } catch {
    return null;
  }
}

function describe(el: Element): { role: string; label?: string; href?: string } {
  const role = elementRole(el);
  const label = elementLabel(el, labelTextFor);
  const rawHref = el.getAttribute("href");
  let href: string | undefined;
  if (rawHref) {
    try {
      href = new URL(rawHref, location.href).toString();
    } catch {
      href = undefined;
    }
  }
  return { role, label, href };
}

function emitInteraction(
  kind: BrowserInteractionKind,
  el: Element | null,
  extra?: { depth?: number },
): void {
  const described = el ? describe(el) : { role: "document" as const, label: undefined, href: undefined };
  post({
    type: "interaction",
    kind,
    role: described.role,
    ...(described.label ? { label: described.label } : {}),
    ...(described.href ? { href: described.href } : {}),
    ...(extra?.depth !== undefined ? { depth: extra.depth } : {}),
    url: location.href,
    at: Date.now(),
  });
}

/** Wrap a listener so observation can never break the interaction it watches. */
function safely<E extends Event>(handler: (event: E) => void): (event: E) => void {
  return (event: E) => {
    try {
      handler(event);
    } catch {
      // Deliberately silent: a console error here would appear to the user as
      // the page misbehaving, for something the page did not do.
    }
  };
}

let lastText = "";
let textTimer: ReturnType<typeof setTimeout> | undefined;

function capturePageText(): void {
  try {
    const body = document.body;
    if (!body) return;
    // innerText is what a person can actually see, and input values are
    // structurally absent from it — an important part of why no masking pass
    // is needed here.
    const { text, truncated } = normalizePageText(body.innerText ?? "");
    if (!text || text === lastText) return;
    lastText = text;
    post({
      type: "page_text",
      url: location.href,
      title: document.title ?? "",
      text,
      truncated,
      at: Date.now(),
    });
  } catch {
    // Some pages throw on innerText mid-teardown.
  }
}

function scheduleTextCapture(): void {
  if (textTimer) clearTimeout(textTimer);
  textTimer = setTimeout(capturePageText, TEXT_SETTLE_MS);
}

function scrollDepth(): number {
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  if (scrollable <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((window.scrollY / scrollable) * 100)));
}

function install(): void {
  if (!isObservablePage()) return;

  document.addEventListener("click", safely((event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    emitInteraction("click", interactiveAncestor(target));
  }), { capture: true, passive: true });

  document.addEventListener("submit", safely((event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    emitInteraction("submit", target);
  }), { capture: true, passive: true });

  document.addEventListener("keydown", safely((event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    const editable = tag === "input" || tag === "textarea" ||
      (target as HTMLElement).isContentEditable;
    if (!editable) return;
    // The commit, never the content: `describe` cannot read a value.
    emitInteraction("key_commit", target);
  }), { capture: true, passive: true });

  let lastDepth = 0;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("scroll", safely(() => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const depth = scrollDepth();
      if (Math.abs(depth - lastDepth) < SCROLL_MIN_DELTA) return;
      lastDepth = depth;
      emitInteraction("scroll", null, { depth });
    }, SCROLL_SETTLE_MS);
  }), { capture: true, passive: true });

  // Page text: once the page settles, and again when a single-page app has
  // replaced the view without a navigation.
  scheduleTextCapture();
  window.addEventListener("load", safely(scheduleTextCapture), { passive: true });

  try {
    const observer = new MutationObserver(() => { scheduleTextCapture(); });
    const start = () => {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", safely(start), { once: true });
  } catch {
    // Without a MutationObserver we still capture on load; SPA views will be
    // missed rather than the whole page.
  }
}

install();
