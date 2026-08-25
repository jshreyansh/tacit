import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest, getTerminalId } from "./client.ts";

/**
 * Tools are always registered — never added or removed mid-session — and
 * instead gate on whether a canvas connection currently exists (checked on
 * every call, not cached), matching how october.dev's own browser wiring
 * behaves: connect a terminal to a browser tile and the same always-present
 * tools start actually doing something. See src/actions/sceneConnectionActions.ts
 * for the other half — the system notice sent into the terminal on connect.
 */
const NOT_WIRED_MESSAGE =
  "Not wired to a browser yet. Call spawn_browser to open one already wired to you, or connect this terminal to an existing browser tile on the canvas (drag from its connector dot to the tile), then try again.";

// Workspace-manager-only tools (spawn/wire/journal) are gated live, per
// call, server-side in electron/api-server.ts's requireWorkspaceManager —
// not at session-registration time, so a role reassignment mid-session
// takes effect on the very next call for both the old and new holder. The
// resulting error (thrown from apiRequest on a 403) already carries a
// clear message; no separate client-side copy of it is needed here.

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function resolveBoundBrowserId(): Promise<string | null> {
  const terminalId = getTerminalId();
  if (!terminalId) return null;
  const { browserId } = await apiRequest<{ browserId: string | null }>(
    "GET",
    `/terminal/${encodeURIComponent(terminalId)}/browser-binding`,
  );
  return browserId;
}

async function driveBrowser(action: string, params: Record<string, unknown>) {
  const terminalId = getTerminalId();
  const browserId = await resolveBoundBrowserId();
  if (!browserId) return textResult(NOT_WIRED_MESSAGE);
  const result = await apiRequest(
    "POST",
    `/browser/${encodeURIComponent(browserId)}/action`,
    { action, params, actor: terminalId ? `terminal:${terminalId}` : "system" },
  );
  return textResult(JSON.stringify(result, null, 2));
}

export function createTermcanvasBridgeServer(): McpServer {
  const server = new McpServer({ name: "tacit", version: "0.1.0" });

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate wired browser",
      description:
        "Navigates the browser tile currently wired to this terminal to a new URL.",
      inputSchema: { url: z.string().describe("URL to navigate to") },
    },
    async ({ url }) => driveBrowser("navigate", { url }),
  );

  server.registerTool(
    "browser_read",
    {
      title: "Read wired browser",
      description:
        "Reads the current URL, title, and visible text of the browser tile wired to this terminal.",
      inputSchema: {},
    },
    async () => driveBrowser("read", {}),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click in wired browser",
      description:
        "Clicks the first element matching a CSS selector in the browser tile wired to this terminal.",
      inputSchema: {
        selector: z.string().describe("CSS selector of the element to click"),
      },
    },
    async ({ selector }) => driveBrowser("click", { selector }),
  );

  server.registerTool(
    "browser_eval",
    {
      title: "Run script in wired browser",
      description:
        "Runs arbitrary JavaScript in the page context of the browser tile wired to this terminal and returns the result. The primitive browser_read/browser_click are convenience wrappers over.",
      inputSchema: {
        script: z.string().describe("JavaScript to evaluate in the page"),
      },
    },
    async ({ script }) => driveBrowser("eval", { script }),
  );

  server.registerTool(
    "emit_event",
    {
      title: "Emit event to connected nodes",
      description:
        "Emits a named event (e.g. 'task-complete', 'found-result', 'error') to every canvas node connected to this terminal by a wire. A connected terminal receives it as a new prompt (prefixed with where it came from); a connected browser navigates there if payload.url is set. Use this to hand off work or share a result with another node on the canvas, instead of a raw tool call.",
      inputSchema: {
        type: z.string().describe("Event name, e.g. 'task-complete'"),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Optional data. `message` becomes the prompt text sent to a connected terminal; `url` navigates a connected browser.",
          ),
      },
    },
    async ({ type, payload }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/node/terminal/${encodeURIComponent(terminalId)}/emit`,
        { type, payload },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Save a durable note for this project",
      description:
        "Writes a durable note to this project's shared memory — readable by any other agent working on this project later, even without a live connection, and by future Claude sessions (it shows up in Tacit's own Memory tab). Use this for findings/decisions worth keeping, not transient status — use emit_event for that. Re-using the same `name` updates the note in place instead of creating a duplicate.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "kebab-case slug, e.g. 'auth-flow-decision' — used as the filename, and to update this note later",
          ),
        description: z
          .string()
          .describe("One-line summary shown in the Memory tab graph"),
        type: z
          .enum(["project", "feedback", "reference"])
          .describe(
            "project: a fact/decision about the work. feedback: a correction or preference learned. reference: a pointer to an external resource.",
          ),
        body: z.string().describe("The note content (markdown)"),
      },
    },
    async ({ name, description, type, body }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/remember`,
        { name, description, type, body },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "list_nodes",
    {
      title: "List every node on the canvas",
      description:
        "Lists every terminal, browser, and note on the current workspace's canvas — id, kind, position, size, type, and status. Open to any terminal, not just the workspace manager. Use this to see what already exists before spawning something new or connecting nodes.",
      inputSchema: {},
    },
    async () => {
      const result = await apiRequest("GET", "/workspace/nodes");
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "get_node_state",
    {
      title: "Get one node's live state",
      description:
        "Reads live detail on one specific node by kind and id — a terminal's title/status/worktree, a browser's current url/title, or a note's body. Open to any terminal.",
      inputSchema: {
        kind: z.enum(["terminal", "browser", "pin"]).describe("Node kind"),
        id: z.string().describe("Node id, from list_nodes"),
      },
    },
    async ({ kind, id }) => {
      const result = await apiRequest(
        "GET",
        `/workspace/node/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Search what has already been decided on this canvas",
      description:
        "Searches the decision record and the workspace journal together — what the user asked for, what got spawned and wired, what was tried and abandoned, and the notes past holders of the manager role wrote. Use it before starting something that might have been done already, and when the user refers to earlier work without saying which. Filters are exact and narrow the search rather than merely ranking it: pass `node` to see everything that ever happened to one terminal or browser, `kinds` to restrict to particular events, `since` to bound the time. Text that the app or the CLI injected is excluded unless asked for, so results are what a person actually said and did. Open to any terminal.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Words to search for; omit to list the most recent matches"),
        node: z
          .string()
          .optional()
          .describe("Only entries touching this node, e.g. 'browser:browser-123-4'"),
        kinds: z
          .array(z.enum(["prompt", "spawn", "wire", "unwire", "close", "rename", "manager", "topology", "note"]))
          .optional()
          .describe("Restrict to these kinds of entry"),
        since: z.string().optional().describe("ISO timestamp lower bound"),
        include_injected: z
          .boolean()
          .optional()
          .describe("Include app notices and harness messages; off by default"),
        limit: z.number().optional().describe("Max results, default 12"),
      },
    },
    async ({ query, node, kinds, since, include_injected, limit }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/recall`,
        { query, node, kinds, since, include_injected, limit },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "query_memory",
    {
      title: "Search durable memory",
      description:
        "Searches durable memory notes by keyword. Defaults to the workspace-wide memory scope (the workspace manager's own continuity journal, shared across every agent that ever holds the role) — pass scope='worktree' with a worktree path to search a specific project's per-worktree memory instead (the scope the plain `remember` tool writes to). Open to any terminal.",
      inputSchema: {
        query: z.string().describe("Keyword to search for; empty string lists everything in scope"),
        scope: z
          .enum(["workspace", "worktree"])
          .optional()
          .describe("Defaults to 'workspace'"),
        worktree: z
          .string()
          .optional()
          .describe("Required when scope is 'worktree' — absolute worktree path"),
      },
    },
    async ({ query, scope, worktree }) => {
      const params = new URLSearchParams({ q: query });
      if (scope) params.set("scope", scope);
      if (worktree) params.set("worktree", worktree);
      const result = await apiRequest(
        "GET",
        `/workspace/memory-query?${params.toString()}`,
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "get_workspace_summary",
    {
      title: "Get a workspace orientation summary",
      description:
        "The first call to make when picking up the workspace-manager role — whether freshly assigned or resuming after being reassigned back. Returns node counts by kind and status, the number of active connections, and the most recent entries from the workspace's continuity journal. Open to any terminal, but most useful to whichever one holds the role.",
      inputSchema: {},
    },
    async () => {
      const result = await apiRequest("GET", "/workspace/summary");
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  const positionSchema = z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Canvas position; omitted auto-places near this terminal");
  const connectToSchema = z
    .object({
      kind: z.enum(["terminal", "browser", "note"]),
      id: z.string(),
    })
    .optional()
    .describe(
      "Optional — connects the new node to a different existing node instead of to you. Omit it for the normal case: a spawned node is already linked back to you automatically.",
    );

  server.registerTool(
    "spawn_terminal",
    {
      title: "Spawn a new terminal (workspace manager only)",
      description:
        "Creates a new terminal on the canvas, running the given agent type. If a prompt is given, it's auto-submitted as the terminal's first message. Auto-placed near this terminal and linked to it in the family-tree view unless an explicit position is given. Only the workspace manager can call this.",
      inputSchema: {
        type: z
          .enum(["shell", "claude", "codex", "gemini", "lazygit"])
          .optional()
          .describe("Defaults to 'shell'"),
        prompt: z.string().optional().describe("Auto-submitted as the first message"),
        position: positionSchema,
        connectTo: connectToSchema,
      },
    },
    async ({ type, prompt, position, connectTo }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/spawn-terminal`,
        { type, prompt, position, connectTo },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "spawn_browser",
    {
      title: "Spawn a new browser tile (workspace manager only)",
      description:
        "Creates a new browser tile on the canvas pointed at a URL, wired to you and ready to drive with the browser_* tools immediately — no connect_nodes call needed. Spawning another browser moves that control to the new one. Pass connectTo to give the browser to a different node instead of taking it yourself. Only the workspace manager can call this.",
      inputSchema: {
        url: z.string().describe("URL to open"),
        position: positionSchema,
        connectTo: connectToSchema,
      },
    },
    async ({ url, position, connectTo }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = (await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/spawn-browser`,
        { url, position, connectTo },
      )) as { ok?: boolean; id?: string };
      // Say the capability out loud in the result. The canvas normally
      // announces a terminal↔browser wire by pushing a turn into the
      // terminal, but that is suppressed for spawn wires — it would
      // interrupt the very turn that called this tool (see
      // createConnectionInScene in src/actions/sceneConnectionActions.ts).
      const note =
        result?.ok && !connectTo
          ? "\n\nThis browser is now yours to drive: browser_read, browser_navigate, browser_click, browser_eval all target it."
          : "";
      return textResult(JSON.stringify(result, null, 2) + note);
    },
  );

  server.registerTool(
    "spawn_note",
    {
      title: "Spawn a new note (workspace manager only)",
      description:
        "Creates a new note on the canvas with the given body, linked back to you so it's visible which work it came out of. A note is a record for the human to read — it receives no events and can't be driven. Only the workspace manager can call this.",
      inputSchema: {
        body: z.string().describe("Note content (markdown)"),
        position: positionSchema,
      },
    },
    async ({ body, position }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/spawn-note`,
        { body, position },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "connect_nodes",
    {
      title: "Wire two nodes together (workspace manager only)",
      description:
        "Connects two existing nodes on the canvas. A wire grants capability, it isn't just a drawn line: wiring a terminal to a browser lets that terminal drive the page with the browser_* tools, and emit_event only reaches nodes a wire connects. Wiring a note just records that it belongs to that work. Only the workspace manager can call this.",
      inputSchema: {
        source: z.object({
          kind: z.enum(["terminal", "browser", "note"]),
          id: z.string(),
        }),
        target: z.object({
          kind: z.enum(["terminal", "browser", "note"]),
          id: z.string(),
        }),
      },
    },
    async ({ source, target }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/connect-nodes`,
        { source, target },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "log_activity",
    {
      title: "Journal an action (workspace manager only)",
      description:
        "Appends an entry to the workspace manager's continuity journal — call this after spawning/wiring nodes or making a decision, so a freshly-assigned or reassigned agent can pick up real context via get_workspace_summary or query_memory instead of starting cold. Distinct from the `remember` tool: this is append-only (no name to dedupe against) and scoped to the whole workspace, not one project. Only the workspace manager can call this.",
      inputSchema: {
        event: z.string().describe("Short label, e.g. 'spawned browser for docs research'"),
        detail: z.string().optional().describe("Longer context, markdown"),
      },
    },
    async ({ event, detail }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/log-activity`,
        { event, detail },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  return server;
}
