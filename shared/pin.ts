export type PinStatus = "open" | "done" | "dropped";

export interface PinLink {
  type: string;
  url: string;
  id?: string;
}

export interface Pin {
  id: string;
  title: string;
  status: PinStatus;
  repo: string;
  body: string;
  links: PinLink[];
  created: string;
  updated: string;
  /**
   * Absolute file:// URL pointing to the directory containing this pin's
   * attachments. Populated only on pins served via IPC; not part of on-disk
   * frontmatter.
   */
  attachmentsUrl?: string;
  /**
   * Canvas position/size, in flow coordinates — optional so existing
   * file-backed pins with no spatial data keep working exactly as before
   * (list/drawer-only). A pin with x/y set renders as a draggable note on
   * the canvas (see src/canvas/PinNode.tsx); one without them doesn't.
   */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface CreatePinInput {
  title: string;
  repo: string;
  body?: string;
  status?: PinStatus;
  links?: PinLink[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface UpdatePinInput {
  title?: string;
  status?: PinStatus;
  body?: string;
  links?: PinLink[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function normalizePinBodyInput(body: string): string {
  const trimmed = body.trim();
  if (!shouldDecodeEscapedLineBreaks(trimmed)) return trimmed;
  return trimmed
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function shouldDecodeEscapedLineBreaks(text: string): boolean {
  const escapedLineBreaks = text.match(/(?:\\r\\n|\\n)/g)?.length ?? 0;
  if (escapedLineBreaks >= 2) return true;
  return /(?:\\r\\n|\\n)(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/.test(text);
}

function usesCjk(text: string): boolean {
  return /[㐀-鿿]/u.test(text);
}

/**
 * What an agent is told when a pin is handed to it: the pin is context, not
 * something to record again. Shared by a pin dropped on a terminal and a pin
 * handed to the manager in the chat, so both say the same.
 */
export function pinTaskInstruction(pin: Pick<Pin, "title" | "body">): string {
  if (usesCjk(`${pin.title}\n${pin.body}`)) {
    return "这是一个已有的 Tacit pin，作为当前对话的上下文提供。不要把它再次记录为新的 pin；请根据用户的后续说明判断是执行、研究还是讨论。如果意图不明确，先询问下一步。";
  }
  return "This is an existing Tacit pin provided as context for the current conversation. Do not create or record it as a new pin; use the user's surrounding instructions to decide whether to execute, investigate, or discuss it. If the intent is unclear, ask what to do next.";
}

/** A pin as a message: the instruction, its title as a heading, then its body. */
export function pinHandoffText(pin: Pick<Pin, "title" | "body">): string {
  const title = pin.title.trim() ? `# ${pin.title.trim()}\n\n` : "";
  return `${pinTaskInstruction(pin)}\n\n${title}${pin.body}`.trimEnd();
}
