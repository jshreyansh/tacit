/** The address bar's rules, as a browser's. Pure, so they're tested without one. */

const LOCAL = /^(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const HOST = /^(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}-]{2,}(?::\d+)?(?:[/?#]|$)/u;
const IP = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/;

/** Where what was typed goes: the address it is, or a search for it. Null for nothing. */
export function addressFor(typed: string): string | null {
  const s = typed.trim();
  if (!s) return null;
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  // This Mac's own servers are rarely https.
  if (LOCAL.test(s) && !/\s/.test(s)) return `http://${s}`;
  if ((HOST.test(s) || IP.test(s)) && !/\s/.test(s)) return `https://${s}`;
  // Words, and any other scheme (javascript:, file:), are looked up, never run.
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

/** An address as it reads: the site, then the rest, without what every address has. */
export function shownAddress(url: string): { site: string; rest: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { site: url, rest: "" };
    const rest = `${u.pathname}${u.search}${u.hash}`;
    return { site: u.host.replace(/^www\./, ""), rest: rest === "/" ? "" : rest };
  } catch {
    return { site: url, rest: "" };
  }
}
