/**
 * The readable words of a matched session line: the text of a message,
 * pulled out of the JSON it's stored in. Null for lines that are plumbing
 * (system reminders, tool results, tool lists) rather than conversation.
 */
export function readableSessionSnippet(preview: string): string | null {
  let text = preview.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    if (/"type"\s*:\s*"tool_result"|"tool_use_id"/.test(text)) return null;
    const m = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return null;
    text = m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || /^<(system-reminder|command-|local-command)/.test(text)) return null;
  if (/^(# Environment|The following tools just became available)/.test(text)) return null;
  return text;
}
