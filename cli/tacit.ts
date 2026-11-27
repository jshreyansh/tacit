import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { resolveTacitPortFile } from "../shared/tacit-instance";
import { RECORD_USAGE, runRecordCommand } from "./record";

const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRYABLE_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"]);

interface ConnectionTarget {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  basePath: string;
  authToken: string;
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "";
  }
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function buildRequestPath(basePath: string, urlPath: string): string {
  const [pathname, search = ""] = urlPath.split("?");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const resolvedPath = `${basePath}${normalizedPath}`;
  return search ? `${resolvedPath}?${search}` : resolvedPath;
}

function getConnection(): ConnectionTarget {
  const envUrl = process.env.TACIT_URL?.trim();
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }
      const port = parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === "https:" ? 443 : 80;
      return {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        basePath: normalizeBasePath(parsed.pathname),
        authToken: process.env.TACIT_API_TOKEN?.trim() ?? "",
      };
    } catch {
      console.error(`Invalid TACIT_URL: ${envUrl}`);
      process.exit(1);
    }
  }

  const envHost = process.env.TACIT_HOST?.trim();
  const envPort = process.env.TACIT_PORT?.trim();

  if (envHost && envPort) {
    return {
      protocol: "http:",
      hostname: envHost,
      port: parseInt(envPort, 10),
      basePath: "",
      authToken: process.env.TACIT_API_TOKEN?.trim() ?? "",
    };
  }

  const portFile = resolveTacitPortFile(process.env);
  try {
    const [portStr, pidStr, authToken = ""] = fs.readFileSync(portFile, "utf-8").trim().split("\n");
    const port = parseInt(portStr, 10);
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // probe: throws if process is dead
      } catch {
        try { fs.unlinkSync(portFile); } catch {}
        console.error(`Tacit is not running (stale port file removed from ${portFile}).`);
        process.exit(1);
      }
    }
    return {
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      basePath: "",
      authToken,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.error(`Tacit is not running (no port file found at ${portFile}).`);
    process.exit(1);
  }
}

function requestOnce(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<any> {
  const { protocol, hostname, port, basePath, authToken } = getConnection();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (data) headers["Content-Length"] = String(Buffer.byteLength(data));
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    // In one of Tacit's terminals: which one, and its proof (electron/terminal-credentials.ts).
    const terminalId = process.env.TACIT_TERMINAL_ID?.trim();
    const terminalToken = process.env.TACIT_TERMINAL_TOKEN?.trim();
    if (terminalId && terminalToken) {
      headers["X-Tacit-Terminal"] = terminalId;
      headers["X-Tacit-Terminal-Token"] = terminalToken;
    }

    const transport = protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol,
        hostname,
        port,
        path: buildRequestPath(basePath, urlPath),
        method,
        headers,
        timeout: CONNECTION_TIMEOUT_MS,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: string) => (responseBody += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(responseBody);
            if (res.statusCode && res.statusCode >= 400) {
              reject(json);
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(responseBody));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("ETIMEDOUT"));
    });
    req.on("error", (err) => reject(err));
    if (data) req.write(data);
    req.end();
  });
}

async function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestOnce(method, urlPath, body);
    } catch (err: unknown) {
      lastError = err;
      const code = err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
      const isTimeout = err instanceof Error && err.message === "ETIMEDOUT";
      if ((code && RETRYABLE_CODES.has(code)) || isTimeout) {
        if (attempt < MAX_RETRIES) {
          const delay = 1000 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      throw err;
    }
  }
  const { protocol, hostname, port, basePath } = getConnection();
  console.error(
    `Failed to connect to Tacit at ${protocol}//${hostname}:${port}${basePath} after ${MAX_RETRIES + 1} attempts.\n` +
    `Check that the server is running and the host/port are correct.`,
  );
  throw lastError;
}

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const filteredArgs = args.filter((a) => a !== "--json");
const [group, command, ...rest] = filteredArgs;

/* ---------- tasks and notes ---------- */

const flagOf = (rest: string[], flag: string): string | undefined => {
  const i = rest.indexOf(flag);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
};
const flagsOf = (rest: string[], flag: string): string[] => rest.flatMap((arg, i) => (arg === flag && i + 1 < rest.length ? [rest[i + 1]] : []));
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const COLUMN_LABEL: Record<string, string> = { later: "later", next: "next", working: "working", needs: "needs you", done: "done", dropped: "dropped" };
const TASK_USAGE =
  "Usage: tacit task <command>   (tacit pin works too)\n" +
  "  task add --title <t> [--body <b>] [--done-when <line>]... [--part <p>]... [--later] [--kind build|bug|research|write] [--folder <path>] [--follow-up-of <id>] [--take]\n" +
  "  task list [--column later|next|working|needs|done]\n" +
  "  task show <id>\n" +
  "In a terminal on the workdesk, as yourself:\n" +
  "  task take <id> [--part <p>]\n" +
  "  task part <id> <part> todo|doing|done   |   task part <id> --add <text>\n" +
  "  task say <id> <text>\n" +
  "  task ask <id> <question> [--option <answer>]... [--why <w>] [--meanwhile <m>]\n" +
  "  task approve <id> <what you'd do> [--why <w>]\n" +
  "  task request-agent <id> --open claude|codex|opencode|antigravity | --to <terminal>  --message <m> [--no-answer] [--why <w>]\n" +
  "  task suggest <id> [--title <t>] [--body <b>] [--done-when <line>]... [--leave-alone <l>]\n" +
  "  task finish <id> --summary <s> [--checked <line>=<how>]... [--how <how you checked, with no lines>] [--unchecked <line>=<why>]... [--left <l>] [--unsure <u>] [--sensitive <s>] [--taste] [--check]\n" +
  "  task going <id>                          (your turn ended, but something you started is still running)\n" +
  "  task hand-over <id> --to <terminal> [--part <p>] [--note <n>]   (workdesk manager)";

async function runTaskCommand(command: string | undefined, rest: string[]): Promise<void> {
  const terminal = process.env.TACIT_TERMINAL_ID?.trim();
  const id = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const words = rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined;
  const mine = (): string => `/terminal/${encodeURIComponent(terminal ?? stop("That works in a terminal on a Tacit workdesk."))}/tasks`;
  const call = async (act: string, body: unknown) => request("POST", `${mine()}/${encodeURIComponent(id ?? stop(TASK_USAGE))}/${act}`, body);
  const show = (result: any) => {
    if (jsonFlag) console.log(JSON.stringify(result, null, 2));
    else if (result.brief) console.log(result.brief);
    else if (result.outcome) console.log(result.outcome);
    else if (result.asked) console.log(result.note);
    else if (result.task) console.log(line(result.task));
    else console.log("Done.");
  };
  const line = (t: any) => `${t.name ?? `T-${t.n}`}  [${COLUMN_LABEL[t.column] ?? t.column}]  ${t.title}  (${t.id})`;
  const pairs = (flag: string, checked: boolean) =>
    flagsOf(rest, flag).map((v) => {
      const at = v.indexOf("=");
      return { line: at < 0 ? v : v.slice(0, at), checked, how: at < 0 ? undefined : v.slice(at + 1) };
    });

  if (command === "add") {
    const title = flagOf(rest, "--title") ?? stop("--title is required");
    const doneWhen = flagsOf(rest, "--done-when");
    const parts = [...flagsOf(rest, "--part"), ...flagsOf(rest, "--step")];
    const link = flagOf(rest, "--link");
    const body = [flagOf(rest, "--body"), link].filter(Boolean).join("\n\n");
    const folder = flagOf(rest, "--folder") ?? flagOf(rest, "--repo");
    const common = { title, ...(body ? { body } : {}), parts, kind: flagOf(rest, "--kind"), priority: flagOf(rest, "--priority"), ...(folder ? { folder: path.resolve(folder) } : {}) };
    show(
      terminal
        ? await request("POST", mine(), { ...common, done_when: doneWhen, leave_alone: flagOf(rest, "--leave-alone"), follow_up_of: flagOf(rest, "--follow-up-of"), take: rest.includes("--take") })
        : await request("POST", "/board/tasks", { ...common, doneWhen, leaveAlone: flagOf(rest, "--leave-alone"), ...(rest.includes("--later") ? { wait: "later" } : {}) }),
    );
  } else if (command === "list") {
    const wanted = flagOf(rest, "--column");
    const result = await request("GET", terminal ? mine() : "/board/tasks");
    const tasks = result.tasks.filter((t: any) => !wanted || t.column === wanted);
    if (jsonFlag) console.log(JSON.stringify({ tasks }, null, 2));
    else if (tasks.length === 0) console.log("No tasks.");
    else for (const t of tasks) console.log(line(t));
  } else if (command === "show" && id) {
    const { task: t } = await request("GET", terminal ? `${mine()}/${encodeURIComponent(id)}` : `/board/tasks/${encodeURIComponent(id)}`);
    if (jsonFlag) return console.log(JSON.stringify(t, null, 2));
    console.log(line(t));
    if (t.folder) console.log(`folder: ${t.folder}`);
    if (t.body) console.log(`\n${t.body}`);
    if (t.doneWhen?.length) console.log(`\nDone when:\n${t.doneWhen.map((l: any) => `  - ${l.text} [${l.id}]${l.proof ? `  (${l.proof.src === "saw" ? "Tacit saw" : l.proof.src === "says" ? "agent says" : "not checked"}: ${l.proof.text})` : ""}`).join("\n")}`);
    if (t.leaveAlone) console.log(`\nLeave alone: ${t.leaveAlone}`);
    if (t.parts?.length) console.log(`\nParts:\n${t.parts.map((p: any) => `  - [${p.state}] ${p.text} [${p.id}]`).join("\n")}`);
    if (t.requests?.length) console.log(`\nWaiting on the user:\n${t.requests.map((r: any) => `  - ${r.text}`).join("\n")}`);
    if (t.decisions?.length) console.log(`\nDecided:\n${t.decisions.map((d: any) => `  - ${d.text} ${d.answer}`).join("\n")}`);
    if (t.report) console.log(`\nReport: ${t.report.summary}`);
  } else if (command === "take") show(await call("take", { part: flagOf(rest, "--part") }));
  else if (command === "part" || command === "step") {
    const add = flagOf(rest, "--add");
    show(await call("report", add ? { add_parts: [add] } : { part: words ?? stop(TASK_USAGE), state: rest[2] ?? flagOf(rest, "--status") ?? "done" }));
  } else if (command === "say") show(await call("report", { say: words ?? stop(TASK_USAGE) }));
  else if (command === "going") show(await call("report", { still_going: true }));
  else if (command === "ask") {
    const choices = flagOf(rest, "--choices")?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
    show(await call("ask", { question: words ?? stop(TASK_USAGE), options: [...flagsOf(rest, "--option"), ...choices], why: flagOf(rest, "--why"), meanwhile: flagOf(rest, "--meanwhile") }));
  } else if (command === "approve") show(await call("approve", { what: words ?? stop(TASK_USAGE), why: flagOf(rest, "--why"), meanwhile: flagOf(rest, "--meanwhile") }));
  else if (command === "request-agent") show(await call("request-agent", { open: flagOf(rest, "--open"), to: flagOf(rest, "--to"), message: flagOf(rest, "--message") ?? stop("--message is required: what to send it"), answer: !rest.includes("--no-answer"), why: flagOf(rest, "--why"), meanwhile: flagOf(rest, "--meanwhile") }));
  else if (command === "suggest") show(await call("suggest", { title: flagOf(rest, "--title"), body: flagOf(rest, "--body"), leave_alone: flagOf(rest, "--leave-alone"), ...(flagsOf(rest, "--done-when").length ? { done_when: flagsOf(rest, "--done-when") } : {}) }));
  else if (command === "finish" || command === "done") {
    show(
      await call("finish", {
        summary: flagOf(rest, "--summary") ?? stop("--summary is required: say what you did"),
        lines: [...pairs("--checked", true), ...pairs("--unchecked", false)],
        checked: flagOf(rest, "--how"),
        left: flagOf(rest, "--left"), unsure: flagOf(rest, "--unsure"), sensitive: flagOf(rest, "--sensitive"),
        taste: rest.includes("--taste"), wants_check: rest.includes("--check"),
      }),
    );
  } else if (command === "hand-over") show(await call("hand-over", { terminal: flagOf(rest, "--to") ?? stop("--to <terminal> is required"), part: flagOf(rest, "--part"), note: flagOf(rest, "--note") }));
  else console.log(TASK_USAGE);
}

async function runCanvasCommand(command: string | undefined, rest: string[]): Promise<void> {
  const terminal = process.env.TACIT_TERMINAL_ID?.trim() || stop("tacit canvas reads the canvas this terminal is on: run it in one of Tacit's terminals.");
  if (command === "draw" || command === "change" || command === "delete") {
    const text = rest[0] === "-" || rest[0] === undefined ? fs.readFileSync(0, "utf8") : rest[0];
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      stop(`tacit canvas ${command} takes JSON, as the ${{ draw: "draw", change: "change_drawing", delete: "delete_drawing" }[command]} tool does: an argument, or - to read it from standard input.`);
    }
    console.log((await request("POST", `/terminal/${encodeURIComponent(terminal)}/canvas/${command}`, body)).text);
    return;
  }
  if (command !== "read") return console.log("Usage: tacit canvas read [<id>] [--picture]   |   tacit canvas draw|change|delete '<json>'");
  const id = rest.find((a) => !a.startsWith("--"));
  const read = await request("POST", `/terminal/${encodeURIComponent(terminal)}/canvas/read`, { ...(id ? { id } : {}), ...(rest.includes("--picture") ? { picture: true } : {}) });
  console.log(read.canvas);
  // The picture is a file to open; its bytes are no use in a terminal.
  if (read.picture) console.log(`\nPicture: ${read.picture.file}`);
}

async function runNoteCommand(command: string | undefined, rest: string[]): Promise<void> {
  if (command === "add") {
    const title = flagOf(rest, "--title");
    const text = title ? [title, flagOf(rest, "--body")].filter(Boolean).join("\n\n") : rest.find((a) => !a.startsWith("--"));
    const terminal = process.env.TACIT_TERMINAL_ID?.trim();
    const { note } = await request("POST", "/board/notes", { text: text ?? stop('Usage: tacit note add "<text>"'), ...(terminal ? { by: terminal } : {}) });
    console.log(jsonFlag ? JSON.stringify(note, null, 2) : `${note.id}  ${note.title}`);
  } else if (command === "list") {
    const { notes } = await request("GET", "/board/notes");
    if (jsonFlag) console.log(JSON.stringify({ notes }, null, 2));
    else if (notes.length === 0) console.log("No notes.");
    else for (const n of notes) console.log(`${n.id}  ${n.title}`);
  } else if (command === "show" && rest[0]) {
    const { note } = await request("GET", `/board/notes/${encodeURIComponent(rest[0])}`);
    console.log(jsonFlag ? JSON.stringify(note, null, 2) : note.text);
  } else console.log('Usage: tacit note add "<text>"   |   tacit note list   |   tacit note show <id>');
}

async function main() {
  try {
    if (group === "project") {
      if (command === "add" && rest[0]) {
        const result = await request("POST", "/project/add", { path: rest[0] });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else
          console.log(
            `Added "${result.name}" with ${result.worktrees} worktree(s). ID: ${result.id}`,
          );
      } else if (command === "list") {
        const projects = await request("GET", "/project/list");
        if (jsonFlag) {
          console.log(JSON.stringify(projects, null, 2));
          return;
        }
        if (projects.length === 0) {
          console.log("No projects.");
          return;
        }
        for (const p of projects) {
          console.log(
            `${p.id}  ${p.name}  ${p.path}  (${p.worktrees.length} worktrees)`,
          );
        }
      } else if (command === "remove" && rest[0]) {
        const result = await request("DELETE", `/project/${rest[0]}`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Removed.");
      } else if (command === "rescan" && rest[0]) {
        const result = await request("POST", `/project/${rest[0]}/rescan`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Rescanned. ${result.worktrees} worktree(s) found.`);
      } else {
        console.log("Usage: tacit project <add|list|remove> [args]");
      }
    } else if (group === "workflow") {
      // Lead-driven workflow CLI: a thin HTTP client over the headless server's
      // /workflow/* routes. Mirrors the in-process `hydra` binary commands but
      // dispatches over HTTP, so CI / remote / cross-process callers can drive
      // workflows without embedding the hydra package.
      const requireRepo = (): string => {
        const repoIdx = rest.indexOf("--repo");
        const repo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
        if (!repo) {
          console.error("--repo is required");
          process.exit(1);
        }
        return repo;
      };
      const optionalFlag = (flag: string): string | undefined => {
        const idx = rest.indexOf(flag);
        return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : undefined;
      };
      const optionalNumber = (flag: string): number | undefined => {
        const raw = optionalFlag(flag);
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (Number.isNaN(n)) {
          console.error(`Invalid number for ${flag}: ${raw}`);
          process.exit(1);
        }
        return n;
      };
      const listFlag = (flag: string): string[] => {
        const raw = optionalFlag(flag);
        return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
      };
      const requireWorkflowId = (): string => {
        const workflowId = rest[0];
        if (!workflowId || workflowId.startsWith("--")) {
          console.error(`workflow ${command} requires a workflow id as the first positional argument`);
          process.exit(1);
        }
        return workflowId;
      };
      const requireFlag = (flag: string): string => {
        const value = optionalFlag(flag);
        if (!value) {
          console.error(`${flag} is required`);
          process.exit(1);
        }
        return value;
      };

      if (command === "init") {
        const repo = requireRepo();
        const intent = requireFlag("--intent");
        const body: Record<string, unknown> = {
          intent,
          repoPath: repo,
        };
        const worktree = optionalFlag("--worktree");
        if (worktree) body.worktreePath = worktree;
        const timeoutMinutes = optionalNumber("--timeout-minutes");
        if (timeoutMinutes !== undefined) body.timeoutMinutes = timeoutMinutes;
        const maxRetries = optionalNumber("--max-retries");
        if (maxRetries !== undefined) body.maxRetries = maxRetries;
        if (rest.includes("--no-auto-approve")) body.autoApprove = false;

        const result = await request("POST", "/workflow/init", body);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Initialized workflow ${result.workflow_id}.`);
      } else if (command === "dispatch") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const body: Record<string, unknown> = {
          repoPath: repo,
          nodeId: requireFlag("--node"),
          role: requireFlag("--role"),
          intent: requireFlag("--intent"),
        };
        const dependsOn = listFlag("--depends-on");
        if (dependsOn.length > 0) body.dependsOn = dependsOn;
        const model = optionalFlag("--model");
        if (model) body.model = model;
        const feedback = optionalFlag("--feedback");
        if (feedback) body.feedback = feedback;
        const worktree = optionalFlag("--worktree");
        if (worktree) body.worktreePath = worktree;
        const worktreeBranch = optionalFlag("--worktree-branch");
        if (worktreeBranch) body.worktreeBranch = worktreeBranch;
        const timeoutMinutes = optionalNumber("--timeout-minutes");
        if (timeoutMinutes !== undefined) body.timeoutMinutes = timeoutMinutes;
        const maxRetries = optionalNumber("--max-retries");
        if (maxRetries !== undefined) body.maxRetries = maxRetries;

        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/dispatch`,
          body,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.status}  node=${result.node_id}  assignment=${result.assignment_id}`);
      } else if (command === "redispatch") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const nodeId = requireFlag("--node");
        const body: Record<string, unknown> = { repoPath: repo };
        const intent = optionalFlag("--intent");
        if (intent) body.intent = intent;

        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/node/${encodeURIComponent(nodeId)}/redispatch`,
          body,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.status}  node=${result.node_id}`);
      } else if (command === "watch") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/watch-decision`,
          { repoPath: repo },
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.type}  workflow=${result.workflow_id}`);
      } else if (command === "approve") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const nodeId = requireFlag("--node");
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/node/${encodeURIComponent(nodeId)}/approve`,
          { repoPath: repo },
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Approved node ${nodeId}.`);
      } else if (command === "reset") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const nodeId = requireFlag("--node");
        const body: Record<string, unknown> = { repoPath: repo };
        const feedback = optionalFlag("--feedback");
        if (feedback) body.feedback = feedback;
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/node/${encodeURIComponent(nodeId)}/reset`,
          body,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Reset node ${nodeId} (${result.reset_node_ids?.length ?? 0} nodes affected).`);
      } else if (command === "merge") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const nodeIds = listFlag("--nodes");
        if (nodeIds.length === 0) {
          console.error("--nodes is required (comma-separated node IDs)");
          process.exit(1);
        }
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/merge`,
          { repoPath: repo, nodeIds },
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Merged ${nodeIds.length} nodes.`);
      } else if (command === "complete") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const body: Record<string, unknown> = { repoPath: repo };
        const summary = optionalFlag("--summary");
        if (summary) body.summary = summary;
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/complete`,
          body,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Workflow completed.");
      } else if (command === "fail") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const reason = requireFlag("--reason");
        const result = await request(
          "POST",
          `/workflow/${encodeURIComponent(workflowId)}/fail`,
          { repoPath: repo, reason },
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Workflow failed.");
      } else if (command === "list") {
        const repo = requireRepo();
        const result = await request(
          "GET",
          `/workflow/list?repo=${encodeURIComponent(repo)}`,
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.length === 0) {
          console.log("No workflows.");
          return;
        }
        for (const workflow of result) {
          console.log(`${workflow.id}  ${workflow.status}  ${workflow.updated_at}`);
        }
      } else if (command === "list-roles") {
        const repo = requireRepo();
        const params = new URLSearchParams({ repo });
        const cli = optionalFlag("--cli") ?? optionalFlag("--agent-type");
        if (cli) params.set("agentType", cli);
        const result = await request("GET", `/workflow/list-roles?${params.toString()}`);
        console.log(JSON.stringify(result, null, 2));
      } else if (command === "status") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const result = await request(
          "GET",
          `/workflow/${encodeURIComponent(workflowId)}?repo=${encodeURIComponent(repo)}`,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.workflow.status}  ${result.workflow.id}`);
      } else if (command === "cleanup") {
        const workflowId = requireWorkflowId();
        const repo = requireRepo();
        const force = rest.includes("--force");
        const query = new URLSearchParams({ repo });
        if (force) query.set("force", "true");
        const result = await request(
          "DELETE",
          `/workflow/${encodeURIComponent(workflowId)}?${query.toString()}`,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Cleaned up.");
      } else {
        console.log(
          "Usage: tacit workflow <init|dispatch|redispatch|watch|approve|reset|merge|complete|fail|list|list-roles|status|cleanup> [args]",
        );
      }
    } else if (group === "worktree") {
      if (command === "list") {
        const repoIdx = rest.indexOf("--repo");
        const repo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
        if (!repo) {
          console.error("--repo is required");
          process.exit(1);
        }
        const result = await request(
          "GET",
          `/worktree/list?repo=${encodeURIComponent(repo)}`,
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.length === 0) {
          console.log("No worktrees.");
          return;
        }
        for (const worktree of result) {
          console.log(`${worktree.path}  ${worktree.branch}`);
        }
      } else if (command === "create") {
        const repoIdx = rest.indexOf("--repo");
        const branchIdx = rest.indexOf("--branch");
        const pathIdx = rest.indexOf("--path");
        const baseBranchIdx = rest.indexOf("--base-branch");
        const repo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
        const branch = branchIdx >= 0 ? rest[branchIdx + 1] : undefined;
        const worktreePath = pathIdx >= 0 ? rest[pathIdx + 1] : undefined;
        const baseBranch = baseBranchIdx >= 0 ? rest[baseBranchIdx + 1] : undefined;
        if (!repo) {
          console.error("--repo is required");
          process.exit(1);
        }
        if (!branch) {
          console.error("--branch is required");
          process.exit(1);
        }
        const result = await request("POST", "/worktree/create", {
          repo,
          branch,
          ...(worktreePath ? { path: worktreePath } : {}),
          ...(baseBranch ? { baseBranch } : {}),
        });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Created ${result.path}.`);
      } else if (command === "remove") {
        const repoIdx = rest.indexOf("--repo");
        const pathIdx = rest.indexOf("--path");
        const repo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
        const worktreePath = pathIdx >= 0 ? rest[pathIdx + 1] : undefined;
        const force = rest.includes("--force");
        if (!repo) {
          console.error("--repo is required");
          process.exit(1);
        }
        if (!worktreePath) {
          console.error("--path is required");
          process.exit(1);
        }
        const query = new URLSearchParams({
          repo,
          path: worktreePath,
        });
        if (force) query.set("force", "true");
        const result = await request("DELETE", `/worktree?${query.toString()}`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Removed.");
      } else {
        console.log("Usage: tacit worktree <list|create|remove> [args]");
      }
    } else if (group === "terminal") {
      if (command === "create") {
        const wtIdx = rest.indexOf("--worktree");
        const typeIdx = rest.indexOf("--type");
        const promptIdx = rest.indexOf("--prompt");
        const parentIdx = rest.indexOf("--parent-terminal");
        const workflowIdx = rest.indexOf("--workflow-id");
        const assignmentIdx = rest.indexOf("--assignment-id");
        const repoIdx = rest.indexOf("--repo");
        const resumeIdx = rest.indexOf("--resume-session-id");
        const autoApprove = rest.includes("--auto-approve");
        const worktree = wtIdx >= 0 ? rest[wtIdx + 1] : undefined;
        const type = typeIdx >= 0 ? rest[typeIdx + 1] : "shell";
        const prompt = promptIdx >= 0 ? rest[promptIdx + 1] : undefined;
        const parentTerminalId = parentIdx >= 0 ? rest[parentIdx + 1] : undefined;
        const workflowId = workflowIdx >= 0 ? rest[workflowIdx + 1] : undefined;
        const assignmentId = assignmentIdx >= 0 ? rest[assignmentIdx + 1] : undefined;
        const repoPath = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
        const resumeSessionId = resumeIdx >= 0 ? rest[resumeIdx + 1] : undefined;
        if (!worktree) {
          console.error("--worktree is required");
          process.exit(1);
        }
        const result = await request("POST", "/terminal/create", {
          worktree,
          type,
          ...(prompt ? { prompt } : {}),
          ...(autoApprove ? { autoApprove: true } : {}),
          ...(parentTerminalId ? { parentTerminalId } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(assignmentId ? { assignmentId } : {}),
          ...(repoPath ? { repoPath } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          // Whose terminal this was run in: an agent's is held to the manager rule.
          ...(process.env.TACIT_TERMINAL_ID?.trim() ? { requester: process.env.TACIT_TERMINAL_ID.trim() } : {}),
        });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else
          console.log(
            `Created ${result.type} terminal "${result.title}". ID: ${result.id}`,
          );
      } else if (command === "list") {
        const wtIdx = rest.indexOf("--worktree");
        const worktree = wtIdx >= 0 ? rest[wtIdx + 1] : undefined;
        const query = worktree
          ? `?worktree=${encodeURIComponent(worktree)}`
          : "";
        const terminals = await request("GET", `/terminal/list${query}`);
        if (jsonFlag) {
          console.log(JSON.stringify(terminals, null, 2));
          return;
        }
        if (terminals.length === 0) {
          console.log("No terminals.");
          return;
        }
        for (const t of terminals) {
          console.log(
            `${t.id}  ${t.type}  ${t.status}  ${t.title}  (${t.project}/${t.worktree})`,
          );
        }
      } else if (command === "status" && rest[0]) {
        const result = await request("GET", `/terminal/${rest[0]}/status`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(result.status);
      } else if (command === "output" && rest[0]) {
        const linesIdx = rest.indexOf("--lines");
        const lines = linesIdx >= 0 ? rest[linesIdx + 1] : "50";
        const result = await request(
          "GET",
          `/terminal/${rest[0]}/output?lines=${lines}`,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(result.lines.join("\n"));
      } else if (command === "destroy" && rest[0]) {
        const result = await request("DELETE", `/terminal/${rest[0]}`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Destroyed.");
      } else if (command === "set-title" && rest[0] && rest[1]) {
        const title = rest.slice(1).join(" ");
        const result = await request("PUT", `/terminal/${rest[0]}/custom-title`, {
          customTitle: title,
        });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log("Title updated.");
      } else if (command === "input") {
        console.error(
          "tacit terminal input has been removed. Start Claude/Codex tasks with `tacit terminal create --prompt \"...\"` instead.",
        );
        process.exit(1);
      } else {
        console.log(
          "Usage: tacit terminal <create|list|status|output|destroy|set-title> [args]",
        );
        process.exit(1);
      }
    } else if (group === "telemetry") {
      if (command === "get") {
        const terminalIdx = rest.indexOf("--terminal");
        const workflowIdx = rest.indexOf("--workflow");
        const repoIdx = rest.indexOf("--repo");
        const terminalId = terminalIdx >= 0 ? rest[terminalIdx + 1] : undefined;
        const workflowId = workflowIdx >= 0 ? rest[workflowIdx + 1] : undefined;
        const repoPath = repoIdx >= 0 ? rest[repoIdx + 1] : process.cwd();

        if (terminalId) {
          const result = await request("GET", `/telemetry/terminal/${encodeURIComponent(terminalId)}`);
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (workflowId) {
          const result = await request(
            "GET",
            `/telemetry/workflow/${encodeURIComponent(workflowId)}?repo=${encodeURIComponent(repoPath)}`,
          );
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.error("Provide --terminal <id> or --workflow <id>");
        process.exit(1);
      } else if (command === "events") {
        const terminalIdx = rest.indexOf("--terminal");
        const limitIdx = rest.indexOf("--limit");
        const cursorIdx = rest.indexOf("--cursor");
        const terminalId = terminalIdx >= 0 ? rest[terminalIdx + 1] : undefined;
        const limit = limitIdx >= 0 ? rest[limitIdx + 1] : "50";
        const cursor = cursorIdx >= 0 ? rest[cursorIdx + 1] : undefined;
        if (!terminalId) {
          console.error("--terminal is required");
          process.exit(1);
        }
        const query = new URLSearchParams({ limit });
        if (cursor) query.set("cursor", cursor);
        const result = await request(
          "GET",
          `/telemetry/terminal/${encodeURIComponent(terminalId)}/events?${query.toString()}`,
        );
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          "Usage: tacit telemetry <get|events> [--terminal <id> | --workflow <id> --repo <path>]",
        );
      }
    } else if (group === "diff" && command) {
      const worktreePath = command;
      const summary = rest.includes("--summary");
      const query = summary ? "?summary" : "";
      const result = await request(
        "GET",
        `/diff/${encodeURIComponent(worktreePath)}${query}`,
      );
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else if (summary) {
        if (result.files.length === 0) {
          console.log("No changes.");
        } else {
          for (const f of result.files) {
            const stat = f.binary
              ? "binary"
              : `+${f.additions} -${f.deletions}`;
            console.log(`${stat}\t${f.name}`);
          }
        }
      } else {
        console.log(result.diff);
      }
    } else if (group === "note") {
      await runNoteCommand(command, rest);
    } else if (group === "canvas") {
      await runCanvasCommand(command, rest);
    } else if (group === "task" || group === "pin") {
      await runTaskCommand(command, rest);
    } else if (group === "browser") {
      const browserOptionalFlag = (flag: string): string | undefined => {
        const idx = rest.indexOf(flag);
        return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : undefined;
      };
      const browserNumberFlag = (flag: string): number | undefined => {
        const value = browserOptionalFlag(flag);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          console.error(`${flag} must be a number`);
          process.exit(1);
        }
        return parsed;
      };

      if (command === "add") {
        const url = rest[0];
        if (!url) {
          console.error("browser add requires a url");
          process.exit(1);
        }
        const x = browserNumberFlag("--x");
        const y = browserNumberFlag("--y");
        const result = await request("POST", "/browser/create", { url, x, y });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(result.id);
      } else if (command === "list") {
        const result = await request("GET", "/browser/list");
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.cards.length === 0) {
          console.log("No browser tiles.");
          return;
        }
        for (const c of result.cards) {
          console.log(`${c.id}  ${c.title || c.url}`);
        }
      } else if (command === "update" && rest[0]) {
        const id = rest[0];
        const payload: Record<string, unknown> = {};
        const newUrl = browserOptionalFlag("--url");
        if (newUrl !== undefined) payload.url = newUrl;
        const x = browserNumberFlag("--x");
        if (x !== undefined) payload.x = x;
        const y = browserNumberFlag("--y");
        if (y !== undefined) payload.y = y;
        const w = browserNumberFlag("--w");
        if (w !== undefined) payload.w = w;
        const h = browserNumberFlag("--h");
        if (h !== undefined) payload.h = h;
        const result = await request("PUT", `/browser/${encodeURIComponent(id)}`, payload);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Updated ${id}`);
      } else if ((command === "rm" || command === "remove") && rest[0]) {
        const id = rest[0];
        const result = await request("DELETE", `/browser/${encodeURIComponent(id)}`);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Removed ${id}`);
      } else {
        console.log(
          "Usage: tacit browser <add|list|update|rm> [args]\n" +
          "  browser add <url> [--x N] [--y N]\n" +
          "  browser list\n" +
          "  browser update <id> [--url <u>] [--x N] [--y N] [--w N] [--h N]\n" +
          "  browser rm <id>",
        );
      }
    } else if (group === "record") {
      // Read from the record's files, so it works with the app closed.
      process.exitCode = runRecordCommand(command, rest, { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }, jsonFlag);
    } else if (group === "state") {
      const state = await request("GET", "/state");
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log(
        "Usage: tacit <project|workflow|worktree|terminal|telemetry|task|browser|diff|record|state> <command> [args]",
      );
      console.log("");
      console.log("Commands:");
      console.log(
        "  project add <path>                          Add a project",
      );
      console.log(
        "  project list                                List projects",
      );
      console.log(
        "  project remove <id>                         Remove a project",
      );
      console.log(
        "  project rescan <id>                         Rescan worktrees",
      );
      console.log(
        "  workflow init --intent <t> --repo <p>      Create a Lead-driven workflow",
      );
      console.log(
        "  workflow dispatch <id> --node <n> --role <r> --intent <t> --repo <p>",
      );
      console.log(
        "                                              Dispatch an agent node",
      );
      console.log(
        "  workflow redispatch <id> --node <n> --repo <p>",
      );
      console.log(
        "                                              Re-dispatch a reset node",
      );
      console.log(
        "  workflow watch <id> --repo <p>             Wait for next decision point",
      );
      console.log(
        "  workflow approve <id> --node <n> --repo <p>  Approve a node's output",
      );
      console.log(
        "  workflow reset <id> --node <n> --repo <p> [--feedback <t>]",
      );
      console.log(
        "                                              Reset a node and downstream",
      );
      console.log(
        "  workflow merge <id> --nodes a,b --repo <p> Merge parallel branches",
      );
      console.log(
        "  workflow complete <id> --repo <p> [--summary <t>]  Mark workflow done",
      );
      console.log(
        "  workflow fail <id> --reason <t> --repo <p> Mark workflow failed",
      );
      console.log(
        "  workflow list --repo <p>                   List workflows",
      );
      console.log(
        "  workflow list-roles --repo <p> [--cli <claude|codex>]  List role registry entries",
      );
      console.log(
        "  workflow status <id> --repo <p>            Get workflow status",
      );
      console.log(
        "  workflow cleanup <id> --repo <p> [--force] Clean up workflow runtime state",
      );
      console.log(
        "  worktree list --repo <p>                   List worktrees",
      );
      console.log(
        "  worktree create --repo <p> --branch <b>    Create a worktree",
      );
      console.log(
        "  worktree remove --repo <p> --path <p>      Remove a worktree",
      );
      console.log(
        "  terminal create --worktree <p> --type <t>   Create terminal",
      );
      console.log(
        "  terminal list [--worktree <p>]              List terminals",
      );
      console.log("  terminal status <id>                        Get status");
      console.log("  terminal output <id> [--lines N]            Read output");
      console.log(
        "  terminal destroy <id>                       Destroy terminal",
      );
      console.log(
        "  terminal set-title <id> <title>             Set custom title",
      );
      console.log(
        "  telemetry get --terminal <id>               Get terminal telemetry",
      );
      console.log(
        "  telemetry get --workflow <id> [--repo <p>]  Get workflow telemetry",
      );
      console.log(
        "  telemetry events --terminal <id>            List terminal telemetry events",
      );
      console.log("  diff <worktree-path> [--summary]            Get git diff");
      console.log("  task add --title <t> [--body <b>] [--done-when <l>]...  Put a task on the workdesk's board");
      console.log("  task list | show <id>                      Read the board");
      console.log("  task take|part|say|ask|approve|finish <id> Work on one, from a terminal on the workdesk");
      console.log("  canvas read [<id>] [--picture]             What's drawn on the canvas, from a terminal on it");
      console.log("  canvas draw|change|delete '<json>'          Draw on it; change or delete what you drew");
      console.log('  note add "<text>" | list | show <id>       Notes on the canvas');
      console.log(
        "  browser add <url> [--x N] [--y N]          Add a browser tile to the canvas",
      );
      console.log(
        "  browser list                               List browser tiles",
      );
      console.log(
        "  browser update <id> [--url|--x|--y|--w|--h] Edit a browser tile",
      );
      console.log(
        "  browser rm <id>                            Remove a browser tile",
      );
      console.log(RECORD_USAGE);
      console.log(
        "  state                                       Full canvas state",
      );
      console.log("");
      console.log("Flags:");
      console.log("  --json    Output in JSON format");
      process.exit(1);
    }
  } catch (err: any) {
    console.error(err.error ?? err.message ?? err);
    process.exit(1);
  }
}

main();
