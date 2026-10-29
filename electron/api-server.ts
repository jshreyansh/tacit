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
import { parsePinStatus, pinKind, type PinStatus } from "../shared/pin";
import { resolveCanvasProjectRoot } from "./pin-project-resolver";
import { renderPinToPng } from "./pin-render";
import { cleanupPinRenderCache } from "./pin-render-utils";
import { sendToWindow } from "./window-events";
import {
  createDefaultComposerSubmitDeps,
  submitComposerRequest,
} from "./composer-submit";
import type { ComposerSubmitRequest, TrackedHandoffStatus } from "../src/types";
import type { RecallService } from "./recall-service";
import type { RecallQuery } from "../shared/recall";
import { createApiAuthToken, isAuthorizedBearer } from "./api-auth";
import type { ConnectedBrowserBroker } from "./connected-browser-broker";
import { CONNECTED_BROWSER_PROTOCOL_VERSION } from "../shared/browser-connection";
import { NodePromptSender, type PromptTargetNode } from "./node-prompt";
import {
  askAlongWire,
  handOffAlongWire,
  sendAlongWires,
  type WireDirection,
  type WireEnd,
  type WireSender,
} from "./wire-message";
import { WireAsks, interruptedText, type PendingAsk } from "./wire-asks";
import { TrackedHandoffs, restartReminder, trackedNotice, type TrackedHandoff } from "./tracked-handoff";
import { WireStateFile, WIRE_STATE_VERSION, type WireState } from "./wire-state";
import { loadRole } from "../hydra/src/roles/loader";
import { HydraStatusFeed, readHydraStatus } from "./hydra-wire-status";
import { readFinalAssistantReply } from "./reply-transcript";
import { canReadFinalReply } from "../shared/agent-reply";
import { snapshotSaysBusy, WireMailbox, type MailItem } from "./wire-mailbox";
import { envelopePreview, stepFromMessage } from "../shared/wire-envelope";
import { findAgentAdapter } from "../shared/agent-adapters";
import { busyStateOf, closeNode } from "./node-close";
import { managerEndRun, managerStartRun, type RunTracker } from "./run-tracker";
import { WorkerAdmission } from "./worker-admission";
import type { NodeEventLog } from "./node-events";
import { holdConnectionOpen, WAIT_IDLE_TIMEOUT_MS, waitForNodes } from "./node-wait";
import type { CaptureEvent, CaptureNodeRef } from "../shared/capture";
import type { WebReadTracker } from "./web-read-tracker";
import { journalWriteEvent, writeJournalEntry, writeProjectNote, type JournalProvenance } from "./memory-notes";
import type { WorkerCaps } from "../shared/worker-cap";

interface ApiServerDeps {
  getWindow: () => BrowserWindow | null;
  ptyManager: PtyManager;
  projectScanner: ProjectScanner;
  telemetryService: TelemetryService;
  taskStore: PinStore;
  dataUrlToPngBuffer: (dataUrl: string) => Buffer;
  recallService: RecallService;
  connectedBrowserBroker: ConnectedBrowserBroker;
  /**
   * Records text one agent typed into another terminal, attributed to the
   * sender, and keeps the prompt hook from filing its echo as the user's.
   */
  recordAgentPrompt: (input: {
    targetTerminalId: string;
    by: CaptureNodeRef;
    text: string;
  }) => void;
  /** Appends an entry to the decision record, attributed to main. */
  recordDecision: (event: CaptureEvent) => void;
  /** How many workers a manager may have open; shared/worker-cap.ts. */
  workerCaps: WorkerCaps;
  /** Worker state changes (T3.5); terminals feed it from telemetry. */
  nodeEvents: NodeEventLog;
  /** The open run (T4.1); see electron/run-tracker.ts. */
  runs: Pick<RunTracker, "current" | "start" | "end" | "adoptRecentAuto" | "refused">;
  /** Which terminals read web content, for journal writes (SHR-63). */
  webReads: Pick<WebReadTracker, "provenance">;
  /** Which agent a node runs; the record's `harness`. */
  harnessOf: (ref: string) => string | null;
  /**
   * Where what the wires are waiting on is kept across restarts
   * (electron/wire-state.ts).
   */
  wireStatePath: string;
}

/** A connection quiet for this long is dropped; wait_for_nodes gets longer. */
const API_IDLE_TIMEOUT_MS = 30_000;
const WAIT_NODES_ROUTE = /^\/terminal\/[^/]+\/wait-nodes$/;
const START_TASK_ROUTE = /^\/terminal\/[^/]+\/start-task$/;
const END_TASK_ROUTE = /^\/terminal\/[^/]+\/end-task$/;

const BROWSER_CONNECTOR_ROUTES = new Set([
  "/browser-connect/complete",
  "/browser-connect/tab",
  "/browser-connect/poll",
  "/browser-connect/result",
  "/browser-connect/revoke",
]);

function isBrowserConnectorRoute(method: string, pathname: string): boolean {
  return method === "POST" && BROWSER_CONNECTOR_ROUTES.has(pathname);
}

/** What a read-only wire to a browser still allows. */
const READ_ONLY_BROWSER_ACTIONS: ReadonlySet<string> = new Set(["read", "screenshot"]);

interface BrowserBinding {
  browserId: string | null;
  access: "read" | "drive" | null;
}

export class ApiServer {
  private server: http.Server | null = null;
  private deps: ApiServerDeps;
  private readonly authToken = createApiAuthToken();

  private readonly nodePrompts = new NodePromptSender({
    findNode: (id) => this.findNode(id),
    deliver: async (delivery) => {
      const result = await this.submitToTerminal({
        terminalId: delivery.terminalId,
        ptyId: delivery.ptyId,
        terminalType: delivery.terminalType as ComposerSubmitRequest["terminalType"],
        worktreePath: delivery.worktreePath,
        text: delivery.text,
        images: [],
      });
      return { ok: result.ok, detail: result.ok ? undefined : (result.detail ?? result.error) };
    },
    recordPrompt: ({ target, by, text }) =>
      this.deps.recordAgentPrompt({
        targetTerminalId: target,
        by: `terminal:${by}`,
        text,
      }),
  });

  private readonly workerAdmission: WorkerAdmission;

  /** Messages along wires to agents that are mid-turn (electron/wire-mailbox.ts). */
  readonly wireMailbox: WireMailbox;
  /** Questions asked over wires whose answers go back (electron/wire-asks.ts). */
  private readonly wireAsks: WireAsks;
  /** Hand-offs tracked by Hydra's result contract (electron/tracked-handoff.ts). */
  private readonly trackedHandoffs: TrackedHandoffs;
  private readonly hydraStatus = new HydraStatusFeed();
  private readonly mailboxSweep: ReturnType<typeof setInterval>;
  /** Last turn state seen per terminal, to notice a turn ending. */
  private readonly lastTurnState = new Map<string, string | undefined>();
  private readonly wireStateFile: WireStateFile;
  /** What was saved when the app last closed, until the first restart takes it in. */
  private savedWireState: WireState | null;
  private wireStateSave: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the window is up and has said so (wires:window-ready). Until it
   * is, nothing is delivered: delivery needs the canvas to find terminals.
   */
  private windowReady = false;
  /** Set by a restart, told to the window once it is ready. */
  private restartFollowUp: { interrupted: PendingAsk[]; problem?: string } | null = null;
  /** While a restart's follow-up runs, messages to agents are held with the rest. */
  private followingUpRestart = false;
  /** Set as the app quits: what was saved then is what the next start gets. */
  private wireStateFrozen = false;
  /** Saving failed and the user was told; said once until it works again. */
  private wireStateSaveFailed = false;

  constructor(deps: ApiServerDeps) {
    this.deps = deps;
    this.wireStateFile = new WireStateFile(deps.wireStatePath);
    const loaded = this.wireStateFile.load();
    this.savedWireState = loaded.state;
    if (loaded.problem) this.restartFollowUp = { interrupted: [], problem: loaded.problem };
    this.wireMailbox = new WireMailbox({
      isBusy: (terminalId) => snapshotSaysBusy(this.deps.telemetryService.getTerminalSnapshot(terminalId)),
      turnStartedAt: (terminalId) =>
        Date.parse(this.deps.telemetryService.getTerminalSnapshot(terminalId)?.turn_started_at ?? "") || null,
      deliver: (item) => this.typeMailItem(item),
      changed: (terminalId, view) => {
        sendToWindow(this.deps.getWindow(), "wire-mailbox:changed", {
          terminalId,
          waiting: view.waiting.map(({ id, from, preview, at }) => ({ id, from, preview, at })),
          held: view.held,
        });
        this.scheduleWireStateSave();
      },
      now: () => Date.now(),
    });
    this.wireAsks = new WireAsks({
      readReply: (ask) => {
        const snapshot = this.deps.telemetryService.getTerminalSnapshot(ask.targetId);
        return readFinalAssistantReply({
          sessionId: snapshot?.session_id ?? "",
          provider: snapshot?.provider ?? "unknown",
          cwd: ask.cwd,
        });
      },
      answer: async (ask, text) => {
        const asker = await this.findNode(ask.askerId);
        if (!asker || asker.kind !== "terminal" || asker.ptyId == null || !asker.terminalType || !asker.worktreePath) {
          console.warn(`[wire-asks] ${ask.askerId} is gone; the answer from ${ask.targetId} wasn't delivered`);
          return;
        }
        await this.deliverAlongWire({
          terminalId: asker.id,
          ptyId: asker.ptyId,
          terminalType: asker.terminalType,
          worktreePath: asker.worktreePath,
          text,
          from: `terminal:${ask.targetId}`,
        });
      },
      now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      changed: () => this.scheduleWireStateSave(),
    });
    this.trackedHandoffs = new TrackedHandoffs({
      writeFile: (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
      },
      readFile: (file) => {
        try {
          return fs.readFileSync(file, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      },
      modifiedAt: (file) => {
        try {
          return fs.statSync(file).mtimeMs;
        } catch {
          return null;
        }
      },
      tellSender: (handoff, text) => this.tellTerminal(handoff.senderId, text, `terminal:${handoff.targetId}`),
      tellTarget: (handoff, text) => this.tellTerminal(handoff.targetId, text, `terminal:${handoff.senderId}`),
      flag: (handoff, outcome, reason) =>
        sendToWindow(this.deps.getWindow(), "wire:tracked-flag", {
          senderTitle: handoff.senderTitle,
          targetTitle: handoff.targetTitle,
          outcome,
          reason: reason ?? null,
          report: path.join(handoff.dir, "report.md"),
        }),
      record: (handoff, state, reason) => {
        this.deps.recordDecision({
          kind: "tracked_handoff",
          from: `terminal:${handoff.senderId}`,
          to: `terminal:${handoff.targetId}`,
          handoff_id: handoff.id,
          state,
          ...(reason ? { stuck_reason: reason } : {}),
          dir: handoff.dir,
          by: `terminal:${handoff.targetId}`,
        });
        this.sendHandoffStatus(handoff, state === "completed" ? "done" : state);
      },
      now: () => Date.now(),
      join: (...parts) => path.join(...parts),
      changed: () => this.scheduleWireStateSave(),
    });
    // Turn ends arrive as telemetry changes (main.ts calls
    // onTerminalSnapshot), but a signal can be missed; this catches
    // anything left waiting, and gives up on answers that never came.
    this.mailboxSweep = setInterval(() => {
      if (!this.windowReady) return;
      for (const terminalId of this.wireMailbox.terminalsWithMail()) void this.wireMailbox.poke(terminalId);
      void this.wireAsks.sweep();
      void this.trackedHandoffs.sweep().catch((err) => console.warn("[tracked-handoff] sweep failed", err));
      const statuses = this.deps.telemetryService.hydraWorkers().map(readHydraStatus).filter((s) => s !== null);
      for (const status of this.hydraStatus.changes(statuses)) {
        sendToWindow(this.deps.getWindow(), "wire:hydra-status", status);
      }
    }, 3_000);
    this.mailboxSweep.unref?.();
    this.workerAdmission = new WorkerAdmission({
      caps: deps.workerCaps,
      count: () => this.execRenderer("window.__tcApi.countManagerWorkers()"),
      recordRefusal: ({ kind, managerId, open, limit }) =>
        deps.recordDecision({
          kind: "spawn_refused",
          node_kind: kind === "terminals" ? "terminal" : "browser",
          by: `terminal:${managerId}`,
          open,
          limit,
        }),
    });
  }

  getAuthToken(): string {
    return this.authToken;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res),
      );
      this.server.timeout = API_IDLE_TIMEOUT_MS;
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(port);
      });
      this.server.on("error", reject);
    });
  }

  stop() {
    clearInterval(this.mailboxSweep);
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
      if (!this.isAuthorized(req) && !isBrowserConnectorRoute(method, pathname)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (method === "POST" && WAIT_NODES_ROUTE.test(pathname)) {
        holdConnectionOpen(req.socket, res, WAIT_IDLE_TIMEOUT_MS, API_IDLE_TIMEOUT_MS);
      }
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
      // A typed `code` travels with deliberate refusals (err.status set), so
      // an agent can branch on it; Node's own error codes stay internal.
      const code = err.status && typeof err.code === "string" ? err.code : undefined;
      res.end(JSON.stringify({ error: err.message ?? "Internal error", ...(code ? { code } : {}) }));
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    return isAuthorizedBearer(req.headers.authorization, this.authToken);
  }

  private async route(
    method: string,
    pathname: string,
    url: URL,
    body: any,
  ): Promise<any> {
    if (method === "POST" && pathname === "/browser-connect/complete") {
      return this.browserConnectComplete(body);
    }
    if (method === "POST" && pathname === "/browser-connect/tab") {
      return this.browserConnectTab(body);
    }
    if (method === "POST" && pathname === "/browser-connect/poll") {
      return this.browserConnectPoll(body);
    }
    if (method === "POST" && pathname === "/browser-connect/result") {
      return this.browserConnectResult(body);
    }
    if (method === "POST" && pathname === "/browser-connect/revoke") {
      return this.browserConnectRevoke(body);
    }
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
      return this.workspaceNodes(url.searchParams.get("for"), url.searchParams.get("all") === "1");
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
    if (method === "POST" && WAIT_NODES_ROUTE.test(pathname)) {
      const id = pathname.split("/")[2];
      await this.requireWorkspaceManager(id);
      return waitForNodes(
        {
          findNode: (nodeId) => this.findNode(nodeId),
          log: this.deps.nodeEvents,
        },
        body,
      );
    }
    // The task list, for an agent: always its own project's, and its changes
    // are recorded as its own.
    const taskRoute = /^\/terminal\/([A-Za-z0-9._-]{1,128})\/tasks(?:\/([a-z0-9][a-z0-9-]*))?$/.exec(pathname);
    if (taskRoute) {
      return this.terminalTasks(method, taskRoute[1], taskRoute[2] ?? null, body);
    }
    if (method === "POST" && START_TASK_ROUTE.test(pathname)) {
      return this.startRunFor(pathname.split("/")[2], body);
    }
    if (method === "POST" && END_TASK_ROUTE.test(pathname)) {
      return this.endRunFor(pathname.split("/")[2]);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/close-node$/)) {
      const id = pathname.split("/")[2];
      return this.closeNodeFor(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/send-prompt$/)) {
      const id = pathname.split("/")[2];
      return this.sendPromptToNode(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/ask$/)) {
      return this.askConnected(pathname.split("/")[2], body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/hand-off$/)) {
      return this.handOffConnected(pathname.split("/")[2], body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/send-to-connected$/)) {
      const id = pathname.split("/")[2];
      return this.sendToConnected(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/spawn-terminal$/)) {
      const id = pathname.split("/")[2];
      return this.spawnTerminal(id, body);
    }
    if (method === "POST" && pathname.match(/^\/terminal\/[^/]+\/spawn-browser$/)) {
      const id = pathname.split("/")[2];
      return this.spawnBrowser(id, body);
    }
    if (method === "GET" && pathname.match(/^\/terminal\/[^/]+\/browser-profiles$/)) {
      const id = pathname.split("/")[2];
      return this.listBrowserProfiles(id);
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

  /** The project a terminal belongs to, as the task store keys it. */
  private async repoOfTerminal(terminalId: string): Promise<string> {
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    for (const project of projects ?? []) {
      for (const worktree of project.worktrees ?? []) {
        if ((worktree.terminals ?? []).some((t: { id?: string }) => t.id === terminalId)) {
          return resolveCanvasProjectRoot(worktree.path, projects);
        }
      }
    }
    throw Object.assign(new Error(`Terminal not on the canvas: ${terminalId}`), { status: 404 });
  }

  /**
   * Backs the task tools (list_tasks, create_task, update_task, ask_user):
   * the same list the person sees in Tasks, scoped to the agent's project.
   */
  private async terminalTasks(method: string, terminalId: string, taskId: string | null, body: any) {
    const repo = await this.repoOfTerminal(terminalId);
    const actor = `terminal:${terminalId}`;
    try {
      if (method === "GET" && !taskId) {
        return { tasks: this.deps.taskStore.list(repo).filter((pin) => pinKind(pin) === "task") };
      }
      if (method === "POST" && !taskId) {
        const task = this.deps.taskStore.create(
          {
            title: body?.title,
            repo,
            kind: "task",
            body: body?.body,
            steps: body?.steps,
            owners: body?.owners ?? [terminalId],
            status: body?.status === undefined ? undefined : requireStatus(body.status),
          },
          actor,
        );
        return { task };
      }
      if (method === "PUT" && taskId) {
        const ask =
          body?.ask && typeof body.ask === "object"
            ? { reason: body.ask.reason, choices: body.ask.choices, by: terminalId }
            : body?.ask === null
              ? null
              : undefined;
        const task = this.deps.taskStore.update(
          repo,
          taskId,
          {
            title: body?.title,
            status: body?.status === undefined ? undefined : requireStatus(body.status),
            body: body?.body,
            steps: body?.steps,
            owners: body?.owners,
            ask,
          },
          actor,
        );
        return { task };
      }
    } catch (err) {
      throw rethrowPinStoreError(err);
    }
    throw Object.assign(new Error("Not found"), { status: 404 });
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
      const pin = this.deps.taskStore.create(
        {
          title: body?.title,
          repo: canonicalRepo,
          kind: body?.kind,
          body: body?.body,
          status: body?.status === undefined ? undefined : requireStatus(body.status),
          links: body?.links,
          steps: body?.steps,
          owners: body?.owners,
          x: body?.x,
          y: body?.y,
          w: body?.w,
          h: body?.h,
        },
        pinActor(body?.actor),
      );
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
      const pin = this.deps.taskStore.update(
        canonicalRepo,
        id,
        {
          title: body?.title,
          kind: body?.kind,
          status: body?.status === undefined ? undefined : requireStatus(body.status),
          body: body?.body,
          links: body?.links,
          steps: body?.steps,
          owners: body?.owners,
          ask: body?.ask,
          answer: typeof body?.answer === "string" ? body.answer : undefined,
          x: body?.x,
          y: body?.y,
          w: body?.w,
          h: body?.h,
        },
        pinActor(body?.actor),
      );
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
    if (typeof action !== "string") {
      throw Object.assign(new Error("action is required"), { status: 400 });
    }
    const params = body?.params ?? {};
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw Object.assign(new Error("params must be an object"), { status: 400 });
    }
    const actor = await this.resolveBrowserActionActor(id, body?.actor, action);

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
        `window.__tcApi.driveBrowserCard(${JSON.stringify(id)}, ${JSON.stringify(action)}, ${JSON.stringify(params)}, ${JSON.stringify(actor)})`,
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

  private async resolveBrowserActionActor(browserId: string, candidate: unknown, action: string): Promise<string> {
    if (typeof candidate !== "string" || !candidate.startsWith("terminal:")) return "system";
    const terminalId = candidate.slice("terminal:".length);
    if (!terminalId || terminalId.includes(":")) return "system";
    const binding = (await this.terminalBrowserBinding(terminalId)) as BrowserBinding | null;
    // The wire is the permission: a terminal reaches only the browser it is
    // wired to, along the wire's direction, and a read-only wire allows
    // reading and nothing that changes the page.
    if (binding?.browserId !== browserId) {
      throw Object.assign(
        new Error("This terminal isn't wired to that browser. Ask the user to draw a wire from it to the browser."),
        { status: 403, code: "not_wired" },
      );
    }
    if (binding.access === "read" && !READ_ONLY_BROWSER_ACTIONS.has(action)) {
      throw Object.assign(
        new Error(`The wire to this browser is read-only, so "${action}" is refused. browser_read still works; ask the user to let the wire drive the page if you need to.`),
        { status: 403, code: "read_only" },
      );
    }
    return candidate;
  }

  private browserConnectComplete(body: any) {
    const browser = body?.browser;
    if (browser !== "chrome" && browser !== "edge" && browser !== "brave") {
      throw Object.assign(new Error("Supported browser identity is required"), { status: 400 });
    }
    if (
      typeof body?.code !== "string" ||
      typeof body?.profileLabel !== "string" ||
      typeof body?.extensionId !== "string" ||
      typeof body?.protocolVersion !== "number"
    ) {
      throw Object.assign(new Error("Complete browser pairing details are required"), { status: 400 });
    }
    return this.deps.connectedBrowserBroker.registry.completePairing(body?.code, {
      browser,
      profileLabel: body?.profileLabel,
      extensionId: body?.extensionId,
      protocolVersion: body?.protocolVersion ?? CONNECTED_BROWSER_PROTOCOL_VERSION,
    });
  }

  private browserConnectTab(body: any) {
    if (
      typeof body?.connectionId !== "string" ||
      typeof body?.token !== "string" ||
      !body?.tab ||
      !Array.isArray(body?.capabilities)
    ) {
      throw Object.assign(new Error("Connection, tab, and capabilities are required"), { status: 400 });
    }
    return this.deps.connectedBrowserBroker.registry.authorizeTab(
      body?.connectionId,
      body?.token,
      body?.tab,
      body?.capabilities,
    );
  }

  private browserConnectPoll(body: any) {
    this.requireBrowserConnectionCredentials(body);
    return this.deps.connectedBrowserBroker.poll(
      body?.connectionId,
      body?.token,
      body?.waitMs,
    );
  }

  private browserConnectResult(body: any) {
    this.requireBrowserConnectionCredentials(body);
    if (
      typeof body?.commandId !== "string" ||
      !body?.result ||
      typeof body.result.ok !== "boolean"
    ) {
      throw Object.assign(new Error("A valid browser command result is required"), { status: 400 });
    }
    this.deps.connectedBrowserBroker.settle(
      body?.connectionId,
      body?.token,
      body?.commandId,
      body?.result,
    );
    return { ok: true };
  }

  private browserConnectRevoke(body: any) {
    this.requireBrowserConnectionCredentials(body);
    this.deps.connectedBrowserBroker.revokeConnection(body.connectionId, body.token);
    return { ok: true };
  }

  private requireBrowserConnectionCredentials(body: any): void {
    if (typeof body?.connectionId !== "string" || typeof body?.token !== "string") {
      throw Object.assign(new Error("Browser connection credentials are required"), { status: 400 });
    }
  }

  private async terminalBrowserBinding(terminalId: string) {
    return this.execRenderer(
      `window.__tcApi.getBrowserBindingForTerminal(${JSON.stringify(terminalId)})`,
    );
  }

  /**
   * Backs the emit_event MCP tool (tacit-bridge/src/mcp-server.ts): fans a
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
      (
        | {
            kind: "terminal";
            id: string;
            ptyId: number | null;
            terminalType: string | null;
            worktreePath: string | null;
          }
        | { kind: "browser"; id: string }
        | { kind: "note"; id: string }
      ) & { direction: WireDirection; can: string[] }
    >;

    const win = this.deps.getWindow();
    const notified: Array<{ kind: string; id: string; ok: boolean; reason?: string }> = [];

    for (const target of connected) {
      // A wire runs the way it was drawn unless it was made two-way; an
      // event doesn't travel up one that points at the emitter.
      if (target.direction === "from_it") {
        notified.push({
          kind: target.kind,
          id: target.id,
          ok: false,
          reason: "the wire runs the other way, into you",
        });
        continue;
      }
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
      const preview =
        typeof payload.message === "string"
          ? payload.message.replace(/\s+/g, " ").trim().slice(0, 80)
          : type;
      sendToWindow(win, "canvas-bridge:event", { phase: "start", ...pulseBase, preview });

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
          // A shell runs what it's given, so it gets the message bare: the
          // label would become part of the command.
          const isAgent = findAgentAdapter(target.terminalType) !== null;
          const request: ComposerSubmitRequest = {
            terminalId: target.id,
            ptyId: target.ptyId,
            terminalType:
              target.terminalType as ComposerSubmitRequest["terminalType"],
            worktreePath: target.worktreePath,
            text: isAgent ? `[Event: ${type} from ${kind}:${id}] ${message}` : message,
            images: [],
          };
          const result = await this.submitToTerminal(request);
          if (result.ok) {
            this.deps.recordAgentPrompt({
              targetTerminalId: target.id,
              by: `${kind}:${id}` as CaptureNodeRef,
              text: request.text,
            });
          }
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
          } else if (!target.can.includes("drive")) {
            notified.push({
              kind: "browser",
              id: target.id,
              ok: false,
              reason: "the wire to this browser is read-only",
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

    const provenance = this.journalProvenance(terminalId);
    const { filePath, fileName } = writeProjectNote(
      memoryDir,
      { name, description, type: noteType, body: noteBody },
      provenance,
    );
    this.deps.recordDecision(
      journalWriteEvent(provenance, { tool: "remember", scope: "project", title: name, file: fileName }),
    );

    return { ok: true, filePath };
  }

  /**
   * Backs the list_nodes MCP tool — open to any terminal, no gating. With
   * `forTerminalId`, each node also says whether and which way it is wired
   * to that terminal, what the wire is for and what it may do there.
   */
  private async workspaceNodes(forTerminalId: string | null, all: boolean) {
    // An agent sees what it is wired to; the workdesk manager, which reaches
    // every node in its workdesk, sees everything, as does anyone who asks.
    const everything =
      all ||
      !forTerminalId ||
      ((await this.execRenderer(
        `window.__tcApi.isWorkspaceManager(${JSON.stringify(forTerminalId)})`,
      )) as boolean);
    return this.execRenderer(
      `window.__tcApi.listWorkspaceNodes(${JSON.stringify(forTerminalId)}, ${JSON.stringify(everything)})`,
    );
  }

  /** Backs the get_node_state MCP tool — open to any terminal, no gating. */
  private async workspaceNodeState(kind: string, id: string) {
    if (kind !== "terminal" && kind !== "browser" && kind !== "pin") {
      throw Object.assign(new Error(`Unsupported node kind: ${kind}`), {
        status: 400,
      });
    }
    const state = (await this.execRenderer(
      `window.__tcApi.getNodeState(${JSON.stringify(kind)}, ${JSON.stringify(id)})`,
    )) as { type?: string | null } | null;
    if (kind !== "terminal" || !state) return state;
    // `status` is the tile's display state, which follows screen output: a
    // silent `sleep 60` shows "waiting". `busy` is what close_node decides
    // by, so the two can't disagree (9 Oct).
    return { ...state, busy: this.terminalBusyState(state.type, id) };
  }

  /** A node on the open canvas by id alone, with what the manager tools need. */
  private findNode(id: string) {
    return this.execRenderer(
      `window.__tcApi.findPromptTarget(${JSON.stringify(id)})`,
    ) as Promise<PromptTargetNode | null>;
  }

  private terminalBusyState(terminalType: string | null | undefined, id: string) {
    return busyStateOf(terminalType, this.deps.telemetryService.getTerminalSnapshot(id));
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
          "This terminal is not the workdesk manager of the canvas on screen. Either the role belongs to another terminal (ask the user to assign it from the Project chat pill), or your canvas isn't the active one; manager tools only reach the canvas that is currently open.",
        ),
        { status: 403, code: "not_workspace_manager" },
      );
    }
  }

  /**
   * Types text into one terminal and submits it — the path emit_event and
   * send_prompt_to_node share.
   */
  private submitToTerminal(request: ComposerSubmitRequest) {
    return submitComposerRequest(
      request,
      createDefaultComposerSubmitDeps(
        process.platform as "darwin" | "win32" | "linux",
        this.deps.dataUrlToPngBuffer,
        (ptyId: number, data: string) => this.deps.ptyManager.write(ptyId, data),
      ),
    );
  }

  /** Backs the send_prompt_to_node MCP tool. */
  private async sendPromptToNode(terminalId: string, body: any) {
    try {
      await this.requireWorkspaceManager(terminalId);
    } catch (err) {
      // An agent reaching for this to talk to a node it is wired to wants
      // send_to_connected; say so rather than leave it stuck on the role.
      const target = typeof body?.id === "string" ? body.id : null;
      const ends = target ? (await this.wiresOf(terminalId))?.ends ?? [] : [];
      if (target && ends.some((end) => end.id === target)) {
        throw Object.assign(
          new Error(
            `${(err as Error).message} You are wired to "${target}" on the canvas, though: use send_to_connected to send it a message.`,
          ),
          { status: 403, code: "not_workspace_manager" },
        );
      }
      throw err;
    }
    return this.nodePrompts.send(terminalId, body);
  }

  private wiresOf(terminalId: string) {
    return this.execRenderer(
      `window.__tcApi.getWiresOfTerminal(${JSON.stringify(terminalId)})`,
    ) as Promise<{ sender: WireSender; ends: WireEnd[] } | null>;
  }

  /** Backs the send_to_connected MCP tool: open to any terminal, gated by the wire. */
  /** Types one waiting message into its agent and records it as a prompt. */
  private async typeMailItem(item: MailItem): Promise<{ ok: boolean; detail?: string }> {
    let target = item.target;
    if (!target) {
      // Queued before a restart: the terminal has a new PTY now.
      const node = await this.findNode(item.terminalId);
      if (!node || node.kind !== "terminal" || node.ptyId == null || !node.terminalType || !node.worktreePath) {
        return { ok: false, detail: "that terminal isn't running on the open canvas" };
      }
      target = { ptyId: node.ptyId, terminalType: node.terminalType, worktreePath: node.worktreePath };
    }
    const result = await this.submitToTerminal({
      terminalId: item.terminalId,
      ptyId: target.ptyId,
      terminalType: target.terminalType as ComposerSubmitRequest["terminalType"],
      worktreePath: target.worktreePath,
      text: item.text,
      images: [],
    });
    if (!result.ok) return { ok: false, detail: result.detail ?? result.error };
    this.deps.recordAgentPrompt({ targetTerminalId: item.terminalId, by: item.from, text: item.text });
    if (item.askId) this.wireAsks.started(item.askId);
    return { ok: true };
  }

  /**
   * A terminal's telemetry changed (main.ts). A turn that just ended may
   * answer a question asked over a wire, and lets the next waiting message
   * go; a terminal that exited takes nothing more.
   */
  onTerminalSnapshot(terminalId: string, snapshot: { turn_state?: string; derived_status?: string }): void {
    // While agents are being stopped and started again (onAgentsStopping),
    // an exit isn't a closing; nothing is delivered until the window is back.
    if (!this.windowReady) return;
    if (snapshot.derived_status === "exited") {
      this.lastTurnState.delete(terminalId);
      this.wireAsks.targetGone(terminalId);
      for (const item of this.wireMailbox.waiting(terminalId)) if (item.askId) this.wireAsks.dropped(item.askId);
      this.wireMailbox.forget(terminalId);
      return;
    }
    const before = this.lastTurnState.get(terminalId);
    this.lastTurnState.set(terminalId, snapshot.turn_state);
    const ended = snapshot.turn_state === "turn_complete" || snapshot.turn_state === "turn_aborted";
    if (ended && before !== snapshot.turn_state) {
      // Read the answer before anything else is typed in and starts a turn.
      void this.wireAsks.turnEnded(terminalId).then(() => this.wireMailbox.poke(terminalId));
      return;
    }
    void this.wireMailbox.poke(terminalId);
  }

  /** The waiting badge's Discard: questions in it are answered as dropped. */
  /**
   * Every agent was restarted: the app started, or the window reloaded and
   * took its terminals with it (main.ts, did-finish-load). Waiting messages,
   * including those saved when the app last closed, are held until each
   * agent has had a turn (electron/wire-mailbox.ts); questions being
   * answered were interrupted; tracked hand-offs carry on. The askers and
   * receivers are told once the window is ready.
   */
  /**
   * The window is about to reload or the app to quit: every agent is about
   * to be stopped. Their exits aren't closings, so nothing waiting for them
   * is dropped until the window is back (onWindowReady).
   */
  onAgentsStopping(): void {
    this.windowReady = false;
  }

  /** The app is quitting: what is waiting is saved before the agents stop. */
  prepareToQuit(): void {
    this.onAgentsStopping();
    this.saveWireStateNow();
    this.wireStateFrozen = true;
  }

  onAgentsRestarted(): void {
    this.windowReady = false;
    const saved = this.savedWireState;
    this.savedWireState = null;
    this.wireMailbox.holdAfterRestart(saved?.mail ?? []);
    const interrupted = this.wireAsks.restart(saved?.asks);
    if (saved) this.trackedHandoffs.restore(saved.handoffs);
    this.restartFollowUp = {
      interrupted: [...(this.restartFollowUp?.interrupted ?? []), ...interrupted],
      ...(this.restartFollowUp?.problem ? { problem: this.restartFollowUp.problem } : {}),
    };
    this.scheduleWireStateSave();
  }

  /**
   * The window has loaded and listens for wire events (wires:window-ready).
   * After a restart: askers whose questions were interrupted are told, and
   * agents with tracked hand-offs still open are reminded, both held like
   * the rest; then the window is told what is waiting.
   */
  async onWindowReady(): Promise<void> {
    this.windowReady = true;
    const followUp = this.restartFollowUp;
    this.restartFollowUp = null;
    if (followUp) {
      this.followingUpRestart = true;
      for (const ask of followUp.interrupted) {
        this.wireMailbox.enqueueHeld(this.heldMail(ask.askerId, interruptedText(ask), `terminal:${ask.targetId}`));
      }
      // Results written while the app was closed are picked up first.
      await this.trackedHandoffs.sweep().catch((err) => console.warn("[tracked-handoff] sweep failed", err));
      for (const handoff of this.trackedHandoffs.all()) {
        this.wireMailbox.enqueueHeld(this.heldMail(handoff.targetId, restartReminder(handoff), `terminal:${handoff.senderId}`));
      }
      this.followingUpRestart = false;
    }
    this.wireMailbox.resend();
    for (const handoff of this.trackedHandoffs.all()) this.sendHandoffStatus(handoff, "working");
    if (followUp) {
      const held = this.wireMailbox
        .heldTerminals()
        .map((terminalId) => ({ terminalId, waiting: this.wireMailbox.waiting(terminalId).length }));
      if (held.length > 0 || followUp.problem) {
        sendToWindow(this.deps.getWindow(), "wire:restart-summary", {
          held,
          ...(followUp.problem ? { problem: followUp.problem } : {}),
        });
      }
    }
  }

  /** Types into an agent; during a restart's follow-up, held with the rest instead. */
  private async tellTerminal(terminalId: string, text: string, from: CaptureNodeRef): Promise<void> {
    if (this.followingUpRestart) {
      this.wireMailbox.enqueueHeld(this.heldMail(terminalId, text, from));
      return;
    }
    await this.typeIntoTerminal(terminalId, text, from);
  }

  /** How a tracked hand-off is going, for the label on its wire. */
  private sendHandoffStatus(handoff: TrackedHandoff, status: TrackedHandoffStatus["status"]): void {
    sendToWindow(this.deps.getWindow(), "wire:handoff-status", {
      senderId: handoff.senderId,
      targetId: handoff.targetId,
      status,
    } satisfies TrackedHandoffStatus);
  }

  private heldMail(terminalId: string, text: string, from: CaptureNodeRef): MailItem {
    return { id: randomUUID(), terminalId, text, from, preview: envelopePreview(text), at: Date.now() };
  }

  private scheduleWireStateSave(): void {
    if (this.wireStateSave) return;
    this.wireStateSave = setTimeout(() => {
      this.wireStateSave = null;
      this.saveWireStateNow();
    }, 200);
  }

  /** Writes what the wires are waiting on; also called as the app quits. */
  saveWireStateNow(): void {
    if (this.wireStateSave) {
      clearTimeout(this.wireStateSave);
      this.wireStateSave = null;
    }
    // Not taken in yet (the window never loaded): what was saved stands.
    if (this.savedWireState || this.wireStateFrozen) return;
    try {
      this.wireStateFile.save({
        version: WIRE_STATE_VERSION,
        mail: this.wireMailbox.allWaiting(),
        asks: this.wireAsks.snapshot(),
        handoffs: this.trackedHandoffs.all(),
      });
      this.wireStateSaveFailed = false;
    } catch (err) {
      console.error("[wire-state] couldn't save what the wires are waiting on", err);
      if (!this.wireStateSaveFailed) {
        this.wireStateSaveFailed = true;
        sendToWindow(this.deps.getWindow(), "wire:notice", {
          message: `Tacit couldn't save what its wires are waiting on (${err instanceof Error ? err.message : String(err)}); if it restarts now, that is lost.`,
        });
      }
    }
  }

  /** Whether a finished turn of `fromId` already went to `toId` as an ask's answer. */
  replyAlreadyAnswered(fromId: string, toId: string, key: string): boolean {
    return this.wireAsks.alreadyAnswered(fromId, toId, key);
  }

  discardWaiting(terminalId: string): number {
    for (const item of this.wireMailbox.waiting(terminalId)) if (item.askId) this.wireAsks.dropped(item.askId);
    return this.wireMailbox.discard(terminalId);
  }

  /**
   * Hands text to a terminal at the end of a wire. An agent gets it through
   * its mailbox, so it waits if the agent is mid-turn; a shell gets it at
   * once, because it runs it. Recording happens when it is actually typed.
   */
  async deliverAlongWire(delivery: {
    terminalId: string;
    ptyId: number;
    terminalType: string;
    worktreePath: string;
    text: string;
    from: CaptureNodeRef;
    askId?: string;
  }): Promise<{ ok: boolean; detail?: string; queued?: boolean; waiting?: number }> {
    const item: MailItem = {
      id: randomUUID(),
      terminalId: delivery.terminalId,
      target: { ptyId: delivery.ptyId, terminalType: delivery.terminalType, worktreePath: delivery.worktreePath },
      text: delivery.text,
      from: delivery.from,
      preview: envelopePreview(delivery.text),
      at: Date.now(),
      ...(delivery.askId ? { askId: delivery.askId } : {}),
    };
    if (!findAgentAdapter(delivery.terminalType)) return this.typeMailItem(item);
    const result = await this.wireMailbox.submit(item);
    return result.status === "queued"
      ? { ok: true, queued: true, waiting: result.waiting }
      : { ok: result.ok, detail: result.detail };
  }

  /** The pulse along a wire while something is on its way. */
  private wirePulse(sourceId: string) {
    const win = this.deps.getWindow();
    return (event: { phase: "start" | "end"; requestId: string; targetKind: string; targetId: string; ok?: boolean; preview?: string }) =>
      sendToWindow(win, "canvas-bridge:event", { ...event, sourceKind: "terminal", sourceId, type: "message" });
  }

  /**
   * A message arriving at a pin over a wire. A note has it added to its
   * text; a task logs it as a done step, written as the agent that sent it
   * so the task's history says who did what.
   */
  private async deliverToPin(
    pinId: string,
    senderId: string,
    senderTitle: string,
    text: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const pin = (await this.execRenderer(
      `window.__tcApi.getNodeState("pin", ${JSON.stringify(pinId)})`,
    )) as { id: string; repo: string; kind?: "task" | "note"; x?: number; y?: number; steps?: Array<{ text: string; status: "pending" | "active" | "done" }> } | null;
    if (!pin) return { ok: false, detail: "that note or task is gone" };
    if (pinKind(pin) !== "task") {
      return (await this.execRenderer(
        `window.__tcApi.appendToNote(${JSON.stringify(pinId)}, ${JSON.stringify(senderTitle)}, ${JSON.stringify(text)})`,
      )) as { ok: boolean; detail?: string };
    }
    const step = stepFromMessage(text);
    if (!step) return { ok: false, detail: "nothing to log" };
    const projects = await this.execRenderer(`window.__tcApi.getProjects()`);
    try {
      this.deps.taskStore.update(
        resolveCanvasProjectRoot(pin.repo, projects),
        pin.id,
        { steps: [...(pin.steps ?? []), { text: step, status: "done" }] },
        `terminal:${senderId}`,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Backs the ask MCP tool. */
  private askConnected(terminalId: string, body: any) {
    return askAlongWire(
      {
        wiresOf: (id) => this.wiresOf(id),
        deliverQuestion: async ({ ask, ...delivery }) => {
          if (ask) {
            this.wireAsks.register({
              ...ask,
              targetId: delivery.terminalId,
              cwd: delivery.worktreePath,
              at: Date.now(),
            });
          }
          return this.deliverAlongWire({ ...delivery, from: `terminal:${terminalId}`, ...(ask ? { askId: ask.id } : {}) });
        },
        answersComeBack: (terminalType) => canReadFinalReply(terminalType),
        pulse: this.wirePulse(terminalId),
        newId: () => randomUUID(),
      },
      terminalId,
      body,
    );
  }

  /** Types text into a terminal found by id, through its mailbox if it's an agent. */
  private async typeIntoTerminal(terminalId: string, text: string, from: CaptureNodeRef): Promise<void> {
    const node = await this.findNode(terminalId);
    if (!node || node.kind !== "terminal" || node.ptyId == null || !node.terminalType || !node.worktreePath) {
      console.warn(`[wires] ${terminalId} is gone; a message for it wasn't delivered`);
      return;
    }
    await this.deliverAlongWire({
      terminalId,
      ptyId: node.ptyId,
      terminalType: node.terminalType,
      worktreePath: node.worktreePath,
      text,
      from,
    });
  }

  /** Backs the hand_off MCP tool. */
  private handOffConnected(terminalId: string, body: any) {
    return handOffAlongWire(
      {
        wiresOf: (id) => this.wiresOf(id),
        deliverToTerminal: (delivery) => this.deliverAlongWire({ ...delivery, from: `terminal:${terminalId}` }),
        track: ({ id, sender, end, work, why }) => {
          const handoff: TrackedHandoff = {
            id,
            senderId: sender.id,
            senderTitle: sender.title,
            targetId: end.id,
            targetTitle: end.title ?? end.id,
            dir: path.join(end.worktreePath!, ".hydra", "handoffs", id),
            startedAt: Date.now(),
          };
          let role: { name: string; description: string; body: string } | null = null;
          let roleProblem: string | undefined;
          if (end.hydraRole) {
            try {
              const definition = loadRole(end.hydraRole, end.worktreePath!);
              role = { name: definition.name, description: definition.description, body: definition.body };
            } catch (err) {
              // The work still goes, without the role; the sender is told.
              console.warn(`[tracked-handoff] role ${end.hydraRole} couldn't be loaded`, err);
              roleProblem = `The wire's role "${end.hydraRole}" couldn't be loaded (${err instanceof Error ? err.message : String(err)}), so the task sheet doesn't include it.`;
            }
          }
          this.trackedHandoffs.start({ handoff, work, why, role });
          this.sendHandoffStatus(handoff, "working");
          this.deps.recordDecision({
            kind: "tracked_handoff",
            from: `terminal:${sender.id}`,
            to: `terminal:${end.id}`,
            handoff_id: id,
            state: "started",
            dir: handoff.dir,
            by: `terminal:${sender.id}`,
          });
          return { notice: trackedNotice(handoff, why), dir: handoff.dir, ...(roleProblem ? { roleProblem } : {}) };
        },
        pulse: this.wirePulse(terminalId),
        newId: () => randomUUID(),
      },
      terminalId,
      body,
    );
  }

  private sendToConnected(terminalId: string, body: any) {
    const win = this.deps.getWindow();
    return sendAlongWires(
      {
        wiresOf: (id) => this.wiresOf(id),
        deliverToTerminal: (delivery) =>
          this.deliverAlongWire({ ...delivery, from: `terminal:${terminalId}` }),
        appendToNote: (noteId, source, text) => this.deliverToPin(noteId, terminalId, source, text),
        pulse: (event) =>
          sendToWindow(win, "canvas-bridge:event", {
            ...event,
            sourceKind: "terminal",
            sourceId: terminalId,
            type: "message",
          }),
        newId: () => randomUUID(),
      },
      terminalId,
      body,
    );
  }

  /** Backs the start_task MCP tool. */
  private async startRunFor(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    return managerStartRun(this.deps.runs, `terminal:${terminalId}`, body?.goal);
  }

  /** Backs the end_task MCP tool. */
  private async endRunFor(terminalId: string) {
    await this.requireWorkspaceManager(terminalId);
    return managerEndRun(this.deps.runs, `terminal:${terminalId}`);
  }

  /** Backs the close_node MCP tool. */
  private async closeNodeFor(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    return closeNode(
      {
        findNode: (id) => this.findNode(id),
        busyState: (node) => this.terminalBusyState(node.terminalType, node.id),
        close: async (input) => {
          const result = await this.execRenderer(
            `window.__tcApi.closeNode(${JSON.stringify({
              requesterTerminalId: terminalId,
              ...input,
            })})`,
          );
          // A terminal's close arrives from telemetry when its process exits;
          // a browser has no process Tacit watches, so it is noted here.
          if (result?.ok && input.kind === "browser") {
            this.deps.nodeEvents.append(`browser:${input.id}`, "closed");
          }
          return result;
        },
      },
      terminalId,
      body,
    );
  }

  /** Backs the spawn_terminal MCP tool. */
  private async spawnTerminal(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const type = typeof body?.type === "string" ? body.type : "shell";
    const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt : undefined;
    // Only an agent is launched with its first message; a shell or lazygit
    // opened and the prompt was silently dropped.
    if (prompt && !findAgentAdapter(type)) {
      throw Object.assign(
        new Error(
          `A ${type} terminal doesn't take an opening prompt. Spawn it without one, then use send_prompt_to_node to type a command into it.`,
        ),
        { status: 400, code: "prompt_not_supported" },
      );
    }
    const result = (await this.workerAdmission.admit("terminals", terminalId, () =>
      this.execRenderer(
        `window.__tcApi.spawnTerminal(${JSON.stringify({
          requesterTerminalId: terminalId,
          type: body?.type,
          prompt,
          position: body?.position,
          connectTo: body?.connectTo,
        })})`,
      ),
    )) as { ok?: boolean; id?: unknown };
    // The opening prompt is the manager speaking, as with send_prompt_to_node.
    // Recorded here, attributed to it; the worker's prompt hook (Claude,
    // Codex) then drops its echo instead of filing it as the user's.
    if (prompt && result?.ok && typeof result.id === "string") {
      this.deps.recordAgentPrompt({
        targetTerminalId: result.id,
        by: `terminal:${terminalId}`,
        text: prompt,
      });
    }
    return result;
  }

  /** Backs the spawn_browser MCP tool. */
  private async spawnBrowser(terminalId: string, body: any) {
    await this.requireWorkspaceManager(terminalId);
    const url = body?.url;
    if (!url || typeof url !== "string") {
      throw Object.assign(new Error("url is required"), { status: 400 });
    }
    const profile = body?.profile;
    if (profile !== undefined && typeof profile !== "string") {
      throw Object.assign(new Error("profile must be a string"), { status: 400 });
    }
    return this.workerAdmission.admit("browsers", terminalId, async () => {
      const result = await this.execRenderer(
        `window.__tcApi.spawnBrowser(${JSON.stringify({
          requesterTerminalId: terminalId,
          url,
          position: body?.position,
          connectTo: body?.connectTo,
          // A profile name or id. Resolved in the renderer, where the identity
          // registry and this canvas's default both live — never defaulted here.
          profile,
        })})`,
      );
      if (result?.ok && typeof result.id === "string") {
        this.deps.nodeEvents.append(`browser:${result.id}`, "spawned");
      }
      return result;
    });
  }

  /** Backs the list_browser_profiles MCP tool. */
  private async listBrowserProfiles(terminalId: string) {
    await this.requireWorkspaceManager(terminalId);
    return this.execRenderer(`window.__tcApi.listAgentBrowserProfiles()`);
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

    const provenance = this.journalProvenance(terminalId);
    const { filePath, fileName } = writeJournalEntry(memoryDir, { event, detail }, provenance);
    this.deps.recordDecision(
      journalWriteEvent(provenance, { tool: "log_activity", scope: "workspace", title: event, file: fileName }),
    );

    return { ok: true, filePath };
  }

  /**
   * Who is writing a shared note, and whether web content reached them first
   * (SHR-63): stamped on the note and recorded, as it can't be worked out
   * later. Nothing acts on `tainted` yet; T7 will.
   */
  private journalProvenance(terminalId: string): JournalProvenance {
    const node = `terminal:${terminalId}` as const;
    const snapshot = this.deps.telemetryService.getTerminalSnapshot(terminalId);
    return {
      node,
      harness: this.deps.harnessOf(node) ?? snapshot?.provider ?? null,
      session: snapshot?.session_id ?? null,
      context: this.deps.runs.current()?.run_id ?? null,
      ...this.deps.webReads.provenance(terminalId),
    };
  }
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

/** Who made a change, from the request: an agent's terminal, else the person. */
function pinActor(raw: unknown): string {
  return typeof raw === "string" && /^terminal:[A-Za-z0-9._-]{1,128}$/.test(raw) ? raw : "user";
}

/** A status as typed ("todo", "doing", "needs-you"…), or a 400. */
function requireStatus(raw: unknown): PinStatus {
  const status = parsePinStatus(raw);
  if (!status) throw Object.assign(new Error(`Invalid status: ${String(raw)}`), { status: 400 });
  return status;
}

function rethrowPinStoreError(err: unknown): Error {
  if (err instanceof PinStoreError) {
    return Object.assign(new Error(err.message), { status: err.status });
  }
  return err instanceof Error ? err : new Error(String(err));
}
