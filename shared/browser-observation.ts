/**
 * What a browser node reports about the work happening inside it.
 *
 * This is tier 2 of the record (docs/architecture/browser-profile-adoption.md).
 * The decision record in shared/capture.ts deliberately holds choice points
 * rather than activity — clicks and page text are activity, and inlining them
 * there would bury the choices that make it worth mining. So observations flow
 * into a separate per-profile stream and are *referenced* from tier 1.
 *
 * Everything here crosses out of a page that the user is logged into, which
 * makes two rules absolute:
 *
 *  - No field value ever leaves the page. Not passwords, not card numbers, not
 *    ordinary text inputs. We record that a field was filled and what it was
 *    called, never what was typed into it. There is no allowlist, because an
 *    allowlist is a list of things someone will eventually get wrong.
 *  - Interactions are identified by role and accessible label, never by
 *    coordinates. "Clicked button: Approve" is knowledge; a pixel is not.
 *
 * The functions here are pure so the masking rules can be tested without a
 * browser, which is the only way they stay honest.
 */

/** Renderer→main channel. Guests post on this; nothing is exposed to the page. */
export const BROWSER_OBSERVATION_CHANNEL = "browser:observation";

/** Longest accessible label kept. Labels are identifiers, not content. */
export const MAX_LABEL_LENGTH = 120;

/** Longest page text kept per observation. Beyond this the tail is dropped. */
export const MAX_PAGE_TEXT_LENGTH = 20_000;

export type BrowserInteractionKind =
  | "click"
  /** A form was submitted. Never carries what was in it. */
  | "submit"
  /** Enter pressed in a field — the commit, not the content. */
  | "key_commit"
  /** Reached a new depth in the page; sent on settle, not per frame. */
  | "scroll";

export interface BrowserInteractionObservation {
  type: "interaction";
  kind: BrowserInteractionKind;
  /** ARIA role, explicit or derived from the tag. */
  role: string;
  /** Accessible name. Absent when the element has no name worth recording. */
  label?: string;
  /** Present for links and form targets; same-origin or not, it is a location. */
  href?: string;
  /** 0–100, only on `scroll`. */
  depth?: number;
  url: string;
  at: number;
}

export interface BrowserPageTextObservation {
  type: "page_text";
  url: string;
  title: string;
  /** Visible text. Input values are structurally absent from this. */
  text: string;
  truncated: boolean;
  at: number;
}

export type BrowserObservation =
  | BrowserInteractionObservation
  | BrowserPageTextObservation;

/**
 * Input types whose mere presence we refuse to describe in any detail beyond
 * "a secret field". The label of a password box is safe ("Password"); this
 * list exists so nothing downstream is tempted to treat them as ordinary.
 */
const SECRET_INPUT_TYPES = new Set(["password"]);

/** Autocomplete tokens that mark payment and identity fields. */
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i;

/**
 * Minimal shape of a DOM element, so the rules below can be exercised in a
 * plain node test. The real preload passes an actual Element.
 */
export interface ObservableElement {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent?: string | null;
}

/** True when the element handles a secret and must never be described richly. */
export function isSecretField(el: ObservableElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (SECRET_INPUT_TYPES.has(type)) return true;
  const autocomplete = el.getAttribute("autocomplete") ?? "";
  return SECRET_AUTOCOMPLETE.test(autocomplete);
}

/**
 * The element's role. Explicit `role` wins; otherwise it is derived from the
 * tag, because a record full of `div` teaches nothing.
 */
export function elementRole(el: ObservableElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().toLowerCase().split(/\s+/)[0] ?? "generic";
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a": return el.getAttribute("href") ? "link" : "generic";
    case "button": return "button";
    case "select": return "combobox";
    case "textarea": return "textbox";
    case "summary": return "button";
    case "option": return "option";
    case "form": return "form";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    default: return tag;
  }
}

/** Collapse whitespace and cap length. Labels are identifiers, not prose. */
export function normalizeLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The element's accessible name, in the order a screen reader would resolve it.
 *
 * `value` is deliberately absent from this chain even for buttons, where it
 * would be a caption: allowing a value read for one input type is how field
 * contents eventually leak from another. Buttons carry their caption in
 * textContent or aria-label anyway.
 */
export function elementLabel(
  el: ObservableElement,
  lookupLabelFor?: (id: string) => string | null,
): string | undefined {
  const aria = normalizeLabel(el.getAttribute("aria-label"));
  if (aria) return aria;

  const id = el.getAttribute("id");
  if (id && lookupLabelFor) {
    const associated = normalizeLabel(lookupLabelFor(id));
    if (associated) return associated;
  }

  const title = normalizeLabel(el.getAttribute("title"));
  if (title) return title;

  // A secret field stops here: its placeholder and surrounding text are safe,
  // but there is no reason to reach further into a page for a name when the
  // element is, by construction, the one place a secret is being typed.
  if (isSecretField(el)) return normalizeLabel(el.getAttribute("placeholder"));

  const text = normalizeLabel(el.textContent);
  if (text) return text;

  return normalizeLabel(el.getAttribute("placeholder"))
    ?? normalizeLabel(el.getAttribute("name"))
    ?? undefined;
}

/** Cap page text, reporting honestly whether anything was dropped. */
export function normalizePageText(raw: string): { text: string; truncated: boolean } {
  const collapsed = raw.replace(/[ \t ]+/g, " ")
    // Trim each line as well as the whole: innerText carries the markup's
    // indentation, and a diff of two captures should reflect a change in what
    // the page said, not in how it was laid out.
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (collapsed.length <= MAX_PAGE_TEXT_LENGTH) {
    return { text: collapsed, truncated: false };
  }
  return { text: collapsed.slice(0, MAX_PAGE_TEXT_LENGTH), truncated: true };
}

/**
 * Whether an observation is structurally safe to record.
 *
 * A last gate before anything is written, so a mistake in the preload cannot
 * quietly become a line in the user's record. It rejects rather than sanitizes:
 * an observation that should not have been built is a bug to find, not a value
 * to repair.
 */
export function isWellFormedObservation(value: unknown): value is BrowserObservation {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.url !== "string" || !o.url) return false;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return false;

  if (o.type === "interaction") {
    if (typeof o.role !== "string" || !o.role) return false;
    if (o.label !== undefined && typeof o.label !== "string") return false;
    if (o.href !== undefined && typeof o.href !== "string") return false;
    if (o.depth !== undefined && typeof o.depth !== "number") return false;
    return (
      o.kind === "click" ||
      o.kind === "submit" ||
      o.kind === "key_commit" ||
      o.kind === "scroll"
    );
  }
  if (o.type === "page_text") {
    return (
      typeof o.title === "string" &&
      typeof o.text === "string" &&
      typeof o.truncated === "boolean"
    );
  }
  return false;
}
