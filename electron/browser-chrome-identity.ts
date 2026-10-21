/**
 * How a browser node presents itself to websites: as the Chrome it is built
 * from, consistently, the way Chrome itself would (SHR-130).
 *
 * Electron gives itself away in ways Google's sign-in checks. Measured on
 * Electron 41 (Chromium 146): `navigator.userAgentData.brands` lists only
 * Chromium, the user agent carries the full version where Chrome sends the
 * reduced one, and no `Sec-CH-UA` headers are sent at all, where Chrome sends
 * them on every secure request. Stripping those hints is what an Obsidian
 * report traced Google's 401 "malformed" to. This module computes one
 * identity, and main applies it in both places that show it: the page (CDP
 * `Emulation.setUserAgentOverride`) and the request headers.
 *
 * Pure: main passes in the versions it reads from Electron and the OS.
 */

export interface ChromeIdentityInput {
  /** Chromium's full version, `process.versions.chrome`. */
  chromeVersion: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** The OS version Chrome reports, e.g. macOS's `26.3.0`. */
  platformVersion: string;
  /** `process.arch`. */
  arch: string;
  /** The app's locale, e.g. `en-US`. */
  locale: string;
}

export interface BrandVersion {
  brand: string;
  version: string;
}

/** CDP's `Emulation.UserAgentMetadata`. */
export interface UserAgentMetadata {
  brands: BrandVersion[];
  fullVersionList: BrandVersion[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

export interface ChromeIdentity {
  userAgent: string;
  /** For CDP, which adds the q-values itself: `en-US,en`. */
  acceptLanguage: string;
  /** `navigator.platform`. */
  navigatorPlatform: string;
  metadata: UserAgentMetadata;
}

// Chromium's GREASE brand: a deliberately odd brand name and version, chosen
// from the major version so it's stable for a release, which keeps sites from
// matching brand lists exactly (user_agent_utils.cc).
const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
// The order the three brands go in, also chosen from the major version.
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function greaseBrand(seed: number): BrandVersion {
  const brand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
  return { brand, version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length] };
}

function ordered<T>(seed: number, grease: T, chromium: T, chrome: T): T[] {
  const order = BRAND_ORDERS[seed % BRAND_ORDERS.length];
  const out: T[] = [];
  out[order[0]] = grease;
  out[order[1]] = chromium;
  out[order[2]] = chrome;
  return out;
}

function platformParts(platform: NodeJS.Platform): { ua: string; ch: string; navigator: string } {
  // Chrome freezes these in its reduced user agent, whatever the real OS
  // version is; the real version goes only in Sec-CH-UA-Platform-Version.
  if (platform === "darwin") return { ua: "Macintosh; Intel Mac OS X 10_15_7", ch: "macOS", navigator: "MacIntel" };
  if (platform === "win32") return { ua: "Windows NT 10.0; Win64; x64", ch: "Windows", navigator: "Win32" };
  return { ua: "X11; Linux x86_64", ch: "Linux", navigator: "Linux x86_64" };
}

export function chromeIdentity(input: ChromeIdentityInput): ChromeIdentity {
  const major = input.chromeVersion.split(".")[0];
  const seed = Number(major);
  const grease = greaseBrand(seed);
  const parts = platformParts(input.platform);
  const brands = ordered(seed, grease, { brand: "Chromium", version: major }, { brand: "Google Chrome", version: major });
  const fullVersionList = ordered(
    seed,
    { brand: grease.brand, version: `${grease.version}.0.0.0` },
    { brand: "Chromium", version: input.chromeVersion },
    { brand: "Google Chrome", version: input.chromeVersion },
  );
  const language = input.locale.split("-")[0];
  return {
    userAgent: `Mozilla/5.0 (${parts.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: language && language !== input.locale ? `${input.locale},${language}` : input.locale,
    navigatorPlatform: parts.navigator,
    metadata: {
      brands,
      fullVersionList,
      fullVersion: input.chromeVersion,
      platform: parts.ch,
      platformVersion: input.platformVersion,
      architecture: input.arch === "arm64" || input.arch === "arm" ? "arm" : "x86",
      model: "",
      mobile: false,
      bitness: input.arch === "ia32" || input.arch === "arm" ? "32" : "64",
      wow64: false,
      formFactors: ["Desktop"],
    },
  };
}

const brandList = (list: BrandVersion[]) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");

/** The hints Chrome sends on every secure request, asked for or not. */
const LOW_ENTROPY = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"];

/** Every client hint this identity can answer, by lower-case header name. */
export function clientHintValues(identity: ChromeIdentity): Record<string, string> {
  const m = identity.metadata;
  return {
    "sec-ch-ua": brandList(m.brands),
    "sec-ch-ua-mobile": m.mobile ? "?1" : "?0",
    "sec-ch-ua-platform": `"${m.platform}"`,
    "sec-ch-ua-full-version-list": brandList(m.fullVersionList),
    "sec-ch-ua-full-version": `"${m.fullVersion}"`,
    "sec-ch-ua-platform-version": `"${m.platformVersion}"`,
    "sec-ch-ua-arch": `"${m.architecture}"`,
    "sec-ch-ua-bitness": `"${m.bitness}"`,
    "sec-ch-ua-model": `"${m.model}"`,
    "sec-ch-ua-wow64": m.wow64 ? "?1" : "?0",
    "sec-ch-ua-form-factors": m.formFactors.map((f) => `"${f}"`).join(", "),
  };
}

/** The hint names an `Accept-CH` or `Critical-CH` response header asks for, lower-cased. */
export function parseAcceptCh(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(",") : value;
  return joined
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.startsWith("sec-ch-ua"));
}

/** Chrome sends client hints only to secure origins, localhost included. */
export function isSecureForHints(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || protocol === "wss:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * A request's headers as Chrome would send them: Electron's own user agent
 * replaced, the low-entropy hints always added, and the others only where the
 * origin asked for them. Whatever hints the request carried are replaced,
 * since Electron's own brand list doesn't match the identity.
 */
export function withChromeHeaders(
  headers: Record<string, string>,
  url: string,
  identity: ChromeIdentity,
  requested: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("sec-ch-ua")) continue;
    out[name] = lower === "user-agent" ? identity.userAgent : value;
  }
  if (!isSecureForHints(url)) return out;
  const values = clientHintValues(identity);
  for (const name of LOW_ENTROPY) out[name] = values[name];
  for (const name of requested) {
    if (values[name] !== undefined) out[name] = values[name];
  }
  return out;
}

/**
 * Sign-in origins whose hint requests are known before the first visit.
 * Chrome remembers an origin's `Accept-CH` across restarts, so a returning
 * Chrome sends these on its first request to sign-in; Tacit learns them per
 * launch, and this keeps a sign-in from being its first, hint-less request.
 * The list is Google's own `Accept-CH`, as its sign-in pages sent it on
 * 21 Oct 2026.
 */
const GOOGLE_SIGN_IN_HINTS = parseAcceptCh(
  "Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Full-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version",
);
export const SIGN_IN_ORIGINS_HINTS: Record<string, string[]> = {
  "https://accounts.google.com": GOOGLE_SIGN_IN_HINTS,
  "https://accounts.youtube.com": GOOGLE_SIGN_IN_HINTS,
};
