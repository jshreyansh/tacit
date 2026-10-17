/**
 * The last few lines worth reading on a terminal's screen, for its card in
 * the workdesk grid. An agent's screen is mostly its own interface (the
 * input box, footer hints, rules), so those go: what's left is what it
 * said and did.
 */

const BOX = /[─-╿▀-▟]/g;
/** Footer hints and status lines agents draw under their input box. */
const CHROME = [
  /^\?\s+for shortcuts/i,
  /^esc to interrupt/i,
  /\bctrl\+[a-z] to\b/i,
  /^⏵⏵/,
  /^shift\+tab to/i,
  /^\s*>\s*$/,
  /^Try "/,
];

export function cleanTailLines(lines: readonly string[], max = 6): string[] {
  const kept: string[] = [];
  for (const raw of lines) {
    // Text inside an input box keeps its words, not its borders.
    const line = raw.replace(/^\s*[│┃]\s?/, "").replace(/\s?[│┃]\s*$/, "").trimEnd();
    const words = line.replace(BOX, "").trim();
    if (words.length < 2) continue;
    if (CHROME.some((pattern) => pattern.test(words))) continue;
    kept.push(line.trim().length > 160 ? `${line.trim().slice(0, 159)}…` : line.trim());
  }
  return kept.slice(-max);
}
