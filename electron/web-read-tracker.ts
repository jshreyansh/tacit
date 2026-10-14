import type { WebRead } from "../shared/capture";

/**
 * Which terminals have read web content, and when, so a journal or memory
 * write can say whether a web page could have shaped it (SHR-63). The journal
 * is shared across agents: without this, a page could plant text the next
 * manager trusts, and nothing afterwards could tell that note from any other.
 * Nothing acts on the flag yet; T7 will.
 *
 * Web content arrives two ways: a Tacit browser tile the agent drove (read,
 * eval and navigate hand page text back to it), and the agent's own web tools
 * (Claude's WebFetch, OpenCode's webfetch, a browser MCP server), seen
 * through hooks and session telemetry. A shell `curl` is not seen; shell
 * commands are left out of the record (T4 decision 4).
 *
 * "Tainted" follows the ticket: a web read in the agent's current turn, which
 * began at its latest prompt. The latest read at all is kept beside it, so a
 * page read one turn and written about the next is still visible.
 */

/** Tacit browser actions whose result carries page text back to the agent. */
const CONTENT_ACTIONS = new Set(["read", "eval", "navigate"]);

/** Agents' own web tools: Claude WebFetch/WebSearch, Codex web_search, OpenCode webfetch. */
const WEB_TOOL = /^(web_?fetch|web_?search|fetch_?url|search_?web)$/i;
/** Another MCP server's tools that read the web. Tacit's own are seen as browser actions. */
const WEB_MCP_TOOL = /^mcp__(?!tacit__).*(web|fetch|browser|chrome|playwright|puppeteer|crawl|scrape|firecrawl|tavily)/i;

export function isWebTool(name: string): boolean {
  return WEB_TOOL.test(name) || WEB_MCP_TOOL.test(name);
}

/** The most reads kept for one turn; the flag is set by the first. */
const MAX_READS_PER_TURN = 10;

export interface WebReadProvenance {
  tainted: boolean;
  /** The web reads in the current turn, oldest first. */
  taint_sources: WebRead[];
  /** The latest web read by this terminal in any turn, while Tacit was running. */
  last_web_read_at: string | null;
}

interface TerminalReads {
  turnStartedAt: number | null;
  reads: WebRead[];
  lastReadAt: string | null;
}

export class WebReadTracker {
  private readonly terminals = new Map<string, TerminalReads>();

  /** A prompt reached the terminal: its agent starts a new turn. */
  noteTurnStart(terminalId: string, at: string): void {
    const state = this.stateOf(terminalId);
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || (state.turnStartedAt !== null && ms < state.turnStartedAt)) return;
    state.turnStartedAt = ms;
    state.reads = state.reads.filter((read) => Date.parse(read.at) >= ms);
  }

  /** The terminal drove a Tacit browser tile. */
  noteBrowserAction(terminalId: string, read: { browser: string; action: string; url?: string; at: string }): void {
    if (!CONTENT_ACTIONS.has(read.action)) return;
    this.add(terminalId, {
      kind: "browser",
      source: read.browser,
      action: read.action,
      ...(read.url ? { url: read.url } : {}),
      at: read.at,
    });
  }

  /** The terminal's agent used a tool; only web tools count. */
  noteToolUse(terminalId: string, tool: string, at: string): void {
    if (!isWebTool(tool)) return;
    this.add(terminalId, { kind: "tool", source: tool, at });
  }

  provenance(terminalId: string): WebReadProvenance {
    const state = this.terminals.get(terminalId);
    const reads = state?.reads ?? [];
    return {
      tainted: reads.length > 0,
      taint_sources: reads.map((read) => ({ ...read })),
      last_web_read_at: state?.lastReadAt ?? null,
    };
  }

  forget(terminalId: string): void {
    this.terminals.delete(terminalId);
  }

  private add(terminalId: string, read: WebRead): void {
    const state = this.stateOf(terminalId);
    const ms = Date.parse(read.at);
    if (!Number.isFinite(ms)) return;
    if (!state.lastReadAt || ms > Date.parse(state.lastReadAt)) state.lastReadAt = read.at;
    // Read before this turn began: older news, kept only as the latest read.
    if (state.turnStartedAt !== null && ms < state.turnStartedAt) return;
    // A hook and the session file can both report one tool call.
    const same = state.reads.find(
      (seen) => seen.kind === read.kind && seen.source === read.source && seen.action === read.action && seen.url === read.url,
    );
    if (same) return;
    if (state.reads.length < MAX_READS_PER_TURN) state.reads.push(read);
  }

  private stateOf(terminalId: string): TerminalReads {
    let state = this.terminals.get(terminalId);
    if (!state) {
      state = { turnStartedAt: null, reads: [], lastReadAt: null };
      this.terminals.set(terminalId, state);
    }
    return state;
  }
}
