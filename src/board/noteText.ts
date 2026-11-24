/** How a note's words read: its first line is its name. */
/** Its first line with words in it. */
export function noteTitle(text: string, empty: string): string {
  const line = text.split("\n").find((l) => l.trim());
  return line ? line.trim().replace(/^#+\s*/, "").slice(0, 120) : empty;
}
/** What's under its first line. */
export function noteBody(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim());
  return first < 0 ? "" : lines.slice(first + 1).join("\n").trim();
}
