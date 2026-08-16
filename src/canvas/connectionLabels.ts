/**
 * Human-readable names for the two ends of a connection, used by the
 * remove-connection confirmation so the dialog can say what it is about to
 * disconnect instead of asking the user to trust an unnamed "this".
 *
 * Kept as a pure function taking its data and its strings as arguments: the
 * label text is the whole point of the dialog, so it needs to be testable
 * without mounting the canvas.
 */
import type { BrowserCardData } from "../stores/browserCardStore";
import type { ConnectionEndpoint } from "../stores/connectionStore";
import type { Pin, ProjectData } from "../types";

/**
 * Longest label rendered before eliding. Page titles in particular run long
 * ("Element: wheel event - Web APIs | MDN"), and two of them in one sentence
 * stops being readable well before it stops fitting.
 */
export const MAX_ENDPOINT_LABEL_LENGTH = 40;

export function truncateLabel(
  text: string,
  max = MAX_ENDPOINT_LABEL_LENGTH,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export interface EndpointLabelStrings {
  /** Name for the terminal currently acting as workspace manager. */
  workspaceManager: string;
  /** Used when an endpoint's node can't be found (a stale wire). */
  unknownTerminal: string;
  unknownBrowser: string;
  unknownNote: string;
}

export interface EndpointLabelContext {
  projects: ProjectData[];
  browserCards: Record<string, BrowserCardData>;
  pins: Pin[];
  workspaceManagerTerminalId: string | null;
  strings: EndpointLabelStrings;
}

/** Host without `www.`, or null if the URL won't parse (about:blank, empty). */
function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

function describeTerminal(
  id: string,
  ctx: EndpointLabelContext,
): string {
  if (ctx.workspaceManagerTerminalId === id) {
    return ctx.strings.workspaceManager;
  }
  for (const project of ctx.projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find((term) => term.id === id);
      if (!terminal) continue;
      const base = terminal.customTitle || terminal.title || terminal.type;
      // A renamed terminal already says what it is; an unrenamed one is just
      // its CLI name ("claude"), which is ambiguous the moment there are two,
      // so qualify those with the worktree they're running in.
      const needsWorktree = !terminal.customTitle && !!worktree.name;
      return truncateLabel(
        needsWorktree ? `${base} · ${worktree.name}` : base,
      );
    }
  }
  return ctx.strings.unknownTerminal;
}

function describeBrowser(id: string, ctx: EndpointLabelContext): string {
  const card = ctx.browserCards[id];
  if (!card) return ctx.strings.unknownBrowser;
  const title = card.title?.trim();
  if (title) return truncateLabel(title);
  const host = hostnameOf(card.url);
  return host ? truncateLabel(host) : ctx.strings.unknownBrowser;
}

function describeNote(id: string, ctx: EndpointLabelContext): string {
  const pin = ctx.pins.find((candidate) => candidate.id === id);
  const title = pin?.title?.trim();
  return title ? truncateLabel(title) : ctx.strings.unknownNote;
}

export function describeEndpoint(
  endpoint: ConnectionEndpoint,
  ctx: EndpointLabelContext,
): string {
  switch (endpoint.kind) {
    case "terminal":
      return describeTerminal(endpoint.id, ctx);
    case "browser":
      return describeBrowser(endpoint.id, ctx);
    case "note":
      return describeNote(endpoint.id, ctx);
  }
}
