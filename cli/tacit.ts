import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { resolveTacitPortFile } from "../shared/tacit-instance";
import { parsePinStatus, pinKind } from "../shared/pin";
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
    } else if (group === "task" || group === "pin" || group === "note") {
      // `tacit task` is the task list the person sees; `tacit pin` is its
      // old name and still works; `tacit note add` makes a note.
      const pinOptionalFlag = (flag: string): string | undefined => {
        const idx = rest.indexOf(flag);
        return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : undefined;
      };
      const allFlags = (flag: string): string[] =>
        rest.flatMap((arg, i) => (arg === flag && i + 1 < rest.length ? [rest[i + 1]] : []));
      // An agent's changes are its own in the task's history.
      const actor = process.env.TACIT_TERMINAL_ID?.trim() ? `terminal:${process.env.TACIT_TERMINAL_ID.trim()}` : "user";
      const STATUS_LABEL: Record<string, string> = { open: "to do", in_progress: "in progress", needs_you: "needs you", done: "done", dropped: "dropped" };
      const STEP_MARK: Record<string, string> = { pending: "○", active: "▸", done: "✓" };
      const progressOf = (t: any): string => {
        const steps: any[] = t.steps ?? [];
        return steps.length ? ` ${steps.filter((s) => s.status === "done").length}/${steps.length}` : "";
      };
      const pinRequireFlag = (flag: string): string => {
        const value = pinOptionalFlag(flag);
        if (!value) {
          console.error(`${flag} is required`);
          process.exit(1);
        }
        return value;
      };
      const resolveRepo = (): string => {
        const explicit = pinOptionalFlag("--repo");
        return path.resolve(explicit ?? process.cwd());
      };
      const pinNumberFlag = (flag: string): number | undefined => {
        const value = pinOptionalFlag(flag);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          console.error(`${flag} must be a number`);
          process.exit(1);
        }
        return parsed;
      };

      if (command === "add") {
        const title = pinRequireFlag("--title");
        const pinBody = pinOptionalFlag("--body");
        const status = pinOptionalFlag("--status");
        const linkUrl = pinOptionalFlag("--link");
        const linkType = pinOptionalFlag("--link-type") ?? "url";
        const links = linkUrl ? [{ type: linkType, url: linkUrl }] : undefined;
        const kind = group === "note" ? "note" : (pinOptionalFlag("--kind") ?? "task");
        const steps = allFlags("--step");
        const result = await request("POST", "/pin/create", {
          title,
          repo: resolveRepo(),
          kind,
          body: pinBody,
          status,
          links,
          ...(steps.length ? { steps } : {}),
          actor,
          x: pinNumberFlag("--x"),
          y: pinNumberFlag("--y"),
          w: pinNumberFlag("--w"),
          h: pinNumberFlag("--h"),
        });
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.pin.id}  ${result.pin.title}`);
      } else if (command === "list") {
        const repo = resolveRepo();
        const statusFilter = pinOptionalFlag("--status");
        const wanted = statusFilter ? parsePinStatus(statusFilter) : null;
        if (statusFilter && !wanted) {
          console.error(`Unknown status: ${statusFilter} (todo, doing, needs-you, done, dropped)`);
          process.exit(1);
        }
        const kindFilter = group === "note" ? "note" : group === "task" ? "task" : pinOptionalFlag("--kind");
        const result = await request(
          "GET",
          `/pin/list?repo=${encodeURIComponent(repo)}`,
        );
        const pins = result.pins.filter(
          (t: any) => (!wanted || t.status === wanted) && (!kindFilter || pinKind(t) === kindFilter),
        );
        if (jsonFlag) {
          console.log(JSON.stringify({ pins }, null, 2));
          return;
        }
        if (pins.length === 0) {
          console.log(group === "note" ? "No notes." : "No tasks.");
          return;
        }
        for (const t of pins) {
          const linkSuffix = t.links?.length ? `  [${t.links.length} link]` : "";
          const label = pinKind(t) === "note" ? "note" : `${STATUS_LABEL[t.status] ?? t.status}${progressOf(t)}`;
          console.log(`${t.id}  [${label}]  ${t.title}${linkSuffix}`);
        }
      } else if (command === "show" && rest[0]) {
        const id = rest[0];
        const repo = resolveRepo();
        const result = await request(
          "GET",
          `/pin/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const t = result.pin;
        console.log(`id:      ${t.id}`);
        console.log(`kind:    ${pinKind(t)}`);
        console.log(`title:   ${t.title}`);
        if (pinKind(t) === "task") console.log(`status:  ${STATUS_LABEL[t.status] ?? t.status}${progressOf(t)}`);
        if (t.owners?.length) console.log(`owners:  ${t.owners.join(", ")}`);
        if (t.ask) console.log(`asks:    ${t.ask.reason}${t.ask.choices?.length ? `  (${t.ask.choices.join(" / ")})` : ""}`);
        console.log(`created: ${t.created}`);
        console.log(`updated: ${t.updated}`);
        if (t.steps?.length) {
          console.log(`steps:`);
          t.steps.forEach((s: any, i: number) => console.log(`  ${i + 1}. ${STEP_MARK[s.status] ?? "○"} ${s.text}`));
        }
        if (t.links?.length) {
          console.log(`links:`);
          for (const l of t.links) {
            console.log(`  - ${l.type}: ${l.url}`);
          }
        }
        if (t.body) {
          console.log("");
          console.log(t.body);
        }
      } else if (command === "render" && rest[0]) {
        const id = rest[0];
        const repo = resolveRepo();
        const payload: Record<string, unknown> = { repo };
        const out = pinOptionalFlag("--out");
        if (out !== undefined) payload.outputPath = path.resolve(out);
        const width = pinNumberFlag("--width");
        if (width !== undefined) payload.width = width;
        const height = pinNumberFlag("--height");
        if (height !== undefined) payload.height = height;
        const waitMs = pinNumberFlag("--wait-ms");
        if (waitMs !== undefined) payload.waitMs = waitMs;
        if (rest.includes("--full-page")) payload.fullPage = true;

        const result = await request(
          "POST",
          `/pin/${encodeURIComponent(id)}/render`,
          payload,
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.image_path);
      } else if (command === "update" && rest[0]) {
        const id = rest[0];
        const repo = resolveRepo();
        const payload: Record<string, unknown> = { repo, actor };
        const newKind = pinOptionalFlag("--kind");
        if (newKind !== undefined) payload.kind = newKind;
        const newTitle = pinOptionalFlag("--title");
        if (newTitle !== undefined) payload.title = newTitle;
        const newStatus = pinOptionalFlag("--status");
        if (newStatus !== undefined) payload.status = newStatus;
        const newBody = pinOptionalFlag("--body");
        if (newBody !== undefined) payload.body = newBody;
        const newX = pinNumberFlag("--x");
        if (newX !== undefined) payload.x = newX;
        const newY = pinNumberFlag("--y");
        if (newY !== undefined) payload.y = newY;
        const newW = pinNumberFlag("--w");
        if (newW !== undefined) payload.w = newW;
        const newH = pinNumberFlag("--h");
        if (newH !== undefined) payload.h = newH;
        const result = await request(
          "PUT",
          `/pin/${encodeURIComponent(id)}`,
          payload,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Updated ${result.pin.id}`);
      } else if ((command === "step" || command === "ask" || command === "assign" || command === "done") && rest[0]) {
        // The task changes agents make most: a step on, a question for the
        // person, who's on it, done.
        const id = rest[0];
        const repo = resolveRepo();
        const current = (await request("GET", `/pin/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`)).pin;
        const payload: Record<string, unknown> = { repo, actor };
        if (command === "done") {
          payload.status = "done";
        } else if (command === "step") {
          const steps: any[] = [...(current.steps ?? [])];
          const add = pinOptionalFlag("--add");
          if (add) {
            steps.push({ text: add, status: "pending" });
          } else {
            const n = Number(rest[1]);
            if (!Number.isInteger(n) || n < 1 || n > steps.length) {
              console.error(`Step number 1-${steps.length || 0}, or --add "<text>"`);
              process.exit(1);
            }
            const wantedStatus = (pinOptionalFlag("--status") ?? "done").toLowerCase();
            const status = wantedStatus === "doing" || wantedStatus === "active" || wantedStatus === "in_progress" ? "active" : wantedStatus === "todo" || wantedStatus === "pending" ? "pending" : "done";
            steps[n - 1] = { ...steps[n - 1], status };
          }
          payload.steps = steps;
        } else if (command === "ask") {
          const reason = rest[1];
          if (!reason || reason.startsWith("--")) {
            console.error('Usage: tacit task ask <id> "<question>" [--choices a,b]');
            process.exit(1);
          }
          const choices = pinOptionalFlag("--choices")?.split(",").map((c) => c.trim()).filter(Boolean);
          payload.ask = { reason, ...(choices?.length ? { choices } : {}), ...(process.env.TACIT_TERMINAL_ID ? { by: process.env.TACIT_TERMINAL_ID.trim() } : {}) };
        } else {
          const to = pinOptionalFlag("--to") ?? "me";
          const owner = to === "me" ? process.env.TACIT_TERMINAL_ID?.trim() : to;
          if (!owner) {
            console.error("--to me works inside a Tacit terminal; else --to manager or a terminal id");
            process.exit(1);
          }
          payload.owners = rest.includes("--remove")
            ? (current.owners ?? []).filter((o: string) => o !== owner)
            : [...new Set([...(current.owners ?? []), owner])];
        }
        const result = await request("PUT", `/pin/${encodeURIComponent(id)}`, payload);
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.pin.id}  [${STATUS_LABEL[result.pin.status] ?? result.pin.status}${progressOf(result.pin)}]  ${result.pin.title}`);
      } else if ((command === "rm" || command === "remove") && rest[0]) {
        const id = rest[0];
        const repo = resolveRepo();
        const result = await request(
          "DELETE",
          `/pin/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
        );
        if (jsonFlag) console.log(JSON.stringify(result, null, 2));
        else console.log(`Removed ${id}`);
      } else {
        console.log(
          "Usage: tacit task <add|list|show|step|ask|assign|done|update|render|rm> [args]   (tacit pin works too; tacit note add makes a note)\n" +
          "  task add --title <t> [--step <text>]... [--body <b>] [--status todo|doing|done] [--link <url>] [--link-type <type>] [--repo <path>]\n" +
          "  task list [--status todo|doing|needs-you|done|dropped] [--repo <path>]\n" +
          "  task show <id> [--repo <path>]\n" +
          "  task step <id> <n> [--status todo|doing|done]   |   task step <id> --add <text>\n" +
          "  task ask <id> <question> [--choices a,b]        (sets Needs you; the answer comes into this terminal)\n" +
          "  task assign <id> [--to me|manager|<terminal-id>] [--remove]\n" +
          "  task done <id>\n" +
          "  task update <id> [--title <t>] [--status <s>] [--body <b>] [--kind task|note] [--x N] [--y N] [--w N] [--h N] [--repo <path>]\n" +
          "  task render <id> [--repo <path>] [--out <png>] [--width N] [--height N] [--wait-ms N] [--full-page]\n" +
          "  task rm <id> [--repo <path>]",
        );
      }
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
      console.log(
        "  task add --title <t> [--step <s>]... [--body <b>]  Record a task (pin works too)",
      );
      console.log(
        "  task list [--status todo|doing|needs-you|done]   List tasks for cwd repo",
      );
      console.log(
        "  task show <id>                             Show a task: status, steps, owners",
      );
      console.log(
        "  task step <id> <n> [--status doing|done]   Move a step on (or --add <text>)",
        "  task ask <id> <question> [--choices a,b]   Ask the person (sets Needs you)",
        "  task render <id>                           Render a task's HTML/Markdown to PNG",
      );
      console.log(
        "  task update <id> [--title|--status|--body] Edit a task",
      );
      console.log(
        "  task rm <id>                               Delete a task",
      );
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
