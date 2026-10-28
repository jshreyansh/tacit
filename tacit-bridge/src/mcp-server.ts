import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest, getTerminalId } from "./client.ts";
import { listAgentAdapters } from "../../shared/agent-adapters.ts";

/**
 * Every agent Tacit offers for new terminals, plus the two plain types.
 * Retired ones (Gemini) are left out, as in the manager picker.
 */
const SPAWNABLE_TERMINAL_TYPES = [
  "shell",
  ...listAgentAdapters()
    .filter((adapter) => !adapter.retired)
    .map((adapter) => adapter.id),
  "lazygit",
] as [string, ...string[]];

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

export function createTacitBridgeServer(): McpServer {
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
        "Emits a named event (e.g. 'task-complete', 'found-result', 'error') to every canvas node this terminal is wired to, along wires that run from you or both ways. A connected agent receives it as a new prompt (prefixed with where it came from), a connected shell gets payload.message as a command, and a connected browser navigates there if payload.url is set. To send a message or a command to something you're wired to, send_to_connected is simpler.",
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
    "send_to_connected",
    {
      title: "Send a message to what you're wired to on the canvas",
      description:
        "Sends a message along the wires the user drew from you on the canvas, with nothing expected back (use ask when you want an answer, hand_off to pass work on). A wired agent gets it as a new prompt labelled with who it's from (it arrives after the agent's current turn if it is busy); a wired shell terminal runs the message as a command; a wired note has it added to the end. Give `to` to reach one node, or leave it out to reach everything wired from you. Open to any terminal: the wire is the permission, no manager role needed. A wire runs one way, from where it was drawn to where it was dropped, unless the user made it two-way; list_nodes shows each node's `wire` as seen from you: to_it (you can send), from_it (it sends to you), both_ways, or relates_only (records a relationship, carries nothing).",
      inputSchema: {
        message: z.string().describe("What to send: an instruction or answer for an agent, or a command for a shell"),
        to: z
          .string()
          .optional()
          .describe("Optional. The id of one node you're wired to, from list_nodes. Leave out to send to every node wired from you."),
      },
    },
    async ({ message, to }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/send-to-connected`,
        { message, to },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask an agent you're wired to",
      description:
        "Asks an agent you're wired to on the canvas a question, and its answer comes back to you: when it finishes the turn your question starts, its final reply is delivered into this terminal as a new message labelled as the answer. If it is busy, the question waits until its current turn ends. Don't wait or poll for the answer; carry on, and it arrives on its own. Use it for planner/executor, reviewer or search set-ups: \"review this diff\", \"find how the auth library handles redirects\". The wire is the permission: list_nodes shows which agents you can ask (`can` includes ask). One question at a time per agent is clearest.",
      inputSchema: {
        to: z.string().describe("The id of the agent you're wired to, from list_nodes"),
        question: z.string().describe("The question or request, complete enough to answer without you"),
      },
    },
    async ({ to, question }) => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      const result = await apiRequest("POST", `/terminal/${encodeURIComponent(terminalId)}/ask`, { to, question });
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "hand_off",
    {
      title: "Hand work to an agent you're wired to",
      description:
        "Hands work to an agent you're wired to on the canvas: you're done with it, and it carries on from here. It receives the work as a new message saying it was handed off by you. Nothing comes back automatically; use ask instead if you want an answer. Write the work so it can be finished without you: what was done, what's left, where things are. If the agent is busy, it gets this when its current turn ends.",
      inputSchema: {
        to: z.string().describe("The id of the agent you're wired to, from list_nodes"),
        work: z.string().describe("What to do, with the context needed to finish it"),
      },
    },
    async ({ to, work }) => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      const result = await apiRequest("POST", `/terminal/${encodeURIComponent(terminalId)}/hand-off`, { to, work });
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "send_prompt_to_node",
    {
      title: "Send a prompt to one terminal (workdesk manager only)",
      description:
        "Types a prompt into one terminal on the canvas and submits it, as a new message from you. An agent terminal sees it prefixed '[From the workdesk manager]'; a shell terminal gets the text as-is and runs it as a command. Unlike emit_event, which goes to every node wired to you, this reaches only the terminal you name, and needs no wire. Use it to give a worker its next step, correct it, or pass it something it asked for (an OTP, an approval). A worker that is mid-turn receives it after its current turn. Terminals only; get ids from list_nodes or spawn_terminal. Only the workdesk manager can call this.",
      inputSchema: {
        id: z.string().describe("The terminal's id, from list_nodes or spawn_terminal"),
        prompt: z.string().describe("What to tell it"),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            "Optional. If you retry this call with the same key within 10 minutes, the prompt is not sent twice. Use a fresh key for each distinct message.",
          ),
      },
    },
    async ({ id, prompt, idempotency_key }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/send-prompt`,
        { id, prompt, idempotency_key },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "wait_for_nodes",
    {
      title: "Wait until a worker changes state (workdesk manager only)",
      description:
        "Waits, without using any of your turns, until one of the named nodes (or any node, if you name none) changes state, then returns what happened: turn_completed (its turn ended; it may be waiting for its next instruction), waiting_for_human (blocked on a person approving something), errored, closed, or any other kinds you ask for. Returns at once if something already happened after the cursor you pass. Holds at most 30 seconds; on timed_out: true, call again with the returned cursor. Always pass back the cursor from your last call so nothing that happened in between is missed; expired: true means some events were lost. turn_completed means the agent stopped and is idle, not that every background task it started has finished. Works for Claude, Codex and OpenCode terminals; for other agents wait for closed, or ask them to report with emit_event. Only the workdesk manager can call this.",
      inputSchema: {
        nodes: z
          .array(z.string())
          .optional()
          .describe("Node ids to watch, from list_nodes or spawn_terminal. Leave out to watch every node."),
        events: z
          .array(
            z.enum([
              "spawned",
              "turn_started",
              "turn_completed",
              "waiting_for_human",
              "errored",
              "closed",
              "subagent_started",
              "subagent_finished",
            ]),
          )
          .optional()
          .describe("Which changes to wait for. Default: turn_completed, waiting_for_human, errored, closed."),
        after: z
          .string()
          .optional()
          .describe("The cursor from your previous wait_for_nodes call. Leave out on the first call."),
        timeout_s: z
          .number()
          .optional()
          .describe("Seconds to wait before returning timed_out (at most 30, the default)."),
      },
    },
    async ({ nodes, events, after, timeout_s }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/wait-nodes`,
        { nodes, events, after, timeout_s },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "start_task",
    {
      title: "Start recording the context of what you're about to do (manager only; not the task list)",
      description:
        "Starts recording one task in Tacit's record, under a one-line goal. Everything recorded until it ends (prompts, spawns, closes, worker turns) is grouped under the task, so it can be compared with the next similar one; the user sees the goal in the title bar. Call it when you take on a new task. If the user is recording a task they started or named, the call is refused: your work is recorded inside theirs. If Tacit started recording automatically in the last 10 minutes (usually for the instruction you're acting on), your goal names that task; an older one is ended and yours starts. Only the workdesk manager can call this.",
      inputSchema: {
        goal: z.string().describe("What this task is, in one line, e.g. 'compare three vendors' pricing pages'"),
      },
    },
    async ({ goal }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/start-task`,
        { goal },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "end_task",
    {
      title: "End recording the context you started (manager only; not the task list)",
      description:
        "Ends recording the task you started or named with start_task, once it's done. A task the user is recording is theirs to end; one left open ends by itself after 30 idle minutes. Only the workdesk manager can call this.",
      inputSchema: {},
    },
    async () => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/end-task`,
        {},
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "close_node",
    {
      title: "Close a terminal or browser (workdesk manager only)",
      description:
        "Closes one terminal or browser on the canvas: its process stops, its tile and its wires go, and the close is recorded as yours, with your reason. Use it to reap a worker that has finished, or a browser you no longer need. Only nodes an agent started can be closed (startedBy in list_nodes); terminals and browsers the user opened are refused, even with force. A terminal in the middle of a task, or one whose agent doesn't report its progress to Tacit, is not closed unless you pass force: true, since closing it would lose its work. You can't close yourself. Only the workdesk manager can call this.",
      inputSchema: {
        kind: z.enum(["terminal", "browser"]).describe("What the id names"),
        id: z.string().describe("The node's id, from list_nodes"),
        force: z
          .boolean()
          .optional()
          .describe("Close a terminal even if it's working or its state is unknown"),
        reason: z
          .string()
          .optional()
          .describe("Why it's being closed, e.g. 'finished the research'; kept in the record"),
      },
    },
    async ({ kind, id, force, reason }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/close-node`,
        { kind, id, force, reason },
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // The task list the person sees (Tasks, in the manager's chat and on the
  // canvas). Not start_task/end_task, which record a context.
  const taskSteps = z
    .array(
      z.object({
        text: z.string().describe("The step, in a few words"),
        status: z.enum(["pending", "active", "done"]).optional().describe("pending (default), active (doing it now), or done"),
      }),
    )
    .describe("Every step of the task, in order. Send the whole list each time; it replaces the last one.");
  const tasksPath = (terminalId: string, taskId?: string) =>
    `/terminal/${encodeURIComponent(terminalId)}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;

  server.registerTool(
    "list_tasks",
    {
      title: "List this project's tasks",
      description:
        "Lists the tasks in this project's task list, the one the user sees in Tacit: id, title, status (open = to do, in_progress, needs_you, done, dropped), steps, owners (terminal ids, or \"manager\") and any question waiting on the user. Read it before creating a task, so you don't make a duplicate.",
      inputSchema: {},
    },
    async () => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      return textResult(JSON.stringify(await apiRequest("GET", tasksPath(terminalId)), null, 2));
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Add a task to the user's task list",
      description:
        "Adds a task to this project's task list, which the user sees in Tacit and which outlasts this session, restarts and handovers. Use it for work that takes more than one turn or is handed to workers: one task per goal the user gave you, with its steps. Don't make a task for a one-line request. It's yours (owners: you) unless you name owners. Use your own todo tool, if you have one, for small steps within a turn.",
      inputSchema: {
        title: z.string().describe("The goal, in one line, e.g. 'Fix the failing PR checks'"),
        steps: taskSteps.optional(),
        body: z.string().optional().describe("Context worth keeping: links, decisions, what done means (markdown)"),
        owners: z
          .array(z.string())
          .optional()
          .describe("Who's on it: terminal ids, or \"manager\". Defaults to you."),
      },
    },
    async ({ title, steps, body, owners }) => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      return textResult(JSON.stringify(await apiRequest("POST", tasksPath(terminalId), { title, steps, body, owners }), null, 2));
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task: its steps, status, owners or notes",
      description:
        "Updates a task in the user's task list as you work: mark a step active when you start it and done when it's done (send the whole steps list), set the status (in_progress, done, dropped), change who's on it, or add notes. When every step is done the task is done. To ask the user something, use ask_user instead.",
      inputSchema: {
        id: z.string().describe("The task's id, from list_tasks or create_task"),
        steps: taskSteps.optional(),
        status: z.enum(["open", "in_progress", "done", "dropped"]).optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        owners: z.array(z.string()).optional().describe("Who's on it now: terminal ids, or \"manager\""),
      },
    },
    async ({ id, steps, status, title, body, owners }) => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      return textResult(JSON.stringify(await apiRequest("PUT", tasksPath(terminalId, id), { steps, status, title, body, owners }), null, 2));
    },
  );

  server.registerTool(
    "ask_user",
    {
      title: "Ask the user something a task needs",
      description:
        "Puts a question to the user on a task, which shows it as Needs you: in the task list, on the canvas, and in the manager's chat. Use it when you can't go on without their decision or something only they can do. Offer choices when there are a few clear options. Their answer arrives in this terminal as a message; carry on from there.",
      inputSchema: {
        id: z.string().describe("The task's id"),
        question: z.string().describe("What you need from them, in one line"),
        choices: z.array(z.string()).optional().describe("A few short answers they can pick, e.g. ['0.9.0', '1.0.0']"),
      },
    },
    async ({ id, question, choices }) => {
      const terminalId = getTerminalId();
      if (!terminalId) return textResult("Not running inside a Tacit terminal.");
      return textResult(
        JSON.stringify(await apiRequest("PUT", tasksPath(terminalId, id), { ask: { reason: question, choices } }), null, 2),
      );
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
      title: "List what you're wired to on the canvas",
      description:
        "Lists the nodes you're wired to on the canvas, and your own terminal (you: true). Each wired node has `wire`, seen from you: to_it (you can start things there), from_it (it reaches you; you can't start anything there), both_ways, or relates_only (a plain link that carries nothing); `purpose`, what the user drew the wire for, when they wrote one; and `can`, what you may do there (e.g. drive, read, tell, run commands in, add to). Pass all: true to list every terminal, browser and note on the canvas instead; the workdesk manager always gets everything. Every node has id, kind, position, size, type, status, and startedBy: \"user\" or the agent that started it as \"terminal:<id>\". Nodes an agent started count toward the worker limit; ones the user opened don't.",
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe("List every node on the canvas, not only what you're wired to"),
      },
    },
    async ({ all }) => {
      const terminalId = getTerminalId();
      const query = new URLSearchParams();
      if (terminalId) query.set("for", terminalId);
      if (all) query.set("all", "1");
      const suffix = query.toString();
      const result = await apiRequest("GET", suffix ? `/workspace/nodes?${suffix}` : "/workspace/nodes");
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "get_node_state",
    {
      title: "Get one node's live state",
      description:
        "Reads live detail on one specific node by kind and id — a terminal's title/status/worktree/startedBy, a browser's current url/title, or a note's body. A terminal also has busy: \"busy\", \"idle\" or \"unknown\", the same check close_node makes. Use busy, not status, to tell whether a worker is mid-task: status follows screen output, so a command that prints nothing shows as waiting. Open to any terminal.",
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
        "Searches the decision record and the workdesk journal together — what the user asked for, what got spawned and wired, what was tried and abandoned, and the notes past holders of the manager role wrote. Use it before starting something that might have been done already, and when the user refers to earlier work without saying which. Filters are exact and narrow the search rather than merely ranking it: pass `node` to see everything that ever happened to one terminal or browser, `kinds` to restrict to particular events, `since` to bound the time. Text that the app or the CLI injected is excluded unless asked for, so results are what a person actually said and did. Open to any terminal.",
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
        "Searches durable memory notes by keyword. Defaults to the workdesk-wide memory scope (the workdesk manager's own continuity journal, shared across every agent that ever holds the role) — pass scope='worktree' with a worktree path to search a specific project's per-worktree memory instead (the scope the plain `remember` tool writes to). Open to any terminal.",
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
      title: "Get a workdesk orientation summary",
      description:
        "The first call to make when picking up the workdesk-manager role — whether freshly assigned or resuming after being reassigned back. Returns node counts by kind and status, the number of active connections, and the most recent entries from the workdesk's continuity journal. Open to any terminal, but most useful to whichever one holds the role.",
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
      title: "Spawn a new terminal (workdesk manager only)",
      description:
        "Creates a new terminal on the canvas, running the given agent type. If a prompt is given, it's auto-submitted as the agent's first message (agent types only: a shell or lazygit takes no opening prompt; spawn it, then use send_prompt_to_node). Auto-placed near this terminal and linked to it in the family-tree view unless an explicit position is given. There is a limit on how many terminals agents can have open at once, counting any an earlier manager or another agent left (set by this machine's memory); at the limit the call is refused, and closing a finished worker with close_node frees a slot. Only the workdesk manager can call this.",
      inputSchema: {
        type: z
          .enum(SPAWNABLE_TERMINAL_TYPES)
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
      title: "Spawn a new browser tile (workdesk manager only)",
      description:
        "Creates a new browser tile on the canvas pointed at a URL, wired to you and ready to drive with the browser_* tools immediately — no connect_nodes call needed. Spawning another browser moves that control to the new one. Pass connectTo to give the browser to a different node instead of taking it yourself. Pass profile to choose which browser profile (signed-in identity) it opens as — call list_browser_profiles first if the task needs the user's real session, because the wrong choice means a signed-out page. The result always states which profile was used and why. There is a limit on how many browsers agents can have open at once, counting any an earlier manager or another agent left; at the limit the call is refused, and closing one with close_node frees a slot. Only the workdesk manager can call this.",
      inputSchema: {
        url: z.string().describe("URL to open"),
        position: positionSchema,
        connectTo: connectToSchema,
        profile: z
          .string()
          .optional()
          .describe(
            "Browser profile to open as — its name (as shown on the node and by list_browser_profiles) or its id. Omit to let the canvas decide; it may refuse and ask you to pick.",
          ),
      },
    },
    async ({ url, position, connectTo, profile }) => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = (await apiRequest(
        "POST",
        `/terminal/${encodeURIComponent(terminalId)}/spawn-browser`,
        { url, position, connectTo, profile },
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
      // The profile is never chosen silently: the canvas reports which one it
      // opened as and why, and that has to reach the user through your reply,
      // not sit in a JSON field you skim past.
      const profileNote = (result as { note?: string })?.note
        ? `\n\n${(result as { note?: string }).note}\nState this profile in your reply — the user cannot see which identity a node opened as unless you say so.`
        : "";
      return textResult(JSON.stringify(result, null, 2) + profileNote + note);
    },
  );

  server.registerTool(
    "list_browser_profiles",
    {
      title: "List browser profiles you may use (workdesk manager only)",
      description:
        "Lists the browser profiles (signed-in identities) you are permitted to open a browser tile as, with the id and name to pass to spawn_browser's profile parameter, which one is this canvas's default, and whether it came from the user's Chrome — a Chrome-imported profile is where their real logged-in sessions are. Profiles the user has withheld from agents are not listed and cannot be used; if a task needs one of those, ask the user. Call this before spawn_browser whenever the work depends on being signed in. Only the workdesk manager can call this.",
      inputSchema: {},
    },
    async () => {
      const terminalId = getTerminalId();
      if (!terminalId) {
        return textResult("Not running inside a Tacit terminal.");
      }
      const result = await apiRequest(
        "GET",
        `/terminal/${encodeURIComponent(terminalId)}/browser-profiles`,
      );
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    "spawn_note",
    {
      title: "Spawn a new note (workdesk manager only)",
      description:
        "Creates a new note on the canvas with the given body, linked back to you so it's visible which work it came out of. A note is a record for the human to read — it receives no events and can't be driven. Only the workdesk manager can call this.",
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
      title: "Wire two nodes together (workdesk manager only)",
      description:
        "Connects two existing nodes on the canvas, from source to target. A wire grants capability, it isn't just a drawn line: wiring a terminal to a browser lets that terminal drive the page with the browser_* tools, and wiring a terminal to another terminal or a note lets the source send to it with send_to_connected. Only the workdesk manager can call this.",
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
      title: "Journal an action (workdesk manager only)",
      description:
        "Appends an entry to the workdesk manager's continuity journal — call this after spawning/wiring nodes or making a decision, so a freshly-assigned or reassigned agent can pick up real context via get_workspace_summary or query_memory instead of starting cold. Distinct from the `remember` tool: this is append-only (no name to dedupe against) and scoped to the whole workspace, not one project. Only the workdesk manager can call this.",
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
