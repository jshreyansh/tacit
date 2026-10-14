/**
 * Masks secrets in text before it is kept: the record's prompts and the
 * transcript copies (T4 step 3). A person pastes a one-time code or a
 * password into an agent now and then, and agents print keys they read;
 * none of that should outlive the moment in Tacit's own files.
 *
 * Each match is replaced by `[masked:<kind>]`, so a reader can see something
 * was there. The patterns never match quotes or backslashes, so masking a
 * line of JSON leaves it valid JSON.
 */

export type MaskKind = "otp" | "password" | "key" | "token" | "private_key";

interface MaskRule {
  kind: MaskKind;
  pattern: RegExp;
  /** The capture group holding the secret; the rest of the match is kept. */
  group?: number;
}

// A secret's characters: anything but whitespace, quotes and backslashes.
const VALUE = String.raw`[^\s"'\\]+`;

const RULES: readonly MaskRule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // Provider keys with a recognisable shape.
  {
    kind: "key",
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  },
  // JSON web tokens: three base64url parts, the first two starting `eyJ`.
  { kind: "token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "token", pattern: new RegExp(String.raw`(\bBearer\s+)(${VALUE})`, "gi"), group: 2 },
  // "password: hunter2", "pwd=…", "my password is …".
  {
    kind: "password",
    pattern: new RegExp(String.raw`(\b(?:password|passwd|passphrase|pwd)\b(?:\s*[:=]\s*|\s+is\s+))(${VALUE})`, "gi"),
    group: 2,
  },
  // A 4–8 digit code near a word that says it is one: "OTP 482913",
  // "your verification code is 4829-13", "2FA: 123 456".
  {
    kind: "otp",
    pattern:
      /(\b(?:otp|one[- ]time (?:code|password|passcode)|verification code|security code|auth(?:entication)? code|login code|2fa(?: code)?|passcode|pin)\b[^\d\n]{0,20})(\d(?:[ -]?\d){3,7})\b/gi,
    group: 2,
  },
];

/** The text with every secret it holds replaced by `[masked:<kind>]`. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match, ...groups: unknown[]) => {
      if (rule.group === undefined) return `[masked:${rule.kind}]`;
      const secret = groups[rule.group - 1];
      if (typeof secret !== "string" || secret.startsWith("[masked:")) return match;
      const prefix = rule.group > 1 ? String(groups[0] ?? "") : "";
      return `${prefix}[masked:${rule.kind}]`;
    });
  }
  return out;
}
