/**
 * Which sites keep their page text out of the record.
 *
 * Observation is on for every imported profile, always — the alternative is a
 * switch you have to remember, and it gets forgotten at exactly the moment real
 * work starts. That choice is only livable because of this file: for a small
 * set of categories, Tacit still records *that* you were there and *what* you
 * clicked, and drops the page text.
 *
 * This is a default, not a policy. It is visible, editable, and can be emptied.
 * It is not a security boundary either — field values are masked in the preload
 * for every site regardless, because that boundary must not depend on a list
 * being right. This list is about contents, not credentials: your balance, your
 * diagnosis, your vault, as opposed to your password.
 *
 * Matching is on the registrable-ish suffix, so `chase.com` covers
 * `secure.chase.com`. Entries are deliberately few. A list long enough to feel
 * complete is a list nobody reads before trusting.
 */

export type RedactionCategory =
  | "banking"
  | "health"
  | "password-manager"
  | "authentication";

export interface RedactionRule {
  /** Host suffix, no scheme, no leading dot. */
  suffix: string;
  category: RedactionCategory;
}

/**
 * Seeded from categories, not from a scrape of popular sites: the point is that
 * a user reading this can predict what it does. Anything missing is one edit
 * away, and the sites people actually care about differ per person anyway.
 */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  // Password and secret managers — the highest-value text on the internet.
  { suffix: "1password.com", category: "password-manager" },
  { suffix: "bitwarden.com", category: "password-manager" },
  { suffix: "lastpass.com", category: "password-manager" },
  { suffix: "dashlane.com", category: "password-manager" },
  { suffix: "keeper.io", category: "password-manager" },
  { suffix: "vault.azure.net", category: "password-manager" },

  // Authentication surfaces. Their text is one-time codes and recovery
  // questions, which is the last thing that should sit in a log.
  { suffix: "accounts.google.com", category: "authentication" },
  { suffix: "login.microsoftonline.com", category: "authentication" },
  { suffix: "appleid.apple.com", category: "authentication" },
  { suffix: "okta.com", category: "authentication" },
  { suffix: "duosecurity.com", category: "authentication" },
  { suffix: "auth0.com", category: "authentication" },

  // Banking and payments.
  { suffix: "chase.com", category: "banking" },
  { suffix: "bankofamerica.com", category: "banking" },
  { suffix: "wellsfargo.com", category: "banking" },
  { suffix: "paypal.com", category: "banking" },
  { suffix: "stripe.com", category: "banking" },
  { suffix: "coinbase.com", category: "banking" },
  { suffix: "hdfcbank.com", category: "banking" },
  { suffix: "icicibank.com", category: "banking" },
  { suffix: "onlinesbi.sbi", category: "banking" },

  // Health.
  { suffix: "mychart.com", category: "health" },
  { suffix: "labcorp.com", category: "health" },
  { suffix: "questdiagnostics.com", category: "health" },
  { suffix: "practo.com", category: "health" },
];

/** Lowercased hostname of a URL, or null when it is not a parseable web URL. */
export function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * The rule covering this URL, if any.
 *
 * Suffix matching is anchored on a label boundary so `notchase.com` does not
 * match `chase.com` — the classic way a suffix list quietly stops working.
 */
export function redactionRuleFor(
  url: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): RedactionRule | null {
  const host = hostnameOf(url);
  if (!host) return null;
  for (const rule of rules) {
    const suffix = rule.suffix.toLowerCase();
    if (host === suffix || host.endsWith(`.${suffix}`)) return rule;
  }
  return null;
}

/** Whether this URL's page text must be dropped before it reaches the record. */
export function isRedactedUrl(
  url: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): boolean {
  return redactionRuleFor(url, rules) !== null;
}
