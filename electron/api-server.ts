import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "http";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { PtyManager } from "./pty-manager";
import type { ProjectScanner } from "./project-scanner";
import { getApiDiff } from "./git-diff";
import type { TelemetryService } from "./telemetry-service";
import { buildGitWorktreeRemoveArgs } from "../hydra/src/cleanup";
import {
  buildGitWorktreeAddArgs,
  validateWorktreePath,
} from "../hydra/src/spawn";
import { PinStore, PinStoreError } from "./pin-store";
import { resolveCanvasProjectRoot } from "./pin-project-resolver";
import { renderPinToPng } from "./pin-render";
import { cleanupPinRenderCache } from "./pin-render-utils";
import { sendToWindow } from "./window-events";
import {
  createDefaultComposerSubmitDeps,
  submitComposerRequest,
} from "./composer-submit";
import type { ComposerSubmitRequest } from "../src/types";
import type { RecallService } from "./recall-service";
import type { RecallQuery } from "../shared/recall";

interface ApiServerDeps {
  getWindow: () => BrowserWindow | null;
  ptyManager: PtyManager;
  projectScanner: ProjectScanner;
  telemetryService: TelemetryService;
  taskStore: PinStore;
  dataUrlToPngBuffer: (dataUrl: string) => Buffer;
  recallService: RecallService;
}

export class ApiServer {
  private server: http.Server | null = null;
  private deps: ApiServerDeps;

  constructor(deps: ApiServerDeps) {
    this.deps = deps;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res),
      );
      this.server.timeout = 30_000;
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(port);
      });
      this.server.on("error", reject);
    });
  }

  stop() {
    this.server?.close();
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    res.setHeader("Content-Type", "application/json");

    try {
      const body =
        method === "POST" || method === "PUT" || method === "DELETE"
          ? await this.readBody(req)
          : null;
      const result = await this.route(method, pathname, url, body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err: any) {
      const status = err.status ?? 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: err.message ?? "Internal error" }));
    }
  }

  private async route(
    method: string,
    pathname: string,
    url: URL,
    body: any,
  ): Promise<any> {
    if (method === "POST" && pathname === "/project/add") {
      return this.projectAdd(body);
    }
    if (method === "GET" && pathname === "/project/list") {
      return this.projectList();
    }
    if (method === "DELETE" && pathname.match(/^\/project\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.projectRemove(id);
    }
    if (method === "POST" && pathname.match(/^\/project\/[^/]+\/rescan$/)) {
      const id = pathname.split("/")[2];
      return this.projectRescan(id);
    }

    if (method === "GET" && pathname === "/worktree/list") {
      const repoPath = url.searchParams.get("repo");
      return this.worktreeList(repoPath);
    }
    if (method === "POST" && pathname === "/worktree/create") {
      return this.worktreeCreate(body);
    }
    if (method === "DELETE" && pathname === "/worktree") {
      return this.worktreeRemove(url);
    }

    if (method === "POST" && pathname === "/terminal/create") {
      return this.terminalCreate(body);
    }
    if (method === "GET" && pathname === "/terminal/list") {
      const worktree = url.searchParams.get("worktree");
      return this.terminalList(worktree);
    }
    if (method === "GET" && pathname.match(/^\/terminal\/[^/]+\/status$/)) {
      const id = pathname.split("/")[2];
      return this.terminalStatus(id);
    }
    if (method === "GET" && pathname.match(/^\/terminal\/[^/]+\/output$/)) {
      const id = pathname.split("/")[2];
      const lines = parseInt(url.searchParams.get("lines") ?? "50", 10);
      return this.terminalOutput(id, lines);
    }
    if (method === "DELETE" && pathname.match(/^\/terminal\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.terminalDestroy(id);
    }
    if (
      method === "PUT" &&
      pathname.match(/^\/terminal\/[^/]+\/custom-title$/)
    ) {
      const id = pathname.split("/")[2];
      return this.terminalSetCustomTitle(id, body);
    }

    if (method === "GET" && pathname.match(/^\/telemetry\/terminal\/[^/]+$/)) {
      const id = pathname.split("/")[3];
      return this.terminalTelemetry(id);
    }
    if (
      method === "GET" &&
      pathname.match(/^\/telemetry\/terminal\/[^/]+\/events$/)
    ) {
      const id = pathname.split("/")[3];
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      return this.terminalTelemetryEvents(id, limit, cursor);
    }
    if (method === "GET" && pathname.match(/^\/telemetry\/workflow\/[^/]+$/)) {
      const id = pathname.split("/")[3];
      const repoPath = url.searchParams.get("repo");
      return this.workflowTelemetry(id, repoPath);
    }

    if (method === "GET" && pathname.startsWith("/diff/")) {
      const worktreePath = decodeURIComponent(pathname.slice("/diff/".length));
      const summary = url.searchParams.has("summary");
      return this.getDiff(worktreePath, summary);
    }

    if (method === "GET" && pathname === "/api/memory/index") {
      const worktree = url.searchParams.get("worktree");
      return this.memoryIndex(worktree);
    }

    if (method === "GET" && pathname === "/state") {
      return this.getState();
    }

    if (method === "GET" && pathname === "/pin/list") {
      return this.pinList(url);
    }
    if (method === "POST" && pathname === "/pin/create") {
      return this.pinCreate(body);
    }
    if (method === "POST" && pathname.match(/^\/pin\/[^/]+\/render$/)) {
      const id = pathname.split("/")[2];
      return this.pinRender(id, body);
    }
    if (method === "GET" && pathname.match(/^\/pin\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.pinGet(url, id);
    }
    if (method === "PUT" && pathname.match(/^\/pin\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.pinUpdate(id, body);
    }
    if (method === "DELETE" && pathname.match(/^\/pin\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.pinRemove(url, id);
    }

    if (method === "GET" && pathname === "/browser/list") {
      return this.browserList();
    }
    if (method === "POST" && pathname === "/browser/create") {
      return this.browserCreate(body);
    }
    if (method === "PUT" && pathname.match(/^\/browser\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.browserUpdate(id, body);
    }
    if (method === "DELETE" && pathname.match(/^\/browser\/[^/]+$/)) {
      const id = pathname.split("/")[2];
      return this.browserRemove(id);
    }
    if (method === "POST" && pathname.match(/^\/browser\/[^/]+\/action$/)) {
      const id = pathname.split("/")[2];
      return this.browserAction(id, body);
    }
    if (method === "GET" && pathname.match(/^\/terminal\/[^/]+\/browser-binding$/)) {
      const id = pathname.split("/")[2];
      return this.terminalBrowserBinding(id);
    }
    if (method === "POST" && pathname.match(/^\/node\/[^/]+\/[^/]+\/emit$/)) {
      const parts = pathname.split("/");
      return this.nodeEmit(parts[2], parts[3], body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/remember$/)) {
      const id = pathname.split("/")[2];
      return this.terminalRemember(id, body);
    }
    if (method === "GET" && pathname === "/workspace/nodes") {
      return this.workspaceNodes();
    }
    if (method === "GET" && pathname.match(/^\/workspace\/node\/[^/]+\/[^/]+$/)) {
      const parts = pathname.split("/");
      return this.workspaceNodeState(parts[3], parts[4]);
    }
    if (method === "GET" && pathname === "/workspace/summary") {
      return this.workspaceSummary();
    }
    if (method === "GET" && pathname === "/workspace/memory-query") {
      const scope = url.searchParams.get("scope") ?? "workspace";
      const query = url.searchParams.get("q") ?? "";
      const worktree = url.searchParams.get("worktree");
      return this.workspaceMemoryQuery(scope, query, worktree);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/spawn-terminal$/)) {
      const id = pathname.split("/")[2];
      return this.spawnTerminal(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/spawn-browser$/)) {
      const id = pathname.split("/")[2];
      return this.spawnBrowser(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/spawn-note$/)) {
      const id = pathname.split("/")[2];
      return this.spawnNote(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/recall$/)) {
      return this.recall(body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/connect-nodes$/)) {
      const id = pathname.split("/")[2];
      return this.connectNodes(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/log-activity$/)) {
      const id = pathname.split("/")[2];
      return this.logActivity(id, body);
    }

    throw Object.assign(new Error("Not found"), { status: 404 });
  }

  private async execRenderer(code: string): Promise<any> {
    const win = this.deps.getWindow();
    if (!win)
      throw Object.assign(new Error("No active window"), { status: 503 });

    // Wrap in renderer-side try-catch so the actual error message survives
    // instead of Electron's generic "Script failed to execute" wrapper.
    const wrapped = `(async()=>{try{return await(${code})}catch(e){return{__tcErr:true,message:e.message,stack:e.stack}}})()`;
    const result = await win.webContents.executeJavaScript(wrapped);
    if (result && result.__tcErr) {
      throw Object.assign(new Error(result.message), { status: 500 });
    }
    return result;
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data, "utf8") > 1024 * 1024) {
          reject(
            Object.assign(new Error("Request body too large"), { status: 413 }),
          );
        }
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  private async projectAdd(body: any) {
    const dirPath = body?.path;
    if (!dirPath)
      throw Object.assign(new Error("path is required"), { status: 400 });

    const scanned = this.deps.projectScanner.scan(dirPath);
    if (!scanned)
      throw Object.assign(new Error("Not a git repository"), { status: 400 });

    const projectData = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: scanned.name,
      path: scanned.path,
      position: { x: 0, y: 0 },
      collapsed: false,
      zIndex: 0,
      worktrees: scanned.worktrees.map((wt: any, i: number) => ({
        id: `${Date.now()}-wt-${i}`,
        name: wt.branch,
        path: wt.path,
        position: { x: 0, y: i * 400 },
        collapsed: false,
        terminals: [],
      })),
    };

    await this.execRenderer(
      `window.__tcApi.addProject(${JSON.stringify(projectData)})`,
    );
    return {
      id: projectData.id,
      name: projectData.name,
      worktrees: projectData.worktrees.length,
    };
  }

  private async projectList() {
    return this.execRenderer(`window.__tcApi.getProjects()`);
  }

  private async projectRemove(id: string) {
    await this.execRenderer(
      `window.__tcApi.removeProject(${JSON.stringify(id)})`,
    );
    return { ok: true };
  }

  private async projectRescan(projectId: string) {
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const project = projects.find((p: any) => p.id === projectId);
    if (!project)
      throw Object.assign(new Error("Project not found"), { status: 404 });

    const worktrees = this.deps.projectScanner.listWorktrees(project.path);
    await this.execRenderer(
      `window.__tcApi.syncWorktrees(${JSON.stringify(project.path)}, ${JSON.stringify(worktrees)})`,
    );
    return { ok: true, worktrees: worktrees.length };
  }

  private worktreeList(repoPath: string | null) {
    if (!repoPath) {
      throw Object.assign(new Error("repo query parameter is required"), {
        status: 400,
      });
    }
    const repo = path.resolve(repoPath);
    return this.deps.projectScanner.listWorktrees(repo);
  }

  private async worktreeCreate(body: any) {
    const repoInput = body?.repo ?? body?.repoPath;
    const branch = body?.branch as string | undefined;
    const requestedPath = body?.path ?? body?.worktreePath;
    const baseBranch = body?.baseBranch as string | undefined;
    if (!repoInput) {
      throw Object.assign(new Error("repo is required"), { status: 400 });
    }
    if (!branch) {
      throw Object.assign(new Error("branch is required"), { status: 400 });
    }

    const repo = path.resolve(repoInput);
    const resolvedWorktree = validateWorktreePath(
      repo,
      requestedPath
        ? path.resolve(requestedPath)
        : path.join(repo, ".worktrees", branch.replace(/[\\/]/g, "-")),
    );
    const base = baseBranch?.trim() || this.getCurrentBranch(repo);

    execFileSync(
      "git",
      buildGitWorktreeAddArgs(branch, resolvedWorktree, base),
      { cwd: repo, encoding: "utf-8" },
    );

    const worktrees = await this.syncRepoWorktrees(repo);
    return {
      path: resolvedWorktree,
      branch,
      base_branch: base,
      worktrees,
    };
  }

  private async worktreeRemove(url: URL) {
    const repoInput = url.searchParams.get("repo");
    const worktreeInput = url.searchParams.get("path");
    if (!repoInput) {
      throw Object.assign(new Error("repo query parameter is required"), {
        status: 400,
      });
    }
    if (!worktreeInput) {
      throw Object.assign(new Error("path query parameter is required"), {
        status: 400,
      });
    }
    const forceParam = url.searchParams.get("force");
    const force = forceParam === "1" || forceParam === "true";

    const repo = path.resolve(repoInput);
    const resolvedWorktree = validateWorktreePath(repo, worktreeInput);
    const args = force
      ? buildGitWorktreeRemoveArgs(resolvedWorktree)
      : ["worktree", "remove", resolvedWorktree];
    execFileSync("git", args, { cwd: repo, encoding: "utf-8" });

    const worktrees = await this.syncRepoWorktrees(repo);
    return { ok: true, path: resolvedWorktree, worktrees };
  }

  private getCurrentBranch(repoPath: string): string {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "main";
    }
  }

  private async syncRepoWorktrees(repo: string) {
    const worktrees = this.deps.projectScanner.listWorktrees(repo);
    try {
      await this.execRenderer(
        `window.__tcApi.syncWorktrees(${JSON.stringify(repo)}, ${JSON.stringify(worktrees)})`,
      );
    } catch {
      // Renderer may not be ready or project may not be tracked in UI; the
      // git operation already succeeded and the scan reflects on-disk state.
    }
    return worktrees;
  }

  private async terminalCreate(body: any) {
    const worktree = body?.worktree;
    const type = body?.type ?? "shell";
    const prompt = body?.prompt as string | undefined;
    const autoApprove = body?.autoApprove as boolean | undefined;
    const parentTerminalId = body?.parentTerminalId as string | undefined;
    const workflowId = body?.workflowId as string | undefined;
    const assignmentId = body?.assignmentId as string | undefined;
    const repoPath = body?.repoPath as string | undefined;
    if (!worktree)
      throw Object.assign(new Error("worktree path is required"), {
        status: 400,
      });

    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    let projectId: string | null = null;
    let worktreeId: string | null = null;

    for (const p of projects) {
      for (const w of p.worktrees) {
        if (w.path === worktree) {
          projectId = p.id;
          worktreeId = w.id;
          break;
        }
      }
      if (projectId) break;
    }

    if (!projectId || !worktreeId) {
      throw Object.assign(new Error("Worktree not found on canvas"), {
        status: 404,
      });
    }

    const terminal = await this.execRenderer(
      `window.__tcApi.addTerminal(${JSON.stringify(projectId)}, ${JSON.stringify(worktreeId)}, ${JSON.stringify(type)}, ${JSON.stringify(prompt)}, ${JSON.stringify(!!autoApprove)}, ${JSON.stringify(parentTerminalId ?? null)})`,
    );
    this.deps.telemetryService.registerTerminal({
      terminalId: terminal.id,
      worktreePath: worktree,
      provider: type === "claude" || type === "codex" ? type : "unknown",
      workflowId,
      assignmentId,
      repoPath,
    });
    return { id: terminal.id, type: terminal.type, title: terminal.title };
  }

  private async terminalList(worktreePath: string | null) {
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const terminals: any[] = [];

    for (const p of projects) {
      for (const w of p.worktrees) {
        if (worktreePath && w.path !== worktreePath) continue;
        for (const t of w.terminals) {
          terminals.push({
            id: t.id,
            title: t.title,
            type: t.type,
            status: t.status,
            ptyId: t.ptyId,
            worktree: w.path,
            project: p.name,
          });
        }
      }
    }
    return terminals;
  }

  private async terminalStatus(terminalId: string) {
    const terminal = await this.execRenderer(
      `window.__tcApi.getTerminal(${JSON.stringify(terminalId)})`,
    );
    if (!terminal)
      throw Object.assign(new Error("Terminal not found"), { status: 404 });
    return { id: terminal.id, status: terminal.status, ptyId: terminal.ptyId };
  }

  private async terminalOutput(terminalId: string, lines: number) {
    const terminal = await this.execRenderer(
      `window.__tcApi.getTerminal(${JSON.stringify(terminalId)})`,
    );
    if (!terminal)
      throw Object.assign(new Error("Terminal not found"), { status: 404 });
    if (!terminal.ptyId) return { id: terminalId, lines: [] };
    const output = this.deps.ptyManager.getOutput(terminal.ptyId, lines);
    return { id: terminalId, lines: output };
  }

  private async terminalDestroy(terminalId: string) {
    const terminal = await this.execRenderer(
      `window.__tcApi.getTerminal(${JSON.stringify(terminalId)})`,
    );
    if (!terminal)
      throw Object.assign(new Error("Terminal not found"), { status: 404 });
    if (terminal.ptyId) {
      this.deps.ptyManager.destroy(terminal.ptyId);
    }
    await this.execRenderer(
      `window.__tcApi.removeTerminal(${JSON.stringify(terminal.projectId)}, ${JSON.stringify(terminal.worktreeId)}, ${JSON.stringify(terminalId)})`,
    );
    return { ok: true };
  }

  private async terminalSetCustomTitle(terminalId: string, body: any) {
    const customTitle = body?.customTitle;
    if (typeof customTitle !== "string")
      throw Object.assign(new Error("customTitle is required"), {
        status: 400,
      });

    await this.execRenderer(
      `window.__tcApi.setCustomTitle(${JSON.stringify(terminalId)}, ${JSON.stringify(customTitle)})`,
    );
    return { ok: true };
  }

  private async terminalTelemetry(terminalId: string) {
    const snapshot = this.deps.telemetryService.getTerminalSnapshot(terminalId);
    if (!snapshot) {
      throw Object.assign(new Error("Telemetry terminal not found"), {
        status: 404,
      });
    }
    return snapshot;
  }

  private async terminalTelemetryEvents(
    terminalId: string,
    limit: number,
    cursor?: string,
  ) {
    return this.deps.telemetryService.listTerminalEvents({
      terminalId,
      limit,
      cursor,
    });
  }

  private async workflowTelemetry(workflowId: string, repoPath: string | null) {
    if (!repoPath) {
      throw Object.assign(new Error("repo query parameter is required"), {
        status: 400,
      });
    }
    const snapshot = this.deps.telemetryService.getWorkflowSnapshot(
      repoPath,
      workflowId,
    );
    if (!snapshot) {
      throw Object.assign(new Error("Workflow telemetry not found"), {
        status: 404,
      });
    }
    return snapshot;
  }

  private async memoryIndex(worktree: string | null) {
    if (!worktree) {
      throw Object.assign(new Error("worktree query parameter is required"), {
        status: 400,
      });
    }

    const { getMemoryDirForWorktree, scanMemoryDir } =
      await import("./memory-service.js");
    const { generateEnhancedIndex } =
      await import("./memory-index-generator.js");

    const memDir = getMemoryDirForWorktree(worktree);
    const graph = scanMemoryDir(memDir);
    const index = generateEnhancedIndex(graph.nodes);
    return { index };
  }

  private async getDiff(worktreePath: string, summary: boolean) {
    try {
      return await getApiDiff(worktreePath, summary);
    } catch (err: any) {
      throw Object.assign(new Error(`Failed to get diff: ${err.message}`), {
        status: 400,
      });
    }
  }

  private async getState() {
    return this.execRenderer(`window.__tcApi.getProjects()`);
  }

  private async pinList(url: URL) {
    const inputRepo = requireRepoQuery(url);
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    return { pins: this.deps.taskStore.list(canonicalRepo) };
  }

  private async pinCreate(body: any) {
    const inputRepo = body?.repo;
    if (!inputRepo) {
      throw Object.assign(new Error("repo is required"), { status: 400 });
    }
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    try {
      const pin = this.deps.taskStore.create({
        title: body?.title,
        repo: canonicalRepo,
        body: body?.body,
        status: body?.status,
        links: body?.links,
        x: body?.x,
        y: body?.y,
        w: body?.w,
        h: body?.h,
      });
      return { pin };
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
  }

  private async pinGet(url: URL, id: string) {
    const inputRepo = requireRepoQuery(url);
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    try {
      const pins = this.deps.taskStore.list(canonicalRepo);
      cleanupPinRenderCache(canonicalRepo, pins.map((pin) => pin.id));
      const pin = this.deps.taskStore.get(canonicalRepo, id);
      if (!pin) {
        throw Object.assign(new Error(`Pin not found: ${id}`), { status: 404 });
      }
      return { pin };
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
  }

  private async pinRender(id: string, body: any) {
    const inputRepo = body?.repo;
    if (!inputRepo) {
      throw Object.assign(new Error("repo is required"), { status: 400 });
    }
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    try {
      const pin = this.deps.taskStore.get(canonicalRepo, id);
      if (!pin) {
        throw Object.assign(new Error(`Pin not found: ${id}`), { status: 404 });
      }
      return await renderPinToPng(pin, {
        outputPath: body?.outputPath,
        width: body?.width,
        height: body?.height,
        waitMs: body?.waitMs,
        fullPage: body?.fullPage,
      });
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
  }

  private async pinUpdate(id: string, body: any) {
    const inputRepo = body?.repo;
    if (!inputRepo) {
      throw Object.assign(new Error("repo is required"), { status: 400 });
    }
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    try {
      const pin = this.deps.taskStore.update(canonicalRepo, id, {
        title: body?.title,
        status: body?.status,
        body: body?.body,
        links: body?.links,
        x: body?.x,
        y: body?.y,
        w: body?.w,
        h: body?.h,
      });
      return { pin };
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
  }

  private async pinRemove(url: URL, id: string) {
    const inputRepo = requireRepoQuery(url);
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    const canonicalRepo = resolveCanvasProjectRoot(inputRepo, projects);
    try {
      this.deps.taskStore.remove(canonicalRepo, id);
      return { ok: true };
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
  }

  // Browser tiles only exist in the renderer's Zustand store (unlike pins,
  // which are file-backed and owned here) — every route round-trips through
  // execRenderer/window.__tcApi rather than touching a main-process store.

  private async browserList() {
    const cards = await this.execRenderer(`window.__tcApi.listBrowserCards()`);
    return { cards };
  }

  private async browserCreate(body: any) {
    const url = body?.url;
    if (!url) {
      throw Object.assign(new Error("url is required"), { status: 400 });
    }
    const x = typeof body?.x === "number" ? body.x : undefined;
    const y = typeof body?.y === "number" ? body.y : undefined;
    const id = await this.execRenderer(
      `window.__tcApi.addBrowserCard(${JSON.stringify(url)}, ${JSON.stringify(x)}, ${JSON.stringify(y)})`,
    );
    return { id };
  }

  private async browserUpdate(id: string, body: any) {
    await this.execRenderer(
      `window.__tcApi.updateBrowserCard(${JSON.stringify(id)}, ${JSON.stringify(body ?? {})})`,
    );
    return { ok: true };
  }

  private async browserRemove(id: string) {
    await this.execRenderer(
      `window.__tcApi.removeBrowserCard(${JSON.stringify(id)})`,
    );
    return { ok: true };
  }

  private async browserAction(id: string, body: any) {
    const action = body?.action;
    if (!action) {
      throw Object.assign(new Error("action is required"), { status: 400 });
    }
    const params = body?.params ?? {};

    // Lets the canvas visually pulse the connection while a browser-bridge
    // tool call is actually in flight (see src/canvas/ConnectionLayer.tsx,
    // src/stores/bridgeActivityStore.ts). Keyed by requestId, not just
    // browserId, so a stale "end" from an earlier call can't clear a pulse
    // for a newer one that started on the same browser tile before it.
    const requestId = randomUUID();
    const win = this.deps.getWindow();
    sendToWindow(win, "browser-bridge:call", {
      phase: "start",
      requestId,
      browserId: id,
      action,
    });

    try {
      const result = await this.execRenderer(
        `window.__tcApi.driveBrowserCard(${JSON.stringify(id)}, ${JSON.stringify(action)}, ${JSON.stringify(params)})`,
      );
      sendToWindow(win, "browser-bridge:call", {
        phase: "end",
        requestId,
        browserId: id,
        action,
        ok: true,
      });
      return result;
    } catch (err) {
      sendToWindow(win, "browser-bridge:call", {
        phase: "end",
        requestId,
        browserId: id,
        action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async terminalBrowserBinding(terminalId: string) {
    return this.execRenderer(
      `window.__tcApi.getBrowserBindingForTerminal(${JSON.stringify(terminalId)})`,
    );
  }

  /**
   * Backs the emit_event MCP tool (termcanvas-bridge/src/mcp-server.ts): fans a
   * named event out to every node connected to `kind`/`id` on the canvas,
   * applying each target's built-in reaction — terminals get it as a new
   * prompt (reusing the same submitComposerRequest pipeline the wire-up
   * notice already uses), browsers navigate if payload.url is set (reusing
   * browserUpdate). Only terminals actually emit in practice — a browser
   * tile has no agent of its own to decide to — but the route stays kind-
   * general rather than hardcoding "terminal" as the only valid source.
   */
  private async nodeEmit(kind: string, id: string, body: any) {
    if (kind !== "terminal" && kind !== "browser") {
      throw Object.assign(new Error(`Unsupported node kind: ${kind}`), {
        status: 400,
      });
    }
    const type = body?.type;
    if (!type || typeof type !== "string") {
      throw Object.assign(new Error("type is required"), { status: 400 });
    }
    const payload = (body?.payload ?? {}) as Record<string, unknown>;

    const connected = (await this.execRenderer(
      `window.__tcApi.getConnectionsForNode(${JSON.stringify(kind)}, ${JSON.stringify(id)})`,
    )) as Array<
      | {
          kind: "terminal";
          id: string;
          ptyId: number | null;
          terminalType: string | null;
          worktreePath: string | null;
        }
      | { kind: "browser"; id: string }
      | { kind: "note"; id: string }
    >;

    const win = this.deps.getWindow();
    const notified: Array<{ kind: string; id: string; ok: boolean; reason?: string }> = [];

    for (const target of connected) {
      // Notes are connectable so their provenance is visible on the canvas,
      // but they hold no agent and no view — there is nothing for an event
      // to do to one. Skipped before the pulse so a note never lights up as
      // if it received something.
      if (target.kind === "note") {
        notified.push({
          kind: "note",
          id: target.id,
          ok: false,
          reason: "notes do not receive events",
        });
        continue;
      }

      const requestId = randomUUID();
      const pulseBase = {
        requestId,
        sourceKind: kind,
        sourceId: id,
        targetKind: target.kind,
        targetId: target.id,
        type,
      };
      sendToWindow(win, "canvas-bridge:event", { phase: "start", ...pulseBase });

      try {
        if (target.kind === "terminal") {
          if (!target.ptyId || !target.terminalType || !target.worktreePath) {
            notified.push({
              kind: "terminal",
              id: target.id,
              ok: false,
              reason: "target terminal not ready",
            });
            sendToWindow(win, "canvas-bridge:event", {
              phase: "end",
              ...pulseBase,
              ok: false,
            });
            continue;
          }
          const message =
            typeof payload.message === "string"
              ? payload.message
              : JSON.stringify(payload);
          const request: ComposerSubmitRequest = {
            terminalId: target.id,
            ptyId: target.ptyId,
            terminalType:
              target.terminalType as ComposerSubmitRequest["terminalType"],
            worktreePath: target.worktreePath,
            text: `[Event: ${type} from ${kind}:${id}] ${message}`,
            images: [],
          };
          const result = await submitComposerRequest(
            request,
            createDefaultComposerSubmitDeps(
              process.platform as "darwin" | "win32" | "linux",
              this.deps.dataUrlToPngBuffer,
              (ptyId: number, data: string) =>
                this.deps.ptyManager.write(ptyId, data),
            ),
          );
          notified.push({
            kind: "terminal",
            id: target.id,
            ok: result.ok,
            reason: result.ok ? undefined : (result.detail ?? result.error),
          });
        } else {
          const url = typeof payload.url === "string" ? payload.url : null;
          if (!url) {
            notified.push({
              kind: "browser",
              id: target.id,
              ok: false,
              reason: "no payload.url to navigate to",
            });
          } else {
            await this.browserUpdate(target.id, { url });
            notified.push({ kind: "browser", id: target.id, ok: true });
          }
        }
        sendToWindow(win, "canvas-bridge:event", {
          phase: "end",
          ...pulseBase,
          ok: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendToWindow(win, "canvas-bridge:event", {
          phase: "end",
          ...pulseBase,
          ok: false,
          error: message,
        });
        notified.push({ kind: target.kind, id: target.id, ok: false, reason: message });
      }
    }

    return { ok: true, notified };
  }

  /**
   * Backs the remember MCP tool: writes a durable note into this terminal's
   * project's shared memory directory — the same folder/format
   * electron/memory-service.ts's Memory tab already reads, so the note
   * shows up there for free (its fs.watch picks up any write regardless of
   * which process made it). Deliberately separate from nodeEmit above:
   * this has nothing to do with connections, it's readable by any agent on
   * this project whether or not anything is wired right now.
   */
  private async terminalRemember(terminalId: string, body: any) {
    const name = body?.name;
    const description = body?.description;
    const noteType = body?.type;
    const noteBody = body?.body;
    if (
      typeof name !== "string" ||
      typeof description !== "string" ||
      typeof noteBody !== "string" ||
      (noteType !== "project" && noteType !== "feedback" && noteType !== "reference")
    ) {
      throw Object.assign(
        new Error("name, description, body (all strings) and type ('project'|'feedback'|'reference') are required"),
        { status: 400 },
      );
    }

    const { worktreePath } = (await this.execRenderer(
      `window.__tcApi.getWorktreePathForTerminal(${JSON.stringify(terminalId)})`,
    )) as { worktreePath: string | null };
    if (!worktreePath) {
      return { ok: false, reason: "no worktree found for this terminal" };
    }

    const { getMemoryDirForWorktree } = await import("./memory-service.js");
    const memoryDir = getMemoryDirForWorktree(worktreePath);
    fs.mkdirSync(memoryDir, { recursive: true });

    const slug = slugify(name);
    const fileName = `${noteType}_${slug}.md`;
    const filePath = path.join(memoryDir, fileName);
    const content = `---\nname: ${slug}\ndescription: ${description}\ntype: ${noteType}\n---\n\n${noteBody}\n`;
    fs.writeFileSync(filePath, content, "utf-8");

    updateMemoryIndex(memoryDir, fileName, description);

    return { ok: true, filePath };
  }

  /** Backs the list_nodes MCP tool — open to any terminal, no gating. */
  private async workspaceNodes() {
    return this.execRenderer("window.__tcApi.listWorkspaceNodes()");
  }

  /** Backs the get_node_state MCP tool — open to any terminal, no gating. */
  private async workspaceNodeState(kind: string, id: string) {
    if (kind !== "terminal" && kind !== "browser" && kind !== "pin") {
      throw Object.assign(new Error(`Unsupported node kind: ${kind}`), {
        status: 400,
      });
    }
    return this.execRenderer(
      `window.__tcApi.getNodeState(${JSON.stringify(kind)}, ${JSON.stringify(id)})`,
    );
  }

  /**
   * Backs the get_workspace_summary MCP tool — the orientation call a
   * freshly-assigned (or freshly-swapped) workspace manager makes first.
   * Combines live renderer counts with the workspace memory scope's most
   * recently written journal entries, so "pick up where the last agent
   * left off" is a real read, not aspirational.
   */
  private async workspaceSummary() {
    const liveSummary = (await this.execRenderer(
      "window.__tcApi.getWorkspaceLiveSummary()",
    )) as {
      terminalCount: number;
      browserCount: number;
      pinCount: number;
      connectionCount: number;
      statusCounts: Record<string, number>;
    };
    const canvasId = (await this.execRenderer(
      "window.__tcApi.getActiveCanvasId()",
    )) as string;

    const { getMemoryDirForWorkspace, scanMemoryDir } = await import(
      "./memory-service.js"
    );
    const memDir = getMemoryDirForWorkspace(canvasId);
    let recentJournal: Array<{
      name: string;
      description: string;
      mtime: number;
    }> = [];
    try {
      const graph = scanMemoryDir(memDir);
      recentJournal = graph.nodes
        .filter((n) => n.fileName !== "MEMORY.md")
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10)
        .map((n) => ({
          name: n.name,
          description: n.description,
          mtime: n.mtime,
        }));
    } catch {
      // No journal directory yet — a freshly-assigned PM with nothing
      // written is a normal, expected state, not an error.
    }

    // The digest is what turns this from "what is on the canvas" into "what has
    // been going on here" — what the user keeps asking for, and what was tried
    // and dropped. A fresh holder needs that before it needs a node count.
    return { ...liveSummary, recentJournal, digest: this.deps.recallService.digest() };
  }

  /**
   * Backs the `recall` MCP tool. Open to any terminal, like query_memory:
   * reading what already happened grants nothing, and a sub-agent that can
   * check whether an approach was already abandoned is strictly better than
   * one that repeats it.
   */
  private async recall(body: any) {
    const query: RecallQuery = {
      text: typeof body?.query === "string" ? body.query : undefined,
      kinds: Array.isArray(body?.kinds) ? body.kinds : undefined,
      node: typeof body?.node === "string" ? body.node : undefined,
      since: typeof body?.since === "string" ? body.since : undefined,
      includeInjected: body?.include_injected === true,
      limit: typeof body?.limit === "number" ? Math.min(body.limit, 50) : 12,
    };
    const hits = this.deps.recallService.query(query);
    return {
      results: hits.map((h) => ({
        at: h.doc.at,
        kind: h.doc.kind,
        origin: h.doc.origin,
        summary: h.doc.summary,
        nodes: h.doc.nodes,
        why: h.why,
      })),
    };
  }

  /** Backs the query_memory MCP tool — open to any terminal, no gating
   * (read access is low-risk; only mutation is PM-gated). Defaults to the
   * workspace scope; pass scope=worktree&worktree=<path> for the older
   * per-worktree scope instead. */
  private async workspaceMemoryQuery(
    scope: string,
    query: string,
    worktree: string | null,
  ) {
    const { getMemoryDirForWorktree, getMemoryDirForWorkspace, scanMemoryDir } =
      await import("./memory-service.js");

    let memDir: string;
    if (scope === "worktree") {
      if (!worktree) {
        throw Object.assign(
          new Error("worktree query parameter is required when scope=worktree"),
          { status: 400 },
        );
      }
      memDir = getMemoryDirForWorktree(worktree);
    } else {
      const canvasId = (await this.execRenderer(
        "window.__tcApi.getActiveCanvasId()",
      )) as string;
      memDir = getMemoryDirForWorkspace(canvasId);
    }

    let graph;
    try {
      graph = scanMemoryDir(memDir);
    } catch {
      return { results: [] };
    }

    const q = query.trim().toLowerCase();
    const results = graph.nodes
      .filter((n) => n.fileName !== "MEMORY.md")
      .filter(
        (n) =>
          q.length === 0 ||
          n.name.toLowerCase().includes(q) ||
          n.description.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q),
      )
      .map((n) => ({
        name: n.name,
        description: n.description,
        type: n.type,
        body: n.body,
        mtime: n.mtime,
      }));

    return { results };
  }

  /** Shared gate for every PM-only mutating route below — live per-call
   * check against the active canvas's workspaceManagerTerminalId (renderer-
   * side state), not a session-time capability, so a role reassignment
   * mid-session takes effect on the very next call. */
  private async requireWorkspaceManager(terminalId: string): Promise<void> {
    const isManager = (await this.execRenderer(
      `window.__tcApi.isWorkspaceManager(${JSON.stringify(terminalId)})`,
    )) as boolean;
    if (!isManager) {
      throw Object.assign(
        new Error(
          "This terminal is not the workspace manager. Ask the user to assign the role from the Project chat pill first.",
        ),
        { status: 403 },
      );
    }
  }

  /** Backs the spawn_terminal MCP tool. */
  private async spawnTerminal(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    return this.execRenderer(
      `window.__tcApi.spawnTerminal(${JSON.stringify({
        requesterTerminalId: terminalId,
        type: body?.type,
        prompt: body?.prompt,
        position: body?.position,
        connectTo: body?.connectTo,
      })})`,
    );
  }

  /** Backs the spawn_browser MCP tool. */
  private async spawnBrowser(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const url = body?.url;
    if (!url || typeof url !== "string") {
      throw Object.assign(new Error("url is required"), { status: 400 });
    }
    return this.execRenderer(
      `window.__tcApi.spawnBrowser(${JSON.stringify({
        requesterTerminalId: terminalId,
        url,
        position: body?.position,
        connectTo: body?.connectTo,
      })})`,
    );
  }

  /** Backs the spawn_note MCP tool. */
  private async spawnNote(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const noteBody = body?.body;
    if (typeof noteBody !== "string") {
      throw Object.assign(new Error("body is required"), { status: 400 });
    }
    return this.execRenderer(
      `window.__tcApi.spawnNote(${JSON.stringify({
        requesterTerminalId: terminalId,
        body: noteBody,
        position: body?.position,
      })})`,
    );
  }

  /** Backs the connect_nodes MCP tool. */
  private async connectNodes(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const source = body?.source;
    const target = body?.target;
    if (!source?.kind || !source?.id || !target?.kind || !target?.id) {
      throw Object.assign(
        new Error("source and target ({kind, id}) are required"),
        { status: 400 },
      );
    }
    // terminalId is forwarded so the decision record attributes the wire to
    // the agent that asked for it rather than to the user — see CaptureActor.
    return this.execRenderer(
      `window.__tcApi.connectNodes(${JSON.stringify(source)}, ${JSON.stringify(target)}, ${JSON.stringify(terminalId)})`,
    );
  }

  /**
   * Backs the log_activity MCP tool — the workspace manager's continuous
   * journal, distinct from the curated/deduped `remember` tool: one file
   * per entry (no name/slug to dedupe against, append-only), so mtime
   * ordering naturally gives chronological order for free — the same
   * assumption workspaceSummary's recentJournal and workspaceMemoryQuery
   * both already make.
   */
  private async logActivity(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const event = body?.event;
    const detail = body?.detail ?? "";
    if (typeof event !== "string" || event.length === 0) {
      throw Object.assign(new Error("event is required"), { status: 400 });
    }

    const canvasId = (await this.execRenderer(
      "window.__tcApi.getActiveCanvasId()",
    )) as string;

    const { getMemoryDirForWorkspace } = await import("./memory-service.js");
    const memoryDir = getMemoryDirForWorkspace(canvasId);
    fs.mkdirSync(memoryDir, { recursive: true });

    const timestamp = new Date();
    const fileName = `activity_${timestamp.toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}.md`;
    const filePath = path.join(memoryDir, fileName);
    const slug = slugify(event);
    const content = `---\nname: ${slug}\ndescription: ${event}\ntype: project\n---\n\n${detail}\n`;
    fs.writeFileSync(filePath, content, "utf-8");

    updateMemoryIndex(memoryDir, fileName, event);

    return { ok: true, filePath };
  }
}

/** Lowercase, filesystem-safe slug — `name` is LLM-supplied and becomes a
 * filename, so this also closes off path traversal. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "note";
}

/** Appends (or, if already present, replaces in place) the index line for
 * `fileName` in this memory directory's MEMORY.md, so re-calling remember
 * with the same name updates the index instead of duplicating it. */
function updateMemoryIndex(memoryDir: string, fileName: string, description: string): void {
  const indexPath = path.join(memoryDir, "MEMORY.md");
  const line = `- [${description}](${fileName})`;
  let existing = "";
  try {
    existing = fs.readFileSync(indexPath, "utf-8");
  } catch {
    existing = "# Memory Index\n";
  }

  const linkPattern = new RegExp(`^-\\s*\\[.*\\]\\(${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\).*$`, "m");
  const next = linkPattern.test(existing)
    ? existing.replace(linkPattern, line)
    : `${existing.trimEnd()}\n${line}\n`;

  fs.writeFileSync(indexPath, next, "utf-8");
}

function requireRepoQuery(url: URL): string {
  const repo = url.searchParams.get("repo");
  if (!repo) {
    throw Object.assign(new Error("repo query parameter is required"), {
      status: 400,
    });
  }
  return repo;
}

function rethrowPinStoreError(err: unknown): Error {
  if (err instanceof PinStoreError) {
    return Object.assign(new Error(err.message), { status: err.status });
  }
  return err instanceof Error ? err : new Error(String(err));
}
