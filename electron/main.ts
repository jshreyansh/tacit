import {
  app,
  BrowserWindow,
  clipboard,
  webContents,
  crashReporter,
  ipcMain,
  dialog,
  Menu,
  nativeImage,
  shell,
  safeStorage,
  protocol,
  net,
  session,
  powerMonitor,
} from "electron";
import https from "https";
import path from "path";
import fs from "fs";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { PtyManager, OutputBatcher } from "./pty-manager";
import { ProjectScanner } from "./project-scanner";
import { StatePersistence, TACIT_DIR } from "./state-persistence";
import { SnapshotHistory } from "./snapshot-history";
import { GitFileWatcher } from "./git-watcher";
import { FileTreeWatcher } from "./file-tree-watcher";
import {
  SessionWatcher,
  resolveSessionFile,
  type SessionType,
} from "./session-watcher";
import {
  readFinalAssistantReply,
  type FinalReplyResult,
} from "./reply-transcript";
import { ApiServer } from "./api-server";
import { BrowserConnectionRegistry } from "./browser-connection-registry";
import { ConnectedBrowserBroker } from "./connected-browser-broker";
import {
  defaultChromeRoot,
  discoverChromeProfiles,
  importChromeProfilesAsIdentities,
} from "./browser-profile-import";
import { stageChromeLocalStorage } from "./browser-site-storage-import";
import { syncChromeProfiles } from "./browser-profile-sync";
import { ChromeLoginWatch, openInChromeProfile } from "./chrome-login-watch";
import {
  CHROME_AUTO_SYNC_EVERY_MS,
  readChromeSyncRequests,
  readChromeSyncSources,
  type ChromeSyncDue,
} from "../shared/browser-profile-sync";
import {
  resolveIdentityClearPartition,
  validateChromeProfileImportRequest,
  validateOrphanPartitionDiffRequest,
  validateOrphanPartitionEraseRequest,
} from "./browser-profile-ipc";
import {
  BrowserPartitionStore,
  resolvePartitionDirectory,
} from "./browser-partition-store";
import { BrowserObservationStore } from "./browser-observation-store";
import { resolvePopupDisposition } from "./browser-popup";
import {
  chromeIdentity,
  parseAcceptCh,
  SIGN_IN_ORIGINS_HINTS,
  withChromeHeaders,
  type ChromeIdentity,
} from "./browser-chrome-identity";
import {
  buildBrowserContextMenu,
  type BrowserContextMenuAction,
} from "./browser-context-menu";
import { isGuestCopyChord, resolveGuestShortcut } from "./browser-guest-shortcuts";
import { resolveDownloadSavePath } from "./browser-downloads";
import { BROWSER_OBSERVATION_CHANNEL } from "../shared/browser-observation";
import {
  identityIdFromPartition,
  isValidBrowserIdentityId,
  partitionForBrowserIdentity,
} from "../shared/browser-profile-import";
import { PinStore } from "./pin-store";
import { sendToWindow } from "./window-events";
import { detectCli } from "./process-detector";
import { ensureCliLauncher } from "./cli-launchers";
import { getAgentShimDir, getTerminalExtraPathEntries } from "./agent-shims";
import { prepareBridgeLaunch } from "./agent-launch";
import { detectAgents, locateCommand, runVersion } from "./agent-detect";
import { writeShellIntegrationFiles } from "./shell-integration";
import { applyLaunchArgs } from "../shared/agent-adapters";
import {
  isCliRegistered,
  registerCli,
  unregisterCli,
} from "./cli-registration";
import {
  ensureSkillLinks,
  getSkillsSourceDir,
  installSkillLinks,
} from "./skill-manager";
import {
  readCliIntegrationState,
  syncCliIntegrationOnStartup,
  writeCliIntegrationState,
} from "./cli-integration";
import {
  checkProjectInstructions,
  setUpProjectInstructions,
} from "./project-instructions";
import { buildLaunchSpec, getLoginShellEnv } from "./pty-launch.js";
import { spawn as spawnChild } from "node:child_process";
import { ChatEngine, chatSettingsChange, type ChatAgent } from "./manager-chat/chat-engine";
import { findSessionFile, isSessionFile } from "./manager-chat/session-file";
import { downloadableFont } from "../shared/font-registry";
import { timelineToChatEvents } from "../shared/chat-history";
import { chatLimitStore } from "./manager-chat/chat-limits";
import { ChatAttachments, type AttachmentInfo } from "./manager-chat/chat-attachments";
import { attachmentKind } from "../shared/chat-attachments";
import type { ApprovalDecision } from "../shared/chat-events";
import {
  createDefaultComposerSubmitDeps,
  submitComposerRequest,
} from "./composer-submit";
import {
  collectUsage,
  collectUsageRange,
  collectHeatmapData,
} from "./usage-collector";
import { buildGitWorktreeRemoveArgs } from "../hydra/src/cleanup";
import {
  installDownloadedUpdate,
  setupAutoUpdater,
  stopAutoUpdater,
} from "./auto-updater";
import {
  initAuth,
  login,
  logout,
  getAuthUser,
  getDeviceId,
  handleAuthCallback,
  onAuthStateChange,
  isLoggedIn,
} from "./auth";
import { toFileUrl } from "./file-url";
import {
  queryCloudUsage,
  queryCloudUsageRange,
  queryCloudHeatmap,
  backfillHistory,
  flushSyncQueue,
  syncRecentRecords,
} from "./usage-sync";
import type {
  ComposerSubmitRequest,
  ComposerSupportedTerminalType,
} from "../src/types";
import { buildPinComposerPayload } from "./pin-dispatch";
import { getProjectDiff } from "./git-diff";
import { searchFileContents, searchSessionContents } from "./search-handlers";
import {
  invalidateSessionIndexForFile,
  listSessionsForProjects,
  listSessionsForProjectsPaged,
  type SessionSearchEntry,
} from "./session-search-index";
import {
  buildSessionHistoryScope,
  diffSessionHistoryScopes,
} from "./session-history-events.ts";
import type { SessionHistoryChangedEvent } from "../shared/sessions.ts";
import {
  checkoutGitRef,
  createCommit,
  discardFiles,
  getGitBranches,
  getGitCommitDetail,
  getGitLog,
  getGitStatus,
  gitPull,
  gitPush,
  initGitRepo,
  isGitRepo,
  stageFiles,
  unstageFiles,
  amendCommit,
  listStashes,
  createStash,
  applyStash,
  popStash,
  dropStash,
  createBranch,
  deleteBranch,
  renameBranch,
  listTags,
  createTag,
  deleteTag,
  listRemotes,
  addRemote,
  removeRemote,
  renameRemote,
  gitFetch,
  gitMerge,
  gitMergeAbort,
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitCherryPick,
  gitCherryPickAbort,
  getMergeState,
  getFileDiff,
  stageHunk,
  unstageHunk,
  getBlame,
} from "./git-info";
import { parseNulSeparatedGitPaths } from "./git-paths";
import { HIDDEN_DIRS, describeFsError, listDirectory, listWorktreeFiles } from "./file-listing";
import { createMenu } from "./menu";
import { isSelectAllShortcutInput } from "./select-all-shortcut";
import { isReloadShortcutInput } from "./reload-shortcut";
import { TelemetryService } from "./telemetry-service";
import { createRenderDiagnosticsLogger } from "./render-diagnostics";
import { RenderThrottlingCoordinator } from "./render-throttling-coordinator";
import { HookReceiver } from "./hook-receiver";
import { CaptureService, getCaptureDir, makeRecordPrivate } from "./capture-service";
import { TranscriptKeeper } from "./transcript-keeper";
import { RunTracker } from "./run-tracker";
import {
  InjectedTextTracker,
  detectHarnessText,
  type CaptureEntry,
  type CaptureEvent,
  type CaptureReference,
  type CaptureTextSource,
} from "../shared/capture";
import { ManagerRoleLog, getManagerRoleLogPath } from "./manager-role-log";
import { isWorkspaceManagerBriefing } from "../shared/manager-role";
import { findAntigravityConversation } from "./antigravity-session";
import { workerCapsFor } from "../shared/worker-cap";
import { NodeEventLog } from "./node-events";
import { RecordNodes } from "./record-nodes";
import { RecallService } from "./recall-service";
import { getMemoryDirForWorkspace } from "./memory-service";
import { isSafeExternalUrl, isEmbeddedAuthBlockedUrl } from "./external-url";
import { WorkspaceSavePathRegistry } from "./workspace-save-path";
import {
  findBestClaudeSession,
  findBestCodexSession,
  findBestKimiSession,
  findBestOpenCodeSession,
  findBestWuuSession,
  readClaudeSessionPermissionMode,
  readCodexSessionBypassState,
  readLatestCodexSessionId,
} from "./session-discovery";
import { AgentService, type AgentConfig } from "./agent-service";
import { OpenCodeActivity } from "./opencode-activity";
import { WebReadTracker } from "./web-read-tracker";
import {
  HandoffTracker,
  MAX_DROPPED_FILES,
  describeDroppedFile,
  fileDropEvent,
  isAgentHarness,
  loadHandoffKey,
  pinDropEvent,
} from "./handoff-tracker";
import { getOpenCodeDbPath } from "./opencode-session";
import { SessionScanner } from "./session-scanner.ts";
import { mergeAndDedupeSessions } from "./session-list.ts";
import { buildPinRenderHtml } from "./pin-render-utils";
import type { RenderDiagnosticEventInput } from "../shared/render-diagnostics";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !!process.env.VITE_DEV_SERVER_URL;
// Development only: lets a test drive Tacit's own window as a person would
// (clicks and keys into tiles), on a port that exists only when asked for.
if (isDev && /^\d{4,5}$/.test(process.env.TACIT_DEV_UI_CDP_PORT ?? "")) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.TACIT_DEV_UI_CDP_PORT!);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
if (isDev) {
  app.setPath("userData", path.join(app.getPath("appData"), "tacit-dev"));
}

// Capture main / renderer / GPU process crashes into local minidumps. Required
// before any window opens so main-process crashes are still recorded. We do
// not upload anywhere — dumps live under app.getPath('crashDumps') for users
// (or us) to attach to bug reports manually.
crashReporter.start({
  productName: "Tacit",
  uploadToServer: false,
  compress: true,
});

// Custom scheme for serving pin image attachments from disk. Renderer-side
// `<img src="tc-attachment://local/<abs-path>">` resolves through the handler
// registered after app.whenReady. Must be declared as privileged BEFORE the
// app is ready, otherwise Chromium treats it as opaque and blocks subresources.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tc-attachment",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);
const skipLock = isDev || !!process.env.TACIT_SKIP_LOCK;
const gotLock = skipLock || app.requestSingleInstanceLock();
if (!gotLock) {
  console.error(
    "[Tacit] Another instance is already running. Quitting.\n" +
      "  Kill the old process first: pkill -f Electron",
  );
  app.quit();
}

const PORT_FILE = path.join(TACIT_DIR, "port");
/** Generated shell startup files; see electron/shell-integration.ts. */
const SHELL_INTEGRATION_DIR = path.join(TACIT_DIR, "shell-integration");

function perfLog(label: string, details: Record<string, unknown>) {
  if (!isDev) return;
  console.log(`[Perf] ${label}`, details);
}

function writePortFile(port: number, authToken: string) {
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  const tempPath = `${PORT_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${port}\n${process.pid}\n${authToken}`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, PORT_FILE);
}

function cleanupPortFile() {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {}
}

function emitSessionHistoryChanged(payload: SessionHistoryChangedEvent) {
  const projectDirs = payload.projectDirs
    .map((dir) => dir.trim())
    .filter(Boolean);
  if (projectDirs.length === 0) {
    return;
  }

  sendToWindow(mainWindow, "session-history:changed", {
    ...payload,
    projectDirs,
  });
}

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const outputBatcher = new OutputBatcher((ptyId, data) => {
  sendToWindow(mainWindow, "terminal:output", ptyId, data);
});
const projectScanner = new ProjectScanner();
const statePersistence = new StatePersistence();
const snapshotHistory = new SnapshotHistory();
const gitWatcher = new GitFileWatcher();
const fileTreeWatcher = new FileTreeWatcher(
  HIDDEN_DIRS,
  (dirPath) => sendToWindow(mainWindow, "fs:dir-changed", dirPath),
  (failures) => sendToWindow(mainWindow, "fs:watch-failed", failures),
);
const sessionWatcher = new SessionWatcher();
// Worker state changes a manager can wait on (T3.5); see node-events.ts.
const nodeEvents = new NodeEventLog();
// Which agent each terminal runs, and which an agent started, for the record.
const recordNodes = new RecordNodes();
// Which terminals read web content, and when, for journal writes (SHR-63).
const webReads = new WebReadTracker();
// Where text pasted into an agent terminal came from (SHR-62). Without a key
// nothing could be fingerprinted, so handoffs go unrecorded, and say so.
let handoffKey: Buffer | null = null;
try {
  handoffKey = loadHandoffKey(TACIT_DIR);
} catch (error) {
  console.warn("[Handoff] no fingerprint key; handoffs won't be recorded:", error);
}
const handoffs = handoffKey ? new HandoffTracker(handoffKey) : null;
/** The clipboard's text, read only at a checkpoint, a copy or a paste. */
function clipboardText(): string | null {
  try {
    return clipboard.readText() || null;
  } catch {
    return null;
  }
}
/** The handoffs a prompt contains, as the prompt entry's input_refs. */
function promptHandoffRefs(terminalId: string, text: string | null): CaptureReference[] {
  return (handoffs?.promptRefs(`terminal:${terminalId}`, text) ?? []).map((id) => ({
    ref: `event:${id}`,
    kind: "event" as const,
    label: "handoff",
  }));
}
const telemetryService = new TelemetryService({
  // An agent's own web tools (WebFetch, web_search, a browser MCP server).
  onToolUse: (terminalId, tool, at) => webReads.noteToolUse(terminalId, tool, at),
  // Claude's title for its session can name the task its first prompt opened.
  onSessionTitle: (terminalId, title) => runTracker.agentTitle(`terminal:${terminalId}`, title),
  // Which agent session each terminal runs: the join to its transcript.
  onSessionLinked: (terminalId, link) => {
    captureService.record(
      { kind: "session", node: `terminal:${terminalId}`, session_id: link.sessionId, provider: link.provider },
      captureCanvasId,
      new Date(),
      { method: "main", sessionId: link.sessionId },
    );
  },
  // OpenCode has no prompt hook; its prompts are read from its database.
  onUserPrompt: (terminalId, { text, sessionId }) => {
    const source = typedPromptSource(terminalId, text);
    if (!source) return;
    const inputRefs = promptHandoffRefs(terminalId, text);
    captureService.record(
      {
        kind: "prompt",
        actor: `terminal:${terminalId}`,
        session: sessionId,
        text,
        ...(source === "user" ? {} : { source }),
      },
      captureCanvasId,
      new Date(),
      { method: "session", sessionId, ...(inputRefs.length && source === "user" ? { inputRefs } : {}) },
    );
  },
  onSnapshotChanged: (terminalId, snapshot) => {
    const changes = nodeEvents.observeSnapshot(terminalId, snapshot);
    for (const entry of recordNodes.workerStateEntries(terminalId, changes)) {
      captureService.record(entry, captureCanvasId, new Date(), { method: "main" });
    }
    sendToWindow(mainWindow, "telemetry:snapshot-changed", {
      terminalId,
      snapshot,
    });
  },
});
const agentService = new AgentService();
const sessionScanner = new SessionScanner();
const renderDiagnostics = createRenderDiagnosticsLogger(
  app.getPath("userData"),
);
const workspaceSavePaths = new WorkspaceSavePathRegistry((filePath) =>
  path.resolve(filePath),
);
let throttlingCoordinator: RenderThrottlingCoordinator | null = null;
let hookSocketPath: string | null = null;
// The open run (T4.1): its id goes on every entry as task_id.
/**
 * Managers in chat mode (T6.2): the agent runs in its structured protocol
 * under the manager terminal's id, with the same tools, hooks and
 * environment the terminal would give it.
 */
const chatEngine = new ChatEngine({
  spawn: (command, args, options) => spawnChild(command, [...args], { ...options, stdio: "pipe" }),
  prepare: async ({ terminalId, agent, cwd }) => {
    const plan = prepareBridgeLaunch({
      terminalType: agent,
      terminalId,
      serverPath: getTacitBridgeCliPath(),
      portFile: PORT_FILE,
      inheritedEnv: await getLoginShellEnv(),
    });
    const spec = await buildLaunchSpec({
      cwd,
      shell: agent,
      args: [],
      terminalId,
      terminalType: agent,
      extraPathEntries: getTerminalExtraPathEntries(getCliDir(), agent),
      envOverrides: {
        ...(plan?.env ?? {}),
        ...(hookSocketPath ? { TACIT_SOCKET: hookSocketPath } : {}),
      },
    });
    return { command: spec.file, bridgeArgs: plan?.args ?? [], env: spec.env };
  },
  onEvent: (terminalId, event) => {
    // OpenCode has no prompt hook: what's typed to it is read from its
    // database, for the session it says it's on, as for its terminals.
    if (event.kind === "session" && chatEngine.agentOf(terminalId) === "opencode") {
      const sessionFile = resolveSessionFile(event.sessionId, "opencode", chatEngine.cwdOf(terminalId) ?? "");
      recordNodes.detected(terminalId, "opencode");
      telemetryService.attachSessionSource({ terminalId, provider: "opencode", sessionId: event.sessionId, confidence: "strong", sessionFile: sessionFile ?? undefined });
    }
    sendToWindow(mainWindow, "chat:event", { terminalId, event });
  },
  // Stream-json fires no Stop hook; the turn's end is the stream's own.
  onTurnEnded: (terminalId, sessionId) =>
    telemetryService.recordHookEvent(terminalId, { hook_event_name: "Stop", ...(sessionId ? { session_id: sessionId } : {}) }),
  limits: chatLimitStore(path.join(TACIT_DIR, "chat-limits.json")),
  // The agent's own record of the session, so the chat shows what was said
  // in the terminal and before a restart, as the terminal does.
  loadHistory: async (agent, sessionId) => {
    // OpenCode replays its history as it opens the session; there's no file.
    if (agent === "opencode") return null;
    const file = findSessionFile(agent, sessionId, os.homedir());
    if (!file) return null;
    const replay = await sessionScanner.loadReplay(file);
    // Files the conversation sent are held again, so the chat can open them.
    return Promise.all(
      timelineToChatEvents(replay.events).map(async (event) =>
        event.kind === "user_message" && event.attachments?.length
          ? { ...event, attachments: await Promise.all(event.attachments.map((a) => chatAttachments.rehold(a))) }
          : event,
      ),
    );
  },
  log: (line) => dbg(line),
});

/**
 * A picture of an attached file for the chat, at most 480px: Quick Look's
 * thumbnail where there is one (a PDF's first page, a slide, a video frame,
 * an image), small enough to keep with the message.
 */
async function attachmentPreview(filePath: string): Promise<string | undefined> {
  if ((fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? Infinity) > 2 * 1024 * 1024 * 1024) return undefined;
  let image: Electron.NativeImage | null = null;
  if (process.platform === "darwin" || process.platform === "win32") {
    try {
      image = await nativeImage.createThumbnailFromPath(filePath, { width: 480, height: 480 });
    } catch {
      image = null; // No thumbnail for this kind of file.
    }
  }
  if (!image || image.isEmpty()) image = attachmentKind(filePath) === "image" ? nativeImage.createFromPath(filePath) : null;
  if (!image || image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  const scale = Math.min(1, 480 / Math.max(width, height));
  const small = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "good" }) : image;
  const png = small.toPNG();
  // A photo is far smaller as JPEG; a small PNG keeps its transparency.
  return png.byteLength <= 200_000 ? `data:image/png;base64,${png.toString("base64")}` : `data:image/jpeg;base64,${small.toJPEG(82).toString("base64")}`;
}

/** Files sent with chat messages; pasted images are saved beside Tacit's state. */
const chatAttachments = new ChatAttachments({
  dir: path.join(TACIT_DIR, "chat-attachments"),
  preview: attachmentPreview,
  log: (line) => dbg(line),
});

const runTracker = new RunTracker({
  statePath: path.join(TACIT_DIR, "current-run.json"),
  write: (event, now) => captureService.record(event, captureCanvasId, now, { method: "main" }),
  isBusy: () => telemetryService.anyTerminalRunning(),
  onChange: (run, change) => sendToWindow(mainWindow, "run:changed", { run, change }),
  sessionOf: (node) => {
    const snapshot = node.startsWith("terminal:") ? telemetryService.getTerminalSnapshot(node.slice("terminal:".length)) : null;
    if (!snapshot?.session_id) return null;
    return { provider: snapshot.provider, session_id: snapshot.session_id, file: snapshot.session_file ?? null };
  },
  keepTranscripts: (sessions) => {
    void transcriptKeeper.keep(
      sessions.map((s) => {
        // A session found before its file was: the terminal may know it now.
        const live = s.file ? null : telemetryService.getTerminalSnapshot(s.node.slice("terminal:".length));
        const file = s.file ?? (live?.session_id === s.session_id ? live.session_file ?? null : null);
        return { provider: s.provider, sessionId: s.session_id, sessionFile: file };
      }),
    );
  },
});
// Earlier builds wrote the record readable by every account on the Mac.
{
  const { changed, failed } = makeRecordPrivate(getCaptureDir(TACIT_DIR));
  if (changed || failed) console.log(`[CaptureService] made the record private: ${changed} changed, ${failed} couldn't be`);
}
const transcriptKeeper = new TranscriptKeeper(getCaptureDir(TACIT_DIR));
const captureService = new CaptureService(getCaptureDir(TACIT_DIR), undefined, {
  harnessOf: (ref) => recordNodes.harnessOf(ref),
  taskIdFor: (event) => runTracker.taskIdFor(event),
  onRecorded: (entry) => noteWebReads(entry),
});

/** A prompt starts a terminal's turn; a Tacit browser tile it drove hands it page text. */
function noteWebReads(entry: CaptureEntry): void {
  const terminalOf = (ref: string) => (ref.startsWith("terminal:") ? ref.slice("terminal:".length) : null);
  if (entry.kind === "prompt") {
    const terminalId = terminalOf(entry.actor);
    if (terminalId) webReads.noteTurnStart(terminalId, entry.at);
  } else if (entry.kind === "browser_action" && entry.ok) {
    const terminalId = terminalOf(entry.by);
    if (terminalId) webReads.noteBrowserAction(terminalId, { browser: entry.node, action: entry.action, url: entry.url, at: entry.at });
  } else if (entry.kind === "close") {
    const terminalId = terminalOf(entry.node);
    if (terminalId) webReads.forget(terminalId);
    handoffs?.forget(entry.node);
  }
}
const managerRoleLog = new ManagerRoleLog(getManagerRoleLogPath(TACIT_DIR));
managerRoleLog.load();
/**
 * Text this app pushed into a terminal, so the prompt hook can tell it apart
 * from something the user actually typed. See InjectedTextTracker.
 */
const injectedText = new InjectedTextTracker();
/**
 * Text one agent sent another through the bridge. It is recorded when sent,
 * attributed to the sender, so the prompt hook drops its echo instead of
 * recording it a second time as if the user had typed it.
 */
// Ten minutes, not the 30 seconds app notices get: a worker that is mid-turn
// takes the message only when its turn ends (a 47-second count did, in the
// T3.1 hand test), and a late echo must still be recognised.
const agentSentText = new InjectedTextTracker(10 * 60 * 1000);
/**
 * Reader over the decision record and the workspace journal. The journal
 * directory is resolved lazily because it is keyed on the active canvas, which
 * the renderer owns and which changes as canvases are switched.
 */
const recallService = new RecallService(getCaptureDir(TACIT_DIR), () =>
  captureCanvasId ? getMemoryDirForWorkspace(captureCanvasId) : null,
);
const browserConnectionRegistry = new BrowserConnectionRegistry();
const connectedBrowserBroker = new ConnectedBrowserBroker(browserConnectionRegistry);
let desktopApiPort: number | null = null;
/**
 * Which canvas entries are attributed to. Main has no view of the canvas
 * registry, so the renderer reports it (see the capture:set-canvas handler) and
 * hook-driven entries — which arrive here, not there — can still be attributed.
 * Null until the renderer has booted, which is correct rather than a default:
 * an entry recorded before then genuinely has no known canvas.
 */
let captureCanvasId: string | null = null;

/**
 * Who wrote a prompt that reached a terminal, or null when an agent sent it
 * through the bridge and it was recorded then. Three possible authors, only
 * one of which is evidence of judgement. App injections are matched exactly
 * against what we just wrote; harness wrappers on their machine-only shape.
 */
function typedPromptSource(terminalId: string, text: string): CaptureTextSource | null {
  if (agentSentText.claim(terminalId, text)) return null;
  if (injectedText.claim(terminalId, text)) return "app";
  // A new manager gets the briefing as its launch prompt, not typed in, so
  // nothing noted it; it is still the app speaking.
  if (isWorkspaceManagerBriefing(text)) return "app";
  if (detectHarnessText(text)) return "harness";
  return "user";
}

const hookReceiver = new HookReceiver((event) => {
  telemetryService.recordHookEvent(event.terminal_id, event);

  // Claude reports its own subagents through these; other harnesses' are
  // invisible to Tacit for now (SHR-118).
  if (event.hook_event_name === "SubagentStart" || event.hook_event_name === "SubagentStop") {
    const agentType = (event as { agent_type?: unknown }).agent_type;
    nodeEvents.append(
      `terminal:${event.terminal_id}`,
      event.hook_event_name === "SubagentStart" ? "subagent_started" : "subagent_finished",
      typeof agentType === "string" ? { detail: agentType } : {},
    );
  }

  // The one hook that is a choice point: the words the user actually typed.
  // Everything else the hooks deliver (tool calls, turn boundaries) is
  // activity, and belongs in telemetry, not the record.
  if (event.hook_event_name === "UserPromptSubmit") {
    const prompt = (event as { prompt?: unknown }).prompt;
    const hasText = typeof prompt === "string";
    const source: CaptureTextSource | null = hasText ? typedPromptSource(event.terminal_id, prompt) : "user";
    if (!source) return;
    const inputRefs = promptHandoffRefs(event.terminal_id, hasText ? prompt : null);
    captureService.record(
      {
        kind: "prompt",
        actor: `terminal:${event.terminal_id}`,
        session: event.session_id ?? null,
        text: hasText ? prompt : null,
        ...(source === "user" ? {} : { source }),
        // If Claude Code ever renames this field, the record says so on the
        // first prompt instead of quietly filling with nulls.
        ...(hasText
          ? {}
          : {
              unexpected_keys: Object.keys(event).filter(
                (key) => key !== "terminal_id" && key !== "hook_event_name",
              ),
            }),
      },
      captureCanvasId,
      new Date(),
      {
        method: "hook",
        sessionId: event.session_id ?? null,
        ...(inputRefs.length && source === "user" ? { inputRefs } : {}),
      },
    );
  }

  if (event.hook_event_name === "SessionStart" && event.session_id) {
    // Only acts when this terminal currently holds the manager role — that is
    // the join main is uniquely able to make, since the role lives in the
    // renderer and the session id arrives here on the hook socket.
    managerRoleLog.noteSessionStart(
      event.terminal_id,
      event.session_id,
      typeof event.transcript_path === "string" ? event.transcript_path : null,
    );
    sendToWindow(mainWindow, "hook:session-started", {
      terminalId: event.terminal_id,
      sessionId: event.session_id,
      transcriptPath: event.transcript_path ?? null,
      cwd: event.cwd ?? null,
    });
  } else if (event.hook_event_name === "Stop") {
    sendToWindow(mainWindow, "hook:turn-complete", {
      terminalId: event.terminal_id,
      sessionId: event.session_id ?? null,
    });
  } else if (event.hook_event_name === "StopFailure") {
    sendToWindow(mainWindow, "hook:stop-failure", {
      terminalId: event.terminal_id,
      sessionId: event.session_id ?? null,
      error: event.error ?? null,
      errorDetails: event.error_details ?? null,
    });
  }
});
const taskStore = new PinStore(path.join(TACIT_DIR, "pins"));

taskStore.on("pin:created", (payload: { pin: unknown; repo: string }) => {
  sendToWindow(mainWindow, "pin:event", { type: "pin:created", ...payload });
});
taskStore.on("pin:updated", (payload: { pin: unknown; repo: string }) => {
  sendToWindow(mainWindow, "pin:event", { type: "pin:updated", ...payload });
});
taskStore.on("pin:removed", (payload: { id: string; repo: string }) => {
  sendToWindow(mainWindow, "pin:event", { type: "pin:removed", ...payload });
});

const apiServer = new ApiServer({
  getWindow: () => mainWindow,
  ptyManager,
  projectScanner,
  telemetryService,
  taskStore,
  dataUrlToPngBuffer,
  recallService,
  connectedBrowserBroker,
  recordDecision: (event) =>
    captureService.record(event, captureCanvasId, new Date(), { method: "main" }),
  workerCaps: workerCapsFor(os.totalmem()),
  nodeEvents,
  runs: runTracker,
  webReads,
  harnessOf: (ref) => recordNodes.harnessOf(ref),
  recordAgentPrompt: ({ targetTerminalId, by, text }) => {
    agentSentText.note(targetTerminalId, text);
    captureService.record(
      {
        kind: "prompt",
        actor: `terminal:${targetTerminalId}`,
        session: null,
        text,
        source: "agent",
        by,
      },
      captureCanvasId,
      new Date(),
      { method: "main" },
    );
  },
});

function openPinPreviewWindow(repo: string, pinId: string): void {
  const pin = taskStore.get(repo, pinId);
  if (!pin) {
    throw new Error(`Pin not found: ${pinId}`);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: pin.title.trim() || "Pin Preview",
    backgroundColor: "#ffffff",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  let initialUrl: string | null = null;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (initialUrl && url === initialUrl) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  const html = buildPinRenderHtml(pin);
  initialUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  void win.loadURL(initialUrl);
}

/**
 * Browser observation (tier 2 of the record). Main owns the whole path: it
 * chooses the guest preload, decides which session belongs to which profile,
 * and is the only place observations are written. The renderer is not involved
 * and never sees page contents.
 */
let observationStore: BrowserObservationStore | null = null;

/**
 * Guest session → profile id. A WeakMap so a session that goes away takes its
 * entry with it, and keyed on the session object because Electron has no API
 * to ask a session what partition named it.
 */
const guestSessionProfiles = new WeakMap<Electron.Session, string>();

/**
 * Imported profile → the Chrome profile it came from (`Profile 4`), as the
 * renderer last reported. A sign-in a node can't do opens in that Chrome
 * profile, and that Chrome profile is watched for new logins (SHR-132).
 */
const chromeSourceByIdentity = new Map<string, string>();
let chromeLoginWatch: ChromeLoginWatch | null = null;

/** Sends a sign-in page out: to the node's own Chrome profile when it has one. */
function openSignInOutside(contents: Electron.WebContents, url: string): void {
  const identityId = guestSessionProfiles.get(contents.session);
  const chromeProfile = identityId ? chromeSourceByIdentity.get(identityId) : undefined;
  if (chromeProfile) {
    openInChromeProfile(chromeProfile, url).catch((error) => {
      console.warn("[chrome-sign-in] couldn't open Chrome's profile; using the default browser", error);
      void shell.openExternal(url);
    });
  } else {
    void shell.openExternal(url);
  }
  sendToWindow(mainWindow, "browser:external-auth-redirect", {
    url,
    ...(chromeProfile && identityId ? { identityId } : {}),
  });
}

/**
 * What browser profile storage exists on disk, as opposed to what the workspace
 * remembers. Main owns it because main is the only side that may name a path:
 * the renderer sees counts, names and ids, never a directory.
 *
 * `isPartitionInUse` is answered from the guest map above rather than by asking
 * Electron for a session — asking would materialise the partition, recreating
 * the very directory a reap is trying to remove.
 */
const browserPartitionStore = new BrowserPartitionStore({
  userDataDir: app.getPath("userData"),
  isPartitionInUse: (identityId) =>
    webContents
      .getAllWebContents()
      .some(
        (contents) =>
          !contents.isDestroyed() &&
          guestSessionProfiles.get(contents.session) === identityId,
      ),
  log: (event) => console.warn("[browser-partitions]", event),
});

/**
 * Erases everything the session itself holds. `clearStorageData` alone was the
 * old behaviour, and it is what made the delete copy untrue: caches keep
 * fetched pages, auth caches keep HTTP credentials, and the directory outlives
 * both. This clears all of it; the directory is the partition store's job.
 */
async function eraseIdentitySessionData(identityId: string): Promise<void> {
  const identitySession = session.fromPartition(
    partitionForBrowserIdentity(identityId),
  );
  await identitySession.clearStorageData();
  await identitySession.clearCache();
  await identitySession.clearAuthCache();
  // An empty url list means every entry in the code cache directory.
  await identitySession.clearCodeCaches({ urls: [] });
  await identitySession.clearHostResolverCache();
}

function guestObserverPreloadPath(): string {
  return path.join(__dirname, "browser-observer-preload.cjs");
}

/**
 * Records which profile a partition belongs to, at attach time, while the
 * partition name is still in hand. `fromPartition` returns the cached instance
 * for a given name, so the session resolved here is object-identical to the one
 * the guest ends up running on.
 */
function rememberGuestPartition(partition: unknown): void {
  const identityId = identityIdFromPartition(partition);
  if (!identityId || typeof partition !== "string") return;
  // Registered before the session is resolved: `fromPartition` is what creates
  // the directory, so anything that recorded it afterwards would miss a crash
  // in between and leave a partition nothing knows about.
  browserPartitionStore.register(identityId, { origin: "session" });
  const guestSession = session.fromPartition(partition);
  guestSessionProfiles.set(guestSession, identityId);
  installGuestDownloads(guestSession);
  presentSessionAsChrome(guestSession);
}

/**
 * Browser nodes present as the Chrome they're built from (SHR-130), worked
 * out once per launch: the versions are Electron's and the OS's own.
 */
let guestChromeIdentity: ChromeIdentity | null = null;
function browserChromeIdentity(): ChromeIdentity {
  guestChromeIdentity ??= chromeIdentity({
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    platformVersion: process.getSystemVersion(),
    arch: process.arch,
    locale: app.getLocale() || "en-US",
  });
  return guestChromeIdentity;
}

/**
 * Sign-in pages go to the system browser. Presenting as Chrome wasn't enough:
 * Google still refused sign-in in a browser node on 21 Oct ("This browser or
 * app may not be secure"), so a node would strand it. They stay in the node
 * only when asked, TACIT_BROWSER_SIGNIN_IN_APP=1, until browser nodes run on
 * a real Chrome (SHR-130).
 */
const SIGN_IN_IN_SYSTEM_BROWSER = process.env.TACIT_BROWSER_SIGNIN_IN_APP !== "1";
const isSignInSentOut = (url: string): boolean => SIGN_IN_IN_SYSTEM_BROWSER && isEmbeddedAuthBlockedUrl(url);

/**
 * The client hints each origin asked for with `Accept-CH`, as Chrome
 * remembers them: sent on that origin's later requests. Seeded with the
 * sign-in origins, so a sign-in isn't the one request without them.
 */
const requestedClientHints = new Map<string, Set<string>>(
  Object.entries(SIGN_IN_ORIGINS_HINTS).map(([origin, hints]) => [origin, new Set(hints)]),
);
const NO_HINTS: ReadonlySet<string> = new Set();
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Sessions already presenting as Chrome; a second listener would replace the first. */
const chromeIdentitySessions = new WeakSet<Electron.Session>();

/**
 * A browser profile's requests as Chrome sends them: its user agent and
 * language, and the `Sec-CH-UA` hints Electron doesn't send at all.
 */
function presentSessionAsChrome(guestSession: Electron.Session): void {
  if (chromeIdentitySessions.has(guestSession)) return;
  chromeIdentitySessions.add(guestSession);
  const identity = browserChromeIdentity();
  guestSession.setUserAgent(identity.userAgent, identity.acceptLanguage);
  guestSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = originOf(details.url);
    const requested = (origin && requestedClientHints.get(origin)) || NO_HINTS;
    callback({ requestHeaders: withChromeHeaders(details.requestHeaders, details.url, identity, requested) });
  });
  guestSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    const acceptCh = Object.entries(headers).find(([name]) => name.toLowerCase() === "accept-ch")?.[1];
    const origin = acceptCh ? originOf(details.url) : null;
    if (origin) requestedClientHints.set(origin, new Set(parseAcceptCh(acceptCh)));
    callback({});
  });
}

/**
 * The page's side of the same identity: `navigator.userAgent`,
 * `navigator.userAgentData` and `navigator.platform`, set over CDP as Chrome's
 * own tools do, since Electron has no other way to set the brand list.
 */
function presentPageAsChrome(contents: Electron.WebContents): void {
  const identity = browserChromeIdentity();
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  } catch (error) {
    dbg(`browser identity: attach failed id=${contents.id} ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  contents.debugger
    .sendCommand("Emulation.setUserAgentOverride", {
      userAgent: identity.userAgent,
      acceptLanguage: identity.acceptLanguage,
      platform: identity.navigatorPlatform,
      userAgentMetadata: identity.metadata,
    })
    .catch((error: unknown) => {
      dbg(`browser identity: override failed id=${contents.id} ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Sessions already carrying a download handler; attaching twice fires twice. */
const downloadHandledSessions = new WeakSet<Electron.Session>();

/**
 * Downloads inside a browser node.
 *
 * Without this a download does nothing visible at all, which reads as "this
 * browser can't", and the repair is Chrome — taking the rest of the session out
 * of the record with it. The rules that make it safe to just *work* live in
 * browser-downloads.ts: the OS Downloads folder always, a name sanitised down
 * to one path segment, no overwrite, and nothing opened afterwards.
 */
function installGuestDownloads(guestSession: Electron.Session): void {
  if (downloadHandledSessions.has(guestSession)) return;
  downloadHandledSessions.add(guestSession);

  guestSession.on("will-download", (_event, item, webContents) => {
    const { filePath, filename } = resolveDownloadSavePath({
      directory: app.getPath("downloads"),
      suggested: item.getFilename(),
      exists: (candidate) => fs.existsSync(candidate),
    });
    // Setting a path also suppresses Electron's save dialog. That is the
    // intent: a dialog per download is friction, and the destination was never
    // the page's to propose.
    item.setSavePath(filePath);

    const url = item.getURL();
    const sourceWebContentsId = webContents?.id ?? null;
    sendToWindow(mainWindow, "browser:download-event", {
      phase: "started",
      filename,
      url,
      sourceWebContentsId,
    });
    item.once("done", (_doneEvent, state) => {
      // The renderer is told a token, never the path — so "Show in Finder"
      // can work without an absolute path ever reaching renderer state, logs
      // or a workspace snapshot. Main holds the mapping and reveals on
      // request; the token is meaningless anywhere else.
      const revealToken = state === "completed" ? randomUUID() : null;
      if (revealToken) rememberRevealableDownload(revealToken, filePath);
      sendToWindow(mainWindow, "browser:download-event", {
        phase: "done",
        filename,
        url,
        sourceWebContentsId,
        outcome: state,
        revealToken,
      });
    });
  });
}

/**
 * Completed downloads the user may still ask to reveal, keyed by an opaque
 * token. Bounded because this is a convenience, not a history: the oldest
 * entries fall off, and a stale token simply does nothing.
 */
const revealableDownloads = new Map<string, string>();
const MAX_REVEALABLE_DOWNLOADS = 50;

function rememberRevealableDownload(token: string, filePath: string): void {
  revealableDownloads.set(token, filePath);
  while (revealableDownloads.size > MAX_REVEALABLE_DOWNLOADS) {
    const oldest = revealableDownloads.keys().next().value;
    if (oldest === undefined) break;
    revealableDownloads.delete(oldest);
  }
}

function browserObservationsDir(): string {
  return path.join(app.getPath("userData"), "browser-observations");
}

/**
 * The store, for describing and erasing what was recorded.
 *
 * Separate from `installBrowserObservation` because those two operations must
 * work when the browser feature is switched off: a user who turns it off is
 * exactly the user who wants to delete what it wrote, and refusing them until
 * they switch it back on would be absurd.
 */
function observationStoreForManagement(): BrowserObservationStore {
  if (!observationStore) {
    observationStore = new BrowserObservationStore({ rootDir: browserObservationsDir() });
  }
  return observationStore;
}

function installBrowserObservation(): void {
  if (observationStore) return;
  observationStore = new BrowserObservationStore({
    rootDir: browserObservationsDir(),
  });
  ipcMain.handle("browser:reveal-download", (_event, token: unknown) => {
    // Only tokens main itself minted resolve to anything, so a renderer cannot
    // ask for an arbitrary path to be opened.
    const filePath = typeof token === "string" ? revealableDownloads.get(token) : undefined;
    if (!filePath || !fs.existsSync(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.on(BROWSER_OBSERVATION_CHANNEL, (event, observation) => {
    // Any renderer can post on this channel; only guests running on a known
    // profile partition are recorded. The main window's own session is not one,
    // so a compromised renderer cannot write into a profile's stream.
    const profileId = guestSessionProfiles.get(event.sender.session);
    if (!profileId) return;
    observationStore?.record(profileId, observation);
  });
}

function createWindow() {
  installBrowserObservation();
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

/** Keep in step with src/toolbar/titleStripHeight.ts. */
const TITLE_STRIP_HEIGHT = 28;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    // Transparent on mac lets the canvas background opacity preference
    // (Settings > Appearance) show the desktop through, like a terminal's
    // window opacity. Other platforms keep an opaque window — Electron's
    // transparent-window support is inconsistent on Windows/Linux.
    ...(isMac ? { transparent: true } : { backgroundColor: "#101010" }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    ...(isMac && {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 14 },
    }),
    ...(isWin && {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#888888",
        // Matches TITLE_STRIP_HEIGHT in the renderer. If these two disagree the
        // native caption buttons are drawn over the rails.
        height: TITLE_STRIP_HEIGHT,
      },
    }),
    ...(!isMac &&
      !isWin && {
        titleBarStyle: "hidden" as const,
      }),
  });
  const windowId = mainWindow.id;
  renderDiagnostics.recordMainEvent("browser_window_created", {
    isDev,
    window_id: windowId,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // The guest preload is chosen here, in main, and never taken from the
    // renderer's attributes — a renderer-supplied path would be an arbitrary
    // script running inside the user's authenticated pages. It observes only;
    // see electron/browser-observer-preload.ts for what it may and may not do.
    // contextIsolation above is what keeps it unreachable from page scripts.
    webPreferences.preload = guestObserverPreloadPath();
    rememberGuestPartition(webPreferences.partition);
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!isDev && isReloadShortcutInput(input)) {
      event.preventDefault();
      return;
    }

    if (!isSelectAllShortcutInput(input)) {
      return;
    }

    event.preventDefault();
    mainWindow?.webContents.send("menu:select-all");
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  if (isDev) {
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) console.log("[renderer]", message);
    });
  }
  mainWindow.on("closed", () => {
    renderDiagnostics.recordMainEvent("browser_window_closed", {
      window_id: windowId,
    });
    mainWindow = null;
    rendererReady = false;
  });
  mainWindow.on("focus", () => {
    handoffs?.windowFocusChanged(true, clipboardText());
    renderDiagnostics.recordMainEvent("browser_window_focus", {
      window_id: windowId,
      visible: mainWindow?.isVisible() ?? null,
    });
    // macOS re-activation can leave compositor-backed sidebar layers stale
    // until the next input-driven repaint. Force a full redraw on focus so
    // fixed/overflow-hidden panels repaint immediately.
    mainWindow?.webContents.invalidate();
    for (const dirPath of fileTreeWatcher.getWatchedDirs()) {
      sendToWindow(mainWindow, "fs:dir-changed", dirPath);
    }
    // macOS Space switching does not reliably fire `visibilitychange` on the
    // renderer side, so the renderer's existing recovery path can miss the
    // return-from-Space transition entirely. Push a lifecycle ping from the
    // main process (which is never throttled) so the renderer can repaint
    // its terminals regardless of whether visibilitychange fired.
    sendToWindow(mainWindow, "tc:lifecycle:visible", {
      reason: "browser_window_focus",
      timestamp: Date.now(),
    });
  });
  mainWindow.on("blur", () => {
    handoffs?.windowFocusChanged(false, clipboardText());
    renderDiagnostics.recordMainEvent("browser_window_blur", {
      window_id: windowId,
      visible: mainWindow?.isVisible() ?? null,
    });
  });
  mainWindow.on("show", () => {
    renderDiagnostics.recordMainEvent("browser_window_show", {
      window_id: windowId,
    });
    sendToWindow(mainWindow, "tc:lifecycle:visible", {
      reason: "browser_window_show",
      timestamp: Date.now(),
    });
  });
  mainWindow.on("hide", () => {
    renderDiagnostics.recordMainEvent("browser_window_hide", {
      window_id: windowId,
    });
  });
  mainWindow.on("minimize", () => {
    renderDiagnostics.recordMainEvent("browser_window_minimize", {
      window_id: windowId,
    });
  });
  mainWindow.on("restore", () => {
    renderDiagnostics.recordMainEvent("browser_window_restore", {
      window_id: windowId,
    });
  });
  // In full screen the OS hides the traffic lights and shows its own title
  // bar on hover, so the renderer drops its title strip (titleStripHeight.ts).
  const fullScreenWindow = mainWindow;
  const reportFullScreen = () => {
    if (!fullScreenWindow.isDestroyed()) {
      fullScreenWindow.webContents.send("window:full-screen", fullScreenWindow.isFullScreen());
    }
  };
  mainWindow.on("enter-full-screen", reportFullScreen);
  mainWindow.on("leave-full-screen", reportFullScreen);

  createMenu(mainWindow);
  agentService.setWindow(mainWindow);

  // Disable Chromium's background-occluded throttling whenever there is
  // active work (PTY output within the last 30s). Idle stays throttled so
  // battery isn't burned when the user genuinely switched away.
  if (!throttlingCoordinator) {
    throttlingCoordinator = new RenderThrottlingCoordinator({
      target: {
        setBackgroundThrottling: (allowed) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.setBackgroundThrottling(allowed);
          }
        },
      },
      recordDiagnostic: (event) => {
        renderDiagnostics.recordMainEvent(event.kind, event.data ?? {});
      },
    });
    throttlingCoordinator.start();
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  let rendererReady = false;
  mainWindow.webContents.on("did-finish-load", async () => {
    renderDiagnostics.recordMainEvent("renderer_did_finish_load", {
      renderer_ready_before_load: rendererReady,
      window_id: windowId,
    });
    if (rendererReady) {
      console.warn("[PtyManager] renderer reloaded – destroying orphaned PTYs");
      await ptyManager.destroyAll();
    }
    rendererReady = true;
    try {
      const port = await apiServer.start();
      desktopApiPort = port;
      writePortFile(port, apiServer.getAuthToken());
      if (isDev) console.log(`[Tacit API] http://127.0.0.1:${port}`);
    } catch (err) {
      console.error("[Tacit API] Failed to start:", err);
    }
  });
  mainWindow.on("close", () => {
    renderDiagnostics.recordMainEvent("browser_window_close_requested", {
      renderer_ready: rendererReady,
      window_id: windowId,
    });
  });
}

const DEBUG_LOG = path.join(TACIT_DIR, "session-debug.log");
function dbg(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    /* ignore */
  }
}

function setupIpc() {
  ipcMain.handle(
    "terminal:create",
    async (
      _event,
      options: {
        cwd: string;
        shell?: string;
        args?: string[];
        terminalId?: string;
        terminalType?: string;
        /** "agent" when an agent spawned it; see RecordNodes. */
        origin?: string;
        theme?: "dark" | "light";
        /** The tile's measured size; checked by PtyManager, 80×24 without it. */
        cols?: number;
        rows?: number;
        workflowId?: string;
        assignmentId?: string;
        repoPath?: string;
      },
    ) => {
      dbg(
        `terminal:create shell=${options.shell ?? "(default)"} args=${JSON.stringify(options.args)} cwd=${options.cwd}`,
      );
      const cliDir = getCliDir();

      // Every agent terminal — manager, canvas worker, spawned worker — gets
      // the workspace tools through its adapter (shared/agent-adapters.ts).
      let bridgeEnv: Record<string, string> = {};
      let bridgeFiles: string[] = [];
      if (options.terminalId) {
        try {
          const plan = prepareBridgeLaunch({
            terminalType: options.terminalType,
            terminalId: options.terminalId,
            serverPath: getTacitBridgeCliPath(),
            portFile: PORT_FILE,
            inheritedEnv: await getLoginShellEnv(),
          });
          if (plan) {
            options.args = applyLaunchArgs(options.args ?? [], plan);
            bridgeEnv = plan.env;
            // Shared configs an agent owns (`keep`) outlive the terminal.
            bridgeFiles = plan.files.filter((file) => !file.keep).map((file) => file.path);
          }
        } catch (error) {
          // The terminal still opens — an agent without workspace tools is
          // still a usable agent — but never silently: the person is told
          // why, and the debug log keeps it.
          const reason = error instanceof Error ? error.message : String(error);
          dbg(
            `terminal:create tools-unavailable terminalId=${options.terminalId} type=${options.terminalType} reason=${reason}`,
          );
          sendToWindow(mainWindow, "terminal:tools-unavailable", {
            terminalId: options.terminalId,
            terminalType: options.terminalType,
            reason,
          });
        }
      }

      const ptyId = await ptyManager.create({
        ...options,
        extraPathEntries: getTerminalExtraPathEntries(
          cliDir,
          options.terminalType,
        ),
        shellIntegrationDir: SHELL_INTEGRATION_DIR,
        envOverrides: {
          ...bridgeEnv,
          ...(hookSocketPath ? { TACIT_SOCKET: hookSocketPath } : {}),
        },
      });
      const pid = ptyManager.getPid(ptyId);
      dbg(`terminal:create => ptyId=${ptyId} pid=${pid ?? "null"}`);
      const terminalId = options.terminalId ?? `pty-${ptyId}`;
      recordNodes.created(terminalId, options.terminalType, options.origin);
      nodeEvents.append(`terminal:${terminalId}`, "spawned", {
        ...(options.terminalType ? { harness: options.terminalType } : {}),
      });
      telemetryService.registerTerminal({
        terminalId,
        worktreePath: options.cwd,
        provider:
          options.terminalType === "claude" ||
          options.terminalType === "codex" ||
          options.terminalType === "wuu"
            ? options.terminalType
            : "unknown",
        workflowId: options.workflowId,
        assignmentId: options.assignmentId,
        repoPath: options.repoPath,
        ptyId,
        shellPid: pid ?? null,
      });
      telemetryService.recordPtyCreated({
        terminalId,
        ptyId,
        shellPid: pid ?? null,
      });
      ptyManager.onData(ptyId, (data: string) => {
        ptyManager.captureOutput(ptyId, data);
        telemetryService.recordPtyOutputByPtyId(ptyId, data);
        outputBatcher.push(ptyId, data);
        throttlingCoordinator?.markActivity("pty");
      });
      ptyManager.onExit(ptyId, (exitCode: number) => {
        // The agent has read its per-terminal config by now; don't let one
        // file per terminal ever opened accumulate in the temp folder.
        for (const file of bridgeFiles) fs.rmSync(file, { force: true });
        dbg(
          `terminal:exit ptyId=${ptyId} pid=${pid ?? "null"} exitCode=${exitCode}`,
        );
        telemetryService.recordPtyExitByPtyId(ptyId, exitCode);
        sendToWindow(mainWindow, "terminal:exit", ptyId, exitCode);
      });
      return ptyId;
    },
  );

  ipcMain.on("terminal:input", (_event, ptyId: number, data: string) => {
    ptyManager.write(ptyId, data);
    telemetryService.recordPtyInputByPtyId(ptyId, data);
  });

  ipcMain.on(
    "terminal:resize",
    (_event, ptyId: number, cols: number, rows: number) => {
      ptyManager.resize(ptyId, cols, rows);
    },
  );

  ipcMain.on("terminal:theme-changed", (_event, ptyId: number) => {
    ptyManager.notifyThemeChanged(ptyId);
  });

  ipcMain.handle("terminal:destroy", async (_event, ptyId: number) => {
    await ptyManager.destroy(ptyId);
  });

  ipcMain.handle("terminal:get-pid", (_event, ptyId: number) => {
    const pid = ptyManager.getPid(ptyId) ?? null;
    dbg(`terminal:get-pid ptyId=${ptyId} => pid=${pid}`);
    return pid;
  });

  ipcMain.handle("terminal:detect-cli", async (_event, ptyId: number) => {
    const shellPid = ptyManager.getPid(ptyId);
    if (!shellPid) return null;
    return detectCli(shellPid);
  });

  ipcMain.handle("session:get-codex-latest", () => {
    try {
      return readLatestCodexSessionId();
    } catch (err) {
      console.warn(
        "[session:get-codex-latest] failed to read session index:",
        err,
      );
      return null;
    }
  });

  ipcMain.handle(
    "session:find-codex",
    (_event, cwd: string, startedAt?: string) => {
      return findBestCodexSession(cwd, startedAt);
    },
  );

  ipcMain.handle("session:get-claude-by-pid", (_event, pid: number) => {
    try {
      const sessionFile = path.join(
        os.homedir(),
        ".claude",
        "sessions",
        `${pid}.json`,
      );
      const exists = fs.existsSync(sessionFile);
      dbg(
        `session:get-claude-by-pid pid=${pid} file=${sessionFile} exists=${exists}`,
      );
      if (!exists) {
        const sessDir = path.join(os.homedir(), ".claude", "sessions");
        try {
          const files = fs
            .readdirSync(sessDir)
            .filter((f) => f.endsWith(".json"));
          dbg(`  session files in dir: ${files.join(", ")}`);
        } catch {
          /* ignore */
        }
        return null;
      }
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      dbg(`  found sessionId=${data.sessionId}`);
      return data.sessionId as string;
    } catch (err) {
      dbg(`  ERROR: ${err}`);
      return null;
    }
  });

  ipcMain.handle(
    "session:find-claude",
    (_event, cwd: string, startedAt?: string, pid?: number | null) => {
      return findBestClaudeSession(cwd, startedAt, pid);
    },
  );

  ipcMain.handle(
    "session:find-wuu",
    (_event, cwd: string, startedAt?: string) => {
      return findBestWuuSession(cwd, startedAt);
    },
  );

  ipcMain.handle(
    "session:find-kimi",
    (_event, cwd: string, startedAt?: string) => {
      return findBestKimiSession(cwd, startedAt);
    },
  );

  ipcMain.handle("session:find-antigravity", (_event, terminalId: string) => {
    if (typeof terminalId !== "string" || !terminalId) return null;
    return findAntigravityConversation(terminalId);
  });

  ipcMain.handle(
    "session:find-opencode",
    (_event, cwd: string, startedAt?: string, terminalId?: unknown) => {
      const self = typeof terminalId === "string" && terminalId ? terminalId : null;
      return findBestOpenCodeSession(cwd, startedAt, undefined, telemetryService.sessionsHeldByOthers("opencode", self));
    },
  );

  // A terminal still looking for its OpenCode session waits for OpenCode's
  // next database write; see electron/opencode-activity.ts.
  const openCodeActivity = new OpenCodeActivity(getOpenCodeDbPath());
  ipcMain.handle("session:wait-opencode-write", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    await openCodeActivity.next();
  });

  ipcMain.handle(
    "session:get-permission-mode",
    (_event, sessionId: string, cwd: string) => {
      return readClaudeSessionPermissionMode(sessionId, cwd);
    },
  );

  ipcMain.handle(
    "session:get-bypass-state",
    (_event, type: string, sessionId: string, cwd: string) => {
      if (type === "claude") {
        return (
          readClaudeSessionPermissionMode(sessionId, cwd) ===
          "bypassPermissions"
        );
      }
      if (type === "codex") {
        return readCodexSessionBypassState(sessionId, cwd);
      }
      return false;
    },
  );

  /**
   * Pick several folders in one sheet.
   *
   * Kept separate from `project:select-directory` rather than widening it:
   * the ordinary "add a project" command wants exactly one folder and would
   * have to discard the extras, so the two callers ask different questions
   * and get different answers.
   */
  ipcMain.handle("project:select-directories", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle("project:select-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      // `createDirectory` puts macOS's own New Folder button in the sheet, so
      // someone who meant to start something new is not forced to leave and
      // make the folder in Finder first.
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * Make a new folder to work in, named and placed by the user.
   *
   * A save sheet rather than an open sheet: it is the one native dialog that
   * asks for a name and a location together, which is exactly the question
   * "where should this live and what is it called". The directory is created
   * here rather than left to the caller so a cancelled sheet and a failed
   * mkdir are distinguishable — null means the user backed out.
   */
  ipcMain.handle("project:create-directory", async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Create a space",
      buttonLabel: "Create",
      nameFieldLabel: "Name:",
      properties: ["createDirectory"],
    });
    if (result.canceled || !result.filePath) return null;
    // Refuse rather than adopt: picking an existing folder is what the other
    // path is for, and silently reusing one would make "create" a lie the
    // second time someone runs it.
    if (fs.existsSync(result.filePath)) {
      throw new Error("That name is already taken. Choose another, or open the existing folder instead.");
    }
    fs.mkdirSync(result.filePath, { recursive: false });
    return result.filePath;
  });

  ipcMain.handle("project:scan", async (_event, dirPath: string) => {
    return await projectScanner.scanAsync(dirPath);
  });

  ipcMain.handle(
    "project:list-child-git-repos",
    async (_event, dirPath: string) => {
      return await projectScanner.listChildGitReposAsync(dirPath);
    },
  );

  ipcMain.handle("project:diff", async (_event, worktreePath: string) => {
    const startedAt = Date.now();
    try {
      const result = await getProjectDiff(worktreePath);
      perfLog("project:diff", {
        worktreePath,
        ms: Date.now() - startedAt,
        files: result.files.length,
        diffLength: result.diff.length,
      });
      return result;
    } catch {
      perfLog("project:diff:error", {
        worktreePath,
        ms: Date.now() - startedAt,
      });
      return { diff: "", files: [] };
    }
  });

  ipcMain.handle(
    "project:rescan-worktrees",
    async (_event, dirPath: string) => {
      return await projectScanner.listWorktreesAsync(dirPath);
    },
  );

  ipcMain.handle(
    "project:create-worktree",
    async (_event, repoPath: string, branch: string) => {
      const trimmedBranch = (branch ?? "").trim();
      if (!trimmedBranch) {
        return { ok: false as const, error: "Branch name is required" };
      }
      if (
        /[\s~^:?*\[\\]/.test(trimmedBranch) ||
        trimmedBranch.startsWith("-")
      ) {
        return { ok: false as const, error: "Invalid branch name" };
      }

      const resolvedRepo = path.resolve(repoPath);
      const sanitizedDirName = trimmedBranch.replace(/[\\/]/g, "-");
      const worktreePath = path.join(
        resolvedRepo,
        ".worktrees",
        sanitizedDirName,
      );

      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        await execFileAsync(
          "git",
          ["worktree", "add", "-b", trimmedBranch, worktreePath],
          { cwd: resolvedRepo, maxBuffer: 10 * 1024 * 1024 },
        );
        const worktrees = await projectScanner.listWorktreesAsync(resolvedRepo);
        return { ok: true as const, path: worktreePath, worktrees };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // git errors often include stderr on a trailing line
        return { ok: false as const, error: message };
      }
    },
  );

  ipcMain.handle(
    "project:remove-worktree",
    async (_event, repoPath: string, worktreePath: string, force?: boolean) => {
      const resolvedRepo = path.resolve(repoPath);
      const resolvedWorktree = path.resolve(worktreePath);

      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        // Reuse the shared --force builder so the renderer/IPC path matches
        // the CLI, hydra, and headless paths exactly. Without --force, git
        // refuses to remove worktrees containing modified or untracked files
        // — which is exactly what worker worktrees produce by design.
        const args = force
          ? buildGitWorktreeRemoveArgs(resolvedWorktree)
          : ["worktree", "remove", resolvedWorktree];
        await execFileAsync("git", args, {
          cwd: resolvedRepo,
          maxBuffer: 10 * 1024 * 1024,
        });
        const worktrees = await projectScanner.listWorktreesAsync(resolvedRepo);
        return { ok: true as const, worktrees };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  );

  ipcMain.handle(
    "project:delete-folder",
    async (_event, projectPath: string) => {
      try {
        const resolved = path.resolve(projectPath);
        const home = os.homedir();
        const root = path.parse(resolved).root;
        // Safety: refuse to delete obviously dangerous paths.
        if (
          !path.isAbsolute(resolved) ||
          resolved === root ||
          resolved === home ||
          home.startsWith(resolved + path.sep) ||
          resolved.split(path.sep).filter(Boolean).length < 2
        ) {
          return {
            ok: false as const,
            error: `Refusing to delete unsafe path: ${resolved}`,
          };
        }
        const { rm } = await import("fs/promises");
        await rm(resolved, { recursive: true, force: true });
        return { ok: true as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  );

  // A project's agent instructions (AGENTS.md, and CLAUDE.md importing it).
  // Only the app's own window may ask, only about an existing folder, and
  // never the home folder; checking only reads.
  ipcMain.handle("project:instructions-status", (event, dirPath: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("project:instructions-status is only for the app's window");
    return checkProjectInstructions(dirPath);
  });

  ipcMain.handle("project:set-up-instructions", (event, dirPath: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("project:set-up-instructions is only for the app's window");
    return setUpProjectInstructions(dirPath);
  });

  ipcMain.handle("git:watch", (_event, worktreePath: string) => {
    gitWatcher.watch(worktreePath, {
      onChanged: () => {
        sendToWindow(mainWindow, "git:changed", worktreePath);
      },
      onLogChanged: () => {
        sendToWindow(mainWindow, "git:log-changed", worktreePath);
      },
      onPresenceChanged: (repoState) => {
        sendToWindow(mainWindow, "git:presence-changed", worktreePath, {
          isGitRepo: repoState,
        });
      },
    });
  });

  ipcMain.handle("git:unwatch", (_event, worktreePath: string) => {
    gitWatcher.unwatch(worktreePath);
  });

  ipcMain.handle("git:is-repo", async (_event, dirPath: string) => {
    return isGitRepo(dirPath);
  });

  ipcMain.handle("git:branches", async (_event, worktreePath: string) => {
    try {
      return await getGitBranches(worktreePath);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "git:log",
    async (_event, worktreePath: string, count?: number) => {
      try {
        return await getGitLog(worktreePath, count);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle(
    "git:commit-detail",
    async (_event, worktreePath: string, hash: string) => {
      return getGitCommitDetail(worktreePath, hash);
    },
  );

  ipcMain.handle(
    "git:checkout",
    async (_event, worktreePath: string, ref: string) => {
      return checkoutGitRef(worktreePath, ref);
    },
  );

  ipcMain.handle("git:init", async (_event, worktreePath: string) => {
    return initGitRepo(worktreePath);
  });

  ipcMain.handle("git:status", async (_event, worktreePath: string) => {
    try {
      return await getGitStatus(worktreePath);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "git:stage",
    async (_event, worktreePath: string, paths: string[]) => {
      return stageFiles(worktreePath, paths);
    },
  );

  ipcMain.handle(
    "git:unstage",
    async (_event, worktreePath: string, paths: string[]) => {
      return unstageFiles(worktreePath, paths);
    },
  );

  ipcMain.handle(
    "git:discard",
    async (
      _event,
      worktreePath: string,
      tracked: string[],
      untracked: string[],
    ) => {
      return discardFiles(worktreePath, tracked, untracked);
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_event, worktreePath: string, message: string) => {
      return createCommit(worktreePath, message);
    },
  );

  ipcMain.handle("git:push", async (_event, worktreePath: string) => {
    return gitPush(worktreePath);
  });

  ipcMain.handle("git:pull", async (_event, worktreePath: string) => {
    return gitPull(worktreePath);
  });

  // ── New git handlers ──

  ipcMain.handle(
    "git:amend",
    async (_event, worktreePath: string, message: string) => {
      return amendCommit(worktreePath, message);
    },
  );

  ipcMain.handle("git:stash-list", async (_event, worktreePath: string) => {
    try {
      return await listStashes(worktreePath);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "git:stash-create",
    async (
      _event,
      worktreePath: string,
      message: string,
      includeUntracked: boolean,
    ) => {
      return createStash(worktreePath, message, includeUntracked);
    },
  );

  ipcMain.handle(
    "git:stash-apply",
    async (_event, worktreePath: string, index: number) => {
      return applyStash(worktreePath, index);
    },
  );

  ipcMain.handle(
    "git:stash-pop",
    async (_event, worktreePath: string, index: number) => {
      return popStash(worktreePath, index);
    },
  );

  ipcMain.handle(
    "git:stash-drop",
    async (_event, worktreePath: string, index: number) => {
      return dropStash(worktreePath, index);
    },
  );

  ipcMain.handle(
    "git:branch-create",
    async (_event, worktreePath: string, name: string, startPoint?: string) => {
      return createBranch(worktreePath, name, startPoint);
    },
  );

  ipcMain.handle(
    "git:branch-delete",
    async (_event, worktreePath: string, name: string, force: boolean) => {
      return deleteBranch(worktreePath, name, force);
    },
  );

  ipcMain.handle(
    "git:branch-rename",
    async (_event, worktreePath: string, oldName: string, newName: string) => {
      return renameBranch(worktreePath, oldName, newName);
    },
  );

  ipcMain.handle("git:tag-list", async (_event, worktreePath: string) => {
    try {
      return await listTags(worktreePath);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "git:tag-create",
    async (
      _event,
      worktreePath: string,
      name: string,
      ref: string,
      message?: string,
    ) => {
      return createTag(worktreePath, name, ref, message);
    },
  );

  ipcMain.handle(
    "git:tag-delete",
    async (_event, worktreePath: string, name: string) => {
      return deleteTag(worktreePath, name);
    },
  );

  ipcMain.handle("git:remote-list", async (_event, worktreePath: string) => {
    try {
      return await listRemotes(worktreePath);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "git:remote-add",
    async (_event, worktreePath: string, name: string, url: string) => {
      return addRemote(worktreePath, name, url);
    },
  );

  ipcMain.handle(
    "git:remote-remove",
    async (_event, worktreePath: string, name: string) => {
      return removeRemote(worktreePath, name);
    },
  );

  ipcMain.handle(
    "git:remote-rename",
    async (_event, worktreePath: string, oldName: string, newName: string) => {
      return renameRemote(worktreePath, oldName, newName);
    },
  );

  ipcMain.handle(
    "git:fetch",
    async (_event, worktreePath: string, remote?: string) => {
      return gitFetch(worktreePath, remote);
    },
  );

  ipcMain.handle(
    "git:merge",
    async (_event, worktreePath: string, ref: string) => {
      return gitMerge(worktreePath, ref);
    },
  );

  ipcMain.handle("git:merge-abort", async (_event, worktreePath: string) => {
    return gitMergeAbort(worktreePath);
  });

  ipcMain.handle(
    "git:rebase",
    async (_event, worktreePath: string, ref: string) => {
      return gitRebase(worktreePath, ref);
    },
  );

  ipcMain.handle("git:rebase-abort", async (_event, worktreePath: string) => {
    return gitRebaseAbort(worktreePath);
  });

  ipcMain.handle(
    "git:rebase-continue",
    async (_event, worktreePath: string) => {
      return gitRebaseContinue(worktreePath);
    },
  );

  ipcMain.handle(
    "git:cherry-pick",
    async (_event, worktreePath: string, hash: string) => {
      return gitCherryPick(worktreePath, hash);
    },
  );

  ipcMain.handle(
    "git:cherry-pick-abort",
    async (_event, worktreePath: string) => {
      return gitCherryPickAbort(worktreePath);
    },
  );

  ipcMain.handle("git:merge-state", async (_event, worktreePath: string) => {
    return getMergeState(worktreePath);
  });

  ipcMain.handle(
    "git:file-diff",
    async (_event, worktreePath: string, filePath: string, staged: boolean) => {
      return getFileDiff(worktreePath, filePath, staged);
    },
  );

  ipcMain.handle(
    "git:stage-hunk",
    async (
      _event,
      worktreePath: string,
      filePath: string,
      hunkHeader: string,
    ) => {
      return stageHunk(worktreePath, filePath, hunkHeader);
    },
  );

  ipcMain.handle(
    "git:unstage-hunk",
    async (
      _event,
      worktreePath: string,
      filePath: string,
      hunkHeader: string,
    ) => {
      return unstageHunk(worktreePath, filePath, hunkHeader);
    },
  );

  ipcMain.handle(
    "git:blame",
    async (_event, worktreePath: string, filePath: string) => {
      return getBlame(worktreePath, filePath);
    },
  );

  // ── Search handlers ──

  ipcMain.handle(
    "search:file-contents",
    async (_event, query: string, worktreePath?: string) => {
      try {
        return await searchFileContents(worktreePath ?? "", query);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle("search:session-contents", async (_event, query: string) => {
    try {
      return await searchSessionContents(query);
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "search:sessions:list",
    async (_event, projectDirs: string[]): Promise<SessionSearchEntry[]> => {
      try {
        return await listSessionsForProjects(projectDirs ?? []);
      } catch (err) {
        // Surface to main-process logs rather than silently returning
        // an empty list — a bug in listSessionsForProjects used to
        // look exactly like "no history exists", which made the
        // `findKimiSessionFiles` missing-import regression in v0.31.0
        // almost impossible to track down.
        console.error("[search:sessions:list] failed", err);
        return [];
      }
    },
  );

  ipcMain.handle(
    "search:sessions:list-page",
    async (
      _event,
      projectDirs: string[],
      options: { limit: number; offset?: number },
    ): Promise<{ entries: SessionSearchEntry[]; total: number }> => {
      try {
        return await listSessionsForProjectsPaged(projectDirs ?? [], options);
      } catch (err) {
        console.error("[search:sessions:list-page] failed", err);
        return { entries: [], total: 0 };
      }
    },
  );

  ipcMain.handle(
    "session:watch",
    (_event, type: SessionType, sessionId: string, cwd: string) => {
      return sessionWatcher.watch(sessionId, type, cwd, () => {
        sendToWindow(mainWindow, "session:turn-complete", sessionId);
      });
    },
  );

  ipcMain.handle("session:unwatch", (_event, sessionId: string) => {
    sessionWatcher.unwatch(sessionId);
  });

  // What the agent finished by saying, for a `sends-replies-to` wire to hand
  // on. Deliberately narrow: the renderer names a session and gets back one
  // message or a reason there isn't one, never a transcript path and never
  // more of the history than the part that was addressed to a person.
  ipcMain.handle(
    "session:final-reply",
    (
      _event,
      input: { sessionId: string; provider: string; cwd: string },
    ): FinalReplyResult => {
      try {
        return readFinalAssistantReply(input);
      } catch (err) {
        // A throw here would reach the renderer as a rejected invoke and be
        // reported to the user as a delivery failure, which is the wrong
        // story: nothing was attempted.
        console.error("[session:final-reply] failed", err);
        return { status: "unavailable", reason: "read-failed" };
      }
    },
  );

  ipcMain.handle(
    "telemetry:attach-session",
    (
      _event,
      input: {
        terminalId: string;
        provider: "claude" | "codex" | "kimi" | "wuu" | "opencode";
        sessionId: string;
        cwd: string;
        confidence: "strong" | "medium" | "weak";
      },
    ) => {
      const sessionFile = resolveSessionFile(
        input.sessionId,
        input.provider,
        input.cwd,
      );
      recordNodes.detected(input.terminalId, input.provider);
      telemetryService.attachSessionSource({
        terminalId: input.terminalId,
        provider: input.provider,
        sessionId: input.sessionId,
        confidence: input.confidence,
        sessionFile: sessionFile ?? undefined,
      });
      if (sessionFile) {
        invalidateSessionIndexForFile(sessionFile);
        emitSessionHistoryChanged({
          reason: "session_attached",
          projectDirs: [input.cwd],
        });
      }
      return {
        ok: sessionFile !== null,
        sessionFile,
      };
    },
  );

  ipcMain.handle("telemetry:detach-session", (_event, terminalId: string) => {
    const snapshot = telemetryService.getTerminalSnapshot(terminalId);
    telemetryService.detachSessionSource(terminalId);
    if (snapshot?.session_file) {
      invalidateSessionIndexForFile(snapshot.session_file);
    }
    emitSessionHistoryChanged({
      reason: "session_detached",
      projectDirs: snapshot?.worktree_path ? [snapshot.worktree_path] : [],
    });
  });

  ipcMain.handle(
    "telemetry:update-terminal",
    (
      _event,
      input: {
        terminalId: string;
        worktreePath?: string;
        provider?: "claude" | "codex" | "wuu" | "unknown";
        ptyId?: number | null;
        shellPid?: number | null;
      },
    ) => {
      recordNodes.detected(input.terminalId, input.provider);
      return telemetryService.updateTerminal(input);
    },
  );

  ipcMain.handle("telemetry:get-terminal", (_event, terminalId: string) => {
    return telemetryService.getTerminalSnapshot(terminalId);
  });

  ipcMain.handle(
    "telemetry:get-workflow",
    (_event, workflowId: string, repoPath: string) => {
      return telemetryService.getWorkflowSnapshot(repoPath, workflowId);
    },
  );

  ipcMain.handle(
    "telemetry:list-events",
    (
      _event,
      input: {
        terminalId: string;
        limit?: number;
        cursor?: string;
      },
    ) => {
      return telemetryService.listTerminalEvents(input);
    },
  );

  ipcMain.handle(
    "diagnostics:record-render-event",
    (_event, input: RenderDiagnosticEventInput) => {
      renderDiagnostics.recordRendererEvent(input);
    },
  );

  ipcMain.handle("diagnostics:get-render-log-info", () => {
    return renderDiagnostics.getLogInfo();
  });

  // Fire-and-forget (`on`, not `handle`): the renderer records decisions from
  // inside user interactions, and must never wait on a disk append — nor be
  // able to reject one. See CaptureService for why loss is preferred to noise.
  ipcMain.on("capture:record", (_event, entry: CaptureEvent) => {
    // Runs are written by the RunTracker alone, so a run's entries can't be
    // forged from the page; the canvas changes runs through run:start/end.
    if (entry?.kind === "run_started" || entry?.kind === "run_named" || entry?.kind === "run_ended") return;
    // A spawn arrives before the terminal's process starts; it names the
    // type, so this entry and the prompt right after it carry the harness.
    if (entry?.kind === "spawn" && typeof entry.node_type === "string" && entry.node.startsWith("terminal:")) {
      recordNodes.created(
        entry.node.slice("terminal:".length),
        entry.node_type,
        entry.by === "user" || entry.by === "system" ? "user" : "agent",
      );
    }
    captureService.record(entry, captureCanvasId, new Date(), { method: "renderer" });
  });

  ipcMain.on("capture:set-canvas", (_event, canvasId: string | null) => {
    captureCanvasId = canvasId;
  });

  ipcMain.handle("capture:get-health", () => captureService.getHealth());

  // Only the app's own window may change the run, not a browser tile.
  const isMainWindowSender = (event: Electron.IpcMainInvokeEvent) =>
    !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;

  // Whether the window is full screen, for the renderer's first layout; later
  // changes arrive as "window:full-screen".
  ipcMain.handle("window:is-full-screen", (event) =>
    isMainWindowSender(event) && mainWindow ? mainWindow.isFullScreen() : false,
  );

  // The canvas's run control. The goal is free text from the person, kept
  // in the record; anything else is refused.
  ipcMain.handle("run:current", (event) => (isMainWindowSender(event) ? runTracker.current() : null));
  ipcMain.handle("run:start", (event, goal: unknown) => {
    if (!isMainWindowSender(event)) return null;
    if (goal !== null && typeof goal !== "string") return null;
    return runTracker.start(goal, "user");
  });
  ipcMain.handle("run:end", (event) => {
    if (!isMainWindowSender(event)) return false;
    return runTracker.end("user");
  });
  ipcMain.handle("run:rename", (event, goal: unknown) => {
    if (!isMainWindowSender(event) || typeof goal !== "string") return null;
    return runTracker.rename(goal, "user");
  });

  // The manager's chat (T6.2). Only the app's window; ids, folders and
  // decisions are checked, and text is bounded.
  const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/;
  const chatId = (value: unknown): value is string => typeof value === "string" && CHAT_ID.test(value);
  const CHAT_DECISIONS: readonly ApprovalDecision[] = ["allow_once", "allow_always", "deny"];
  ipcMain.handle("chat:start", async (event, request: unknown) => {
    if (!isMainWindowSender(event) || typeof request !== "object" || request === null) return { ok: false, error: "invalid request" };
    const { terminalId, agent, cwd, sessionId } = request as Record<string, unknown>;
    if (!chatId(terminalId)) return { ok: false, error: "invalid terminal" };
    if (agent !== "claude" && agent !== "codex" && agent !== "opencode") return { ok: false, error: "this agent has no chat mode yet" };
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { ok: false, error: "the terminal's folder doesn't exist" };
    }
    if (sessionId !== null && sessionId !== undefined && !chatId(sessionId)) return { ok: false, error: "invalid session" };
    if (!telemetryService.getTerminalSnapshot(terminalId)) {
      telemetryService.registerTerminal({ terminalId, worktreePath: cwd, provider: agent as ChatAgent });
    }
    await chatEngine.start({ terminalId, agent: agent as ChatAgent, cwd, sessionId: (sessionId as string | null | undefined) ?? null });
    return { ok: true };
  });
  // A message names its files by the ids they got when attached; an unknown
  // one fails the send rather than going without it.
  ipcMain.handle("chat:send", (event, terminalId: unknown, text: unknown, attachmentIds: unknown) => {
    if (!isMainWindowSender(event) || !chatId(terminalId) || typeof text !== "string" || text.length > 200_000) return false;
    const attachments = chatAttachments.resolve(attachmentIds);
    if (!text.trim() && attachments.length === 0) return false;
    return chatEngine.send(terminalId, text, attachments);
  });
  // Attaching files: picked in the open dialog (starting in the chat's
  // folder), dropped on the message box, or a pasted image.
  chatAttachments.prune();
  const attachEach = async (items: unknown[], add: (item: unknown) => Promise<AttachmentInfo>) => {
    const attachments: AttachmentInfo[] = [];
    const errors: string[] = [];
    for (const item of items) {
      try {
        attachments.push(await add(item));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { attachments, errors };
  };
  ipcMain.handle("chat:attach-pick", async (event, terminalId: unknown) => {
    if (!isMainWindowSender(event) || !mainWindow) return { attachments: [], errors: [] };
    const cwd = chatId(terminalId) ? chatEngine.cwdOf(terminalId) : null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      ...(cwd ? { defaultPath: cwd } : {}),
    });
    if (result.canceled) return { attachments: [], errors: [] };
    return attachEach(result.filePaths.slice(0, 20), (p) => chatAttachments.addPath(p));
  });
  ipcMain.handle("chat:attach-paths", (event, paths: unknown) => {
    if (!isMainWindowSender(event) || !Array.isArray(paths)) return { attachments: [], errors: [] };
    return attachEach(paths.slice(0, 20), (p) => chatAttachments.addPath(p));
  });
  ipcMain.handle("chat:attach-image", (event, name: unknown, bytes: unknown) => {
    if (!isMainWindowSender(event)) return { attachments: [], errors: [] };
    return attachEach([bytes], (b) => chatAttachments.addImage(name, b));
  });
  // Opens an attached file in the Mac's Quick Look (PDFs, slides,
  // documents); elsewhere, in the app the system picks for it.
  ipcMain.handle("chat:quick-look", async (event, id: unknown) => {
    if (!isMainWindowSender(event) || !mainWindow) return;
    const held = chatAttachments.get(id);
    if (!held) throw new Error("that file is no longer available");
    if (process.platform === "darwin") mainWindow.previewFile(held.path, held.name);
    else {
      const failed = await shell.openPath(held.path);
      if (failed) throw new Error(failed);
    }
  });
  ipcMain.handle("chat:interrupt", (event, terminalId: unknown) => {
    if (isMainWindowSender(event) && chatId(terminalId)) chatEngine.interrupt(terminalId);
  });
  // A deny can carry what the person said (keeping on planning: what to change).
  ipcMain.handle("chat:answer", (event, terminalId: unknown, requestId: unknown, decision: unknown, note: unknown) => {
    if (!isMainWindowSender(event) || !chatId(terminalId) || typeof requestId !== "string" || requestId.length > 256) return;
    if (!CHAT_DECISIONS.includes(decision as ApprovalDecision)) return;
    if (note !== undefined && (typeof note !== "string" || note.length > 20_000)) return;
    chatEngine.answer(terminalId, requestId, decision as ApprovalDecision, note);
  });
  // The person's answers to the agent's questions: ids and texts, bounded.
  ipcMain.handle("chat:answer-question", (event, terminalId: unknown, requestId: unknown, answers: unknown) => {
    if (!isMainWindowSender(event) || !chatId(terminalId) || typeof requestId !== "string" || requestId.length > 256) return;
    if (answers === null) return chatEngine.answerQuestion(terminalId, requestId, null);
    if (typeof answers !== "object" || answers === undefined || Array.isArray(answers)) return;
    const entries = Object.entries(answers as Record<string, unknown>);
    if (entries.length > 12) return;
    const clean: Record<string, string[]> = {};
    for (const [id, picked] of entries) {
      if (id.length > 1000 || !Array.isArray(picked) || picked.length > 20) return;
      if (!picked.every((a) => typeof a === "string" && a.length <= 4000)) return;
      clean[id] = picked as string[];
    }
    chatEngine.answerQuestion(terminalId, requestId, clean);
  });
  // The model, effort or mode picked in the chat: short names only.
  ipcMain.handle("chat:configure", (event, terminalId: unknown, settings: unknown) => {
    if (!isMainWindowSender(event) || !chatId(terminalId)) return;
    const change = chatSettingsChange(settings);
    if (!change) {
      dbg(`[chat] settings change for ${terminalId} refused: ${JSON.stringify(settings).slice(0, 200)}`);
      return;
    }
    chatEngine.configure(terminalId, change);
  });
  ipcMain.handle("chat:stop", (event, terminalId: unknown) => {
    if (isMainWindowSender(event) && chatId(terminalId)) chatEngine.stop(terminalId);
  });
  // The manager's terminal was closed: its chat agent goes with it.
  ipcMain.handle("chat:forget", (event, terminalId: unknown) => {
    if (isMainWindowSender(event) && chatId(terminalId)) chatEngine.forget(terminalId);
  });
  ipcMain.handle("chat:snapshot", (event, terminalId: unknown) => {
    if (!isMainWindowSender(event) || !chatId(terminalId)) return { running: false, sessionId: null, events: [] };
    return { running: chatEngine.isRunning(terminalId), sessionId: chatEngine.sessionIdOf(terminalId), events: chatEngine.snapshot(terminalId) };
  });

  // Handoffs (SHR-62): the canvas says where focus is and when a node
  // copied or a terminal was pasted into; main reads the clipboard itself,
  // so the renderer never hands over text, and only a fingerprint is kept.
  const NODE_REF = /^(terminal|browser|note):[A-Za-z0-9._-]{1,128}$/;
  const TERMINAL_ID = /^[A-Za-z0-9._-]{1,128}$/;
  const agentTerminal = (terminalId: unknown): terminalId is string =>
    typeof terminalId === "string" && TERMINAL_ID.test(terminalId) && isAgentHarness(recordNodes.harnessOf(`terminal:${terminalId}`));
  const recordHandoff = (event: CaptureEvent, eventId: string, inputRefs: CaptureReference[]) => {
    if (event.kind !== "handoff") return;
    captureService.record(event, captureCanvasId, new Date(), {
      method: "renderer",
      eventId,
      inputRefs,
      outputRefs: [{ ref: event.to, kind: "node" }],
    });
  };
  const sourceRefs = (from: string): CaptureReference[] =>
    NODE_REF.test(from) ? [{ ref: from, kind: "node" }] : [];
  ipcMain.handle("handoff:focus", (event, node: unknown) => {
    if (!handoffs || !isMainWindowSender(event)) return;
    if (node !== null && (typeof node !== "string" || !NODE_REF.test(node))) return;
    handoffs.nodeFocusChanged(node, clipboardText());
  });
  ipcMain.handle("handoff:copied", (event, node: unknown) => {
    if (!handoffs || !isMainWindowSender(event)) return;
    if (typeof node !== "string" || !NODE_REF.test(node)) return;
    handoffs.copied(node, clipboardText());
  });
  ipcMain.handle("handoff:pasted", (event, terminalId: unknown) => {
    if (!handoffs || !isMainWindowSender(event) || !agentTerminal(terminalId)) return;
    const handoff = handoffs.pasted(`terminal:${terminalId}`, clipboardText());
    if (handoff?.event.kind === "handoff") recordHandoff(handoff.event, handoff.eventId, sourceRefs(handoff.event.from));
  });
  ipcMain.handle("handoff:dropped-files", async (event, terminalId: unknown, paths: unknown, fromFilesPanel: unknown) => {
    if (!handoffKey || !isMainWindowSender(event) || !agentTerminal(terminalId)) return;
    if (!Array.isArray(paths) || paths.length === 0) return;
    const files = paths
      .filter((entry): entry is string => typeof entry === "string" && entry.length < 4096 && path.isAbsolute(entry))
      .slice(0, MAX_DROPPED_FILES);
    if (files.length === 0) return;
    const projectRoot = telemetryService.getTerminalSnapshot(terminalId)?.worktree_path ?? null;
    const described = await Promise.all(
      files.map((file) => describeDroppedFile(file, { key: handoffKey!, projectRoot, home: os.homedir() })),
    );
    const handoffEvent = fileDropEvent(described, `terminal:${terminalId}`, fromFilesPanel === true);
    recordHandoff(handoffEvent, randomUUID(), described.map((file) => ({ ref: file.path, kind: "file" as const })));
  });

  ipcMain.on(
    "manager-role:set",
    (
      _event,
      input: {
        terminalId: string;
        cli: string | null;
        canvasId: string | null;
        sessionId?: string | null;
        sessionFile?: string | null;
      } | null,
    ) => {
      managerRoleLog.setRole(input);
    },
  );

  ipcMain.handle("manager-role:list-sessions", () =>
    managerRoleLog.listSessions(),
  );

  ipcMain.handle("manager-role:get-current", () => managerRoleLog.getCurrent());

  /**
   * A message the user typed in the Project Chat panel.
   *
   * Deliberately not the `browser:notify-wired` channel, even though the
   * plumbing is identical: that one is paste-only on purpose, because it
   * carries notices the app decided to send. This carries something the user
   * wrote and pressed Enter on, so it submits. Two channels rather than a flag
   * keeps a future edit from silently making notices auto-send again.
   */
  ipcMain.handle(
    "manager-chat:send",
    async (
      _event,
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: ComposerSupportedTerminalType;
        worktreePath: string;
      },
      message: string,
    ) => {
      if (!ptyManager.getPid(target.ptyId)) {
        return {
          ok: false,
          code: "target-not-running" as const,
          stage: "target" as const,
          error: "The workdesk manager's terminal is not running.",
          detail: "The workdesk manager's terminal is not running.",
        };
      }

      try {
        return await submitComposerRequest(
          {
            terminalId: target.terminalId,
            ptyId: target.ptyId,
            terminalType: target.terminalType,
            worktreePath: target.worktreePath,
            text: message,
            images: [],
            submit: true,
          },
          createDefaultComposerSubmitDeps(
            process.platform as "darwin" | "win32" | "linux",
            dataUrlToPngBuffer,
            (ptyId: number, data: string) => {
              ptyManager.write(ptyId, data);
            },
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[ProjectChat] send crashed:", {
          terminalId: target.terminalId,
          detail,
        });
        return {
          ok: false,
          code: "internal-error" as const,
          stage: "submit" as const,
          error: detail,
          detail,
        };
      }
    },
  );

  ipcMain.handle("hook:get-socket-path", () => hookSocketPath);
  ipcMain.handle("hook:get-health", () => hookReceiver.getHealth());

  // Only the app's own window, and only an agent's session record: the path
  // comes from the renderer, so it can't name any other file.
  ipcMain.handle("sessions:load-replay", async (event, filePath: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("sessions:load-replay is only for the app's window");
    if (!isSessionFile(filePath, os.homedir())) throw new Error("Not an agent session file");
    return sessionScanner.loadReplay(filePath);
  });

  ipcMain.handle(
    "sessions:fork",
    async (
      event,
      sourceFilePath: unknown,
      turnIndex: unknown,
      targetProvider?: unknown,
    ) => {
      if (!isMainWindowSender(event)) throw new Error("sessions:fork is only for the app's window");
      if (!isSessionFile(sourceFilePath, os.homedir())) throw new Error("Not an agent session file");
      if (typeof turnIndex !== "number" || !Number.isInteger(turnIndex) || turnIndex < 0) throw new Error("Invalid turn");
      if (targetProvider !== undefined && targetProvider !== "claude" && targetProvider !== "codex") throw new Error("Invalid provider");
      const { forkSession } = await import("./session-fork.js");
      return forkSession(sourceFilePath, turnIndex, targetProvider);
    },
  );

  ipcMain.handle("state:load", () => {
    return statePersistence.load();
  });

  ipcMain.handle("state:save", (_event, state: unknown) => {
    statePersistence.save(state);
  });

  ipcMain.handle("snapshots:list", () => {
    return snapshotHistory.list();
  });

  ipcMain.handle("snapshots:read", (_event, id: string) => {
    return snapshotHistory.read(id);
  });

  ipcMain.handle(
    "snapshots:append",
    (
      _event,
      args: {
        savedAt: number;
        terminalCount: number;
        projectCount: number;
        label?: string;
        body: unknown;
      },
    ) => {
      return snapshotHistory.append(args);
    },
  );

  ipcMain.handle("memory:scan", async (_event, worktreePath: string) => {
    const { getMemoryDirForWorktree, scanMemoryDir } =
      await import("./memory-service.js");
    const memDir = getMemoryDirForWorktree(worktreePath);
    return scanMemoryDir(memDir);
  });

  ipcMain.handle("memory:watch", async (_event, worktreePath: string) => {
    const { getMemoryDirForWorktree, watchMemoryDir, scanMemoryDir } =
      await import("./memory-service.js");
    const { generateEnhancedIndex, MemoryIndexCache } =
      await import("./memory-index-generator.js");
    const memDir = getMemoryDirForWorktree(worktreePath);
    const cache = new MemoryIndexCache(TACIT_DIR);

    const initialGraph = scanMemoryDir(memDir);
    cache.update(generateEnhancedIndex(initialGraph.nodes));

    watchMemoryDir(memDir, () => {
      try {
        const graph = scanMemoryDir(memDir);
        sendToWindow(mainWindow, "memory:changed", graph);
        cache.update(generateEnhancedIndex(graph.nodes));
      } catch {}
    });
  });

  ipcMain.handle("memory:unwatch", async (_event, worktreePath: string) => {
    const { getMemoryDirForWorktree, unwatchMemoryDir } =
      await import("./memory-service.js");
    const memDir = getMemoryDirForWorktree(worktreePath);
    unwatchMemoryDir(memDir);
  });

  // Parallel to the memory:scan/watch/unwatch trio above, but for the
  // workspace-manager's own continuity journal (see
  // docs/workspace_project_manager.md) — a canvas-wide scope, not tied to
  // any one worktree. Kept as separate channels rather than overloading
  // the existing ones so no existing call site needs to change.
  ipcMain.handle("memory:scanWorkspace", async (_event, canvasId: string) => {
    const { getMemoryDirForWorkspace, scanMemoryDir } =
      await import("./memory-service.js");
    const memDir = getMemoryDirForWorkspace(canvasId);
    return scanMemoryDir(memDir);
  });

  ipcMain.handle("memory:watchWorkspace", async (_event, canvasId: string) => {
    const { getMemoryDirForWorkspace, watchMemoryDir, scanMemoryDir } =
      await import("./memory-service.js");
    const { generateEnhancedIndex, MemoryIndexCache } =
      await import("./memory-index-generator.js");
    const memDir = getMemoryDirForWorkspace(canvasId);
    const cache = new MemoryIndexCache(TACIT_DIR);

    const initialGraph = scanMemoryDir(memDir);
    cache.update(generateEnhancedIndex(initialGraph.nodes));

    watchMemoryDir(memDir, () => {
      try {
        const graph = scanMemoryDir(memDir);
        sendToWindow(mainWindow, "memory:changed", graph);
        cache.update(generateEnhancedIndex(graph.nodes));
      } catch {}
    });
  });

  ipcMain.handle(
    "memory:unwatchWorkspace",
    async (_event, canvasId: string) => {
      const { getMemoryDirForWorkspace, unwatchMemoryDir } =
        await import("./memory-service.js");
      const memDir = getMemoryDirForWorkspace(canvasId);
      unwatchMemoryDir(memDir);
    },
  );

  /**
   * The decision record, for the Activity tab.
   *
   * Until now the record was written by the renderer and read only by agents,
   * over the HTTP API that backs the `recall` tool — so the app could answer
   * "what happened here" for a model and not for the person sitting in front
   * of it. This is the missing direction.
   */
  // Which agent CLIs are installed, for the dock and the manager roster.
  // Overrides are the commands set in Settings, which is what a launch uses.
  ipcMain.handle(
    "agents:detect",
    async (
      _event,
      options: { commandOverrides?: Record<string, string>; refresh?: boolean } = {},
    ) => {
      const results = await detectAgents(
        options.commandOverrides ?? {},
        options.refresh === true,
        // What an agent launch adds to PATH; see getTerminalExtraPathEntries.
        [getCliDir()],
      );
      dbg(
        `agents:detect ${results
          .map((r) => `${r.id}=${r.installed ? r.version ?? "unknown-version" : "missing"}`)
          .join(" ")}`,
      );
      return results;
    },
  );

  ipcMain.handle(
    "record:list",
    async (
      _event,
      options: { limit?: number; canvasId?: string | null } = {},
    ) => recallService.listRecord(options),
  );

  ipcMain.handle("workspace:save", async (_event, data: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save Workdesk",
      defaultPath: "workdesk.tacit",
      filters: [{ name: "Tacit Workdesk", extensions: ["tacit"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const filePath = workspaceSavePaths.register(result.filePath);
    fs.writeFileSync(filePath, data, "utf-8");
    return filePath;
  });

  ipcMain.handle(
    "workspace:save-to-path",
    (_event, filePath: string, data: string) => {
      fs.writeFileSync(workspaceSavePaths.assertAllowed(filePath), data, "utf-8");
    },
  );

  ipcMain.handle("workspace:set-title", (_event, title: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title);
    }
  });

  ipcMain.handle("workspace:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Open Workdesk",
      filters: [{ name: "Tacit Workdesk", extensions: ["tacit"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return fs.readFileSync(result.filePaths[0], "utf-8");
  });

  // Lets the user pick a local image as the canvas background (Settings >
  // Appearance). The file is copied into a managed directory rather than
  // referenced by its original path — so it survives the source file being
  // moved/deleted, and (like pin attachments) is servable through the
  // already-proven tc-attachment:// protocol rather than a raw file:// URL,
  // which this app's CSP blocks for other local resources (see the font
  // load warnings this same restriction produces elsewhere).
  ipcMain.handle("canvas:pick-background-image", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose Canvas Background",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    const backgroundsDir = path.join(TACIT_DIR, "canvas-backgrounds");
    fs.mkdirSync(backgroundsDir, { recursive: true });
    const destPath = path.join(backgroundsDir, `${randomUUID()}${ext}`);
    fs.copyFileSync(sourcePath, destPath);

    // Match pin-store.ts's populateAttachmentsUrl exactly: pathToFileURL's
    // pathname is already correctly percent-encoded per-segment (spaces,
    // unicode, etc.) without touching the "/" separators the way a blind
    // encodeURIComponent(destPath) would — that would double-encode the
    // path's own slashes and corrupt it once the protocol handler runs
    // decodeURIComponent on the other end.
    const fileUrl = pathToFileURL(destPath);
    return `tc-attachment://local${fileUrl.pathname}`;
  });

  ipcMain.handle(
    "browser-identity:clear-data",
    async (_event, identityId: unknown) => {
      const partitionName = resolveIdentityClearPartition(identityId);
      // Non-null: resolveIdentityClearPartition has already refused anything
      // that is not a valid identity partition.
      const validIdentityId = identityIdFromPartition(partitionName)!;
      await eraseIdentitySessionData(validIdentityId);
      // Only after the clear succeeds. A directory removed while its data is
      // still live would be the one failure worse than the orphan: the profile
      // gone from the list with its cookies still on disk.
      const directory = browserPartitionStore.erase(validIdentityId);
      return { identityId: validIdentityId, directory };
    },
  );

  ipcMain.handle(
    "browser-partition:list-orphans",
    (_event, input: unknown) =>
      browserPartitionStore.listOrphans(
        validateOrphanPartitionDiffRequest(input).identityIds,
      ),
  );

  ipcMain.handle("browser-partition:erase", (_event, input: unknown) => {
    // No session is touched here. An orphan has no profile, so nothing has
    // opened it this run, and resolving its session would recreate the very
    // directory this is removing.
    const { identityId } = validateOrphanPartitionEraseRequest(input);
    return { identityId, directory: browserPartitionStore.erase(identityId) };
  });

  ipcMain.handle("browser-profile-import:list", () =>
    discoverChromeProfiles(),
  );

  // What the browser sensor has written, and the way to erase it. Counts and
  // bytes only cross this boundary — describing the stream never means handing
  // its contents back to a renderer.
  ipcMain.handle("browser-observations:summary", () =>
    observationStoreForManagement().summary(),
  );

  ipcMain.handle("browser-observations:clear", (_event, input: unknown) => {
    const identityId =
      input && typeof input === "object"
        ? (input as Record<string, unknown>).identityId
        : undefined;
    if (identityId === undefined || identityId === null) {
      return observationStoreForManagement().clear();
    }
    // Validated against the same rule the rest of the app uses before it can
    // name a file to delete, even though the store re-checks it too.
    if (!isValidBrowserIdentityId(identityId)) {
      throw new Error("Refused to erase activity for an invalid profile id");
    }
    return observationStoreForManagement().clear(identityId);
  });

  ipcMain.handle(
    "browser-profile-import:chrome",
    async (
      _event,
      input: unknown,
    ) => {
      const request = validateChromeProfileImportRequest(input);
      return importChromeProfilesAsIdentities(request.profileIds, request.existingIdentityNames, {
        fromPartition: (partitionName) => session.fromPartition(partitionName),
        registerPartition: (identityId, label) =>
          browserPartitionStore.register(identityId, { origin: "import", label }),
        // The partition directory is named here rather than inside the import,
        // so the one path builder that is allowed to turn an identity id into a
        // directory stays the one in the partition store.
        stageSiteStorage: ({ profileId, identityId }) =>
          stageChromeLocalStorage(
            path.join(defaultChromeRoot(), profileId),
            resolvePartitionDirectory(browserPartitionStore.partitionsRoot, identityId),
          ),
        reapPartition: (identityId) =>
          browserPartitionStore.erase(identityId) !== "pending",
        diagnostic: (event) => console.warn("[browser-profile-import]", event),
      });
    },
  );

  // Sync from Chrome (SHR-132): the button, and the automatic syncs the
  // renderer starts. The renderer names its imported profiles and where each
  // came from; one sync runs at a time, and a second waits for the first.
  let chromeSyncQueue: Promise<unknown> = Promise.resolve();
  ipcMain.handle("browser-profile-sync:chrome", (event, input: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("Only Tacit's window can sync profiles");
    const requests = readChromeSyncRequests(input);
    const run = chromeSyncQueue.then(() =>
      syncChromeProfiles(requests, {
        fromPartition: (partitionName) => {
          const target = session.fromPartition(partitionName);
          return {
            cookies: target.cookies,
            flushStorageData: async () => target.flushStorageData(),
          };
        },
      }),
    );
    chromeSyncQueue = run.catch(() => undefined);
    return run;
  });

  // When to sync without being asked: when the Mac wakes (after a pause, so
  // Chrome has refreshed its own sign-ins first) and every few hours while
  // Tacit stays open. Tacit's start is the renderer's, once its profiles load.
  const chromeSyncDue = (due: ChromeSyncDue) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser-profile-sync:due", due);
  };

  // The renderer reports its imported profiles whenever they change.
  ipcMain.handle("browser-profile-sync:sources", (event, input: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("Only Tacit's window can name profile sources");
    const sources = readChromeSyncSources(input);
    chromeSourceByIdentity.clear();
    for (const { identityId, sourceProfileId } of sources) chromeSourceByIdentity.set(identityId, sourceProfileId);
    chromeLoginWatch ??= new ChromeLoginWatch({
      onNewLogin: (sourceProfileId, identityIds) => {
        console.info(`[chrome-login-watch] new login in Chrome ${sourceProfileId}; syncing ${identityIds.length} profile(s)`);
        chromeSyncDue({ reason: "chrome-login", identityIds });
      },
      log: (message) => console.warn(message),
    });
    chromeLoginWatch.setSources(sources);
    console.info(`[chrome-login-watch] watching ${new Set(sources.map((s) => s.sourceProfileId)).size} Chrome profile(s) for ${sources.length} imported profile(s)`);
  });
  let wakeSync: ReturnType<typeof setTimeout> | null = null;
  powerMonitor.on("resume", () => {
    if (wakeSync) clearTimeout(wakeSync);
    wakeSync = setTimeout(() => { wakeSync = null; chromeSyncDue({ reason: "wake" }); }, 90_000);
  });
  setInterval(() => chromeSyncDue({ reason: "timer" }), CHROME_AUTO_SYNC_EVERY_MS).unref();

  ipcMain.handle("browser-connect:begin-pairing", () => {
    if (!desktopApiPort) {
      throw new Error("Tacit browser connector is not ready yet");
    }
    return {
      endpoint: `http://127.0.0.1:${desktopApiPort}`,
      ...browserConnectionRegistry.beginPairing(),
    };
  });

  ipcMain.handle("browser-connect:list-tabs", () =>
    browserConnectionRegistry.listAuthorizedTabsForApp(),
  );

  ipcMain.handle("browser-connect:open-extension-folder", async () => {
    const extensionDir = app.isPackaged
      ? path.join(process.resourcesPath, "browser-extension")
      : path.join(app.getAppPath(), "browser-extension");
    if (!fs.existsSync(path.join(extensionDir, "manifest.json"))) {
      throw new Error("Tacit browser extension is missing from this build");
    }
    const error = await shell.openPath(extensionDir);
    if (error) throw new Error(error);
    return extensionDir;
  });

  ipcMain.handle(
    "browser-connect:execute",
    async (
      _event,
      input: {
        bindingId: string;
        action: import("../shared/browser-controller").BrowserActionName;
        params: Record<string, unknown>;
      },
    ) => connectedBrowserBroker.execute(
      input.bindingId,
      input.action,
      input.params,
    ),
  );

  const IMAGE_EXTS_FS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".bmp",
    ".ico",
    ".avif",
    ".apng",
  ]);
  const MIME_MAP_FS: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".apng": "image/apng",
  };
  // 512 KB is fine for text files but tiny for images — a typical
  // screenshot is 1-2 MB and GIFs easily hit 5-10 MB. Use a separate
  // larger cap for images so clicking an image in the file tree
  // isn't silently blocked most of the time.
  const MAX_FILE_SIZE = 512 * 1024;
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

  // One folder of a project the Files panel loads a folder at a time. A
  // folder it can't read (macOS privacy protection, permissions) comes back
  // as the reason, so the panel can say so instead of showing it empty.
  ipcMain.handle("fs:list-dir", async (event, dirPath: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("fs:list-dir: not the app window");
    if (typeof dirPath !== "string" || !path.isAbsolute(dirPath)) {
      throw new Error("fs:list-dir: expected an absolute folder path");
    }
    try {
      return { entries: await listDirectory(dirPath) };
    } catch (err) {
      return { error: describeFsError(err) };
    }
  });

  ipcMain.handle("fs:read-file", (_event, filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const isImage = IMAGE_EXTS_FS.has(ext);
      // Image files get a 10-MB ceiling since a 5-MB GIF or
      // 2-MB screenshot is perfectly normal and rejecting those
      // just makes the editor look broken. Text keeps the tight
      // 512-KB cap.
      const ceiling = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
      if (stat.size > ceiling) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return { error: "too-large", size: `${sizeMB} MB` };
      }

      if (isImage) {
        const buf = fs.readFileSync(filePath);
        const mime = MIME_MAP_FS[ext] ?? "image/png";
        return {
          type: "image",
          content: `data:${mime};base64,${buf.toString("base64")}`,
        };
      }

      const fd = fs.openSync(filePath, "r");
      const probe = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, probe, 0, 8192, 0);
      fs.closeSync(fd);
      if (probe.subarray(0, bytesRead).includes(0)) {
        return { type: "binary" };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const type = ext === ".md" ? "markdown" : "text";
      return { type, content };
    } catch {
      return { error: "read-error" };
    }
  });

  ipcMain.handle(
    "fs:write-file",
    (_event, filePath: string, content: string) => {
      try {
        const existing = fs.readFileSync(filePath, "utf-8");
        if (existing === content) return { changed: false };
      } catch {}
      fs.writeFileSync(filePath, content, "utf-8");
      return { changed: true };
    },
  );

  ipcMain.handle(
    "fs:copy",
    async (_event, sources: string[], destDir: string) => {
      const { copyFiles } = await import("./fs-copy.js");
      return copyFiles(sources, destDir);
    },
  );

  ipcMain.handle("fs:rename", (_event, oldPath: string, newName: string) => {
    const basename = path.basename(newName);
    if (basename !== newName || !newName) throw new Error("Invalid name");
    const newPath = path.join(path.dirname(oldPath), newName);
    fs.renameSync(oldPath, newPath);
  });

  ipcMain.handle("fs:move", (_event, oldPath: string, newPath: string) => {
    if (!oldPath || !newPath) throw new Error("Invalid path");
    if (fs.existsSync(newPath)) throw new Error("Destination already exists");
    fs.renameSync(oldPath, newPath);
  });

  ipcMain.handle("fs:delete", (_event, targetPath: string) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
  });

  ipcMain.handle("fs:mkdir", (_event, dirPath: string, name: string) => {
    const basename = path.basename(name);
    if (basename !== name || !name) throw new Error("Invalid name");
    fs.mkdirSync(path.join(dirPath, name), { recursive: true });
  });

  ipcMain.handle("fs:create-file", (_event, dirPath: string, name: string) => {
    const basename = path.basename(name);
    if (basename !== name || !name) throw new Error("Invalid name");
    const filePath = path.join(dirPath, name);
    if (fs.existsSync(filePath)) throw new Error("File already exists");
    fs.writeFileSync(filePath, "", "utf-8");
  });

  ipcMain.handle("fs:reveal", (_event, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  // A git project's tree is watched whole; a project loaded a folder at a
  // time watches only the folders it has loaded, one level each. Main
  // decides whether a watch starts (see MAX_FOLDER_WATCHES) and says so.
  ipcMain.handle("fs:watch-dir", (event, dirPath: unknown, recursive: unknown) => {
    if (!isMainWindowSender(event)) return;
    if (typeof dirPath !== "string" || !path.isAbsolute(dirPath) || typeof recursive !== "boolean") {
      throw new Error("fs:watch-dir takes an absolute folder path and whether to watch it whole");
    }
    return fileTreeWatcher.watch(dirPath, recursive);
  });
  ipcMain.handle("fs:unwatch-dir", (event, dirPath: unknown, recursive: unknown) => {
    if (!isMainWindowSender(event)) return;
    if (typeof dirPath !== "string" || typeof recursive !== "boolean") {
      throw new Error("fs:unwatch-dir takes a folder path and whether it was watched whole");
    }
    fileTreeWatcher.unwatch(dirPath, recursive);
  });
  ipcMain.handle("fs:unwatch-all-dirs", (event) => {
    if (!isMainWindowSender(event)) return;
    fileTreeWatcher.unwatchAll();
  });

  ipcMain.handle("fs:list-all-files", async (event, dirPath: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("fs:list-all-files: not the app window");
    if (typeof dirPath !== "string" || !path.isAbsolute(dirPath)) {
      throw new Error("fs:list-all-files: expected an absolute folder path");
    }
    return await listWorktreeFiles(dirPath);
  });

  ipcMain.handle("fs:list-ignored-files", async (_event, dirPath: string) => {
    const { execFile } = await import("child_process");
    const runGit = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          args,
          { cwd: dirPath, timeout: 10000, maxBuffer: 64 * 1024 * 1024 },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
      });
    try {
      const [filesOutput, dirsOutput] = await Promise.all([
        runGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]),
        runGit([
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
        ]),
      ]);
      return [
        ...new Set([
          ...parseNulSeparatedGitPaths(dirsOutput),
          ...parseNulSeparatedGitPaths(filesOutput),
        ]),
      ];
    } catch (err) {
      console.warn(`[fs:list-ignored-files] failed:`, err);
      return [] as string[];
    }
  });

  ipcMain.handle("cli:is-registered", () => isCliRegistered(getCliDir()));
  ipcMain.handle("cli:register", () => {
    const cliOk = registerCli(getCliDir());
    if (!cliOk) {
      return { ok: false, skillInstalled: false };
    }
    writeCliIntegrationState({ autoRegister: true });
    const skillInstalled = installSkill();
    return { ok: true, skillInstalled };
  });
  ipcMain.handle("cli:unregister", () => {
    const ok = unregisterCli(getCliDir());
    if (ok) {
      writeCliIntegrationState({ autoRegister: false });
    }
    return ok;
  });

  ipcMain.handle(
    "cli:validate-command",
    async (_event, command: string, _args?: string[]) => {
      // The same lookup the dock's agent detection and a real launch use
      // (electron/agent-detect.ts), so Settings can't disagree with either.
      try {
        const located = await locateCommand(command, [getCliDir()]);
        if (!located) {
          return {
            ok: false as const,
            error: `Executable not found: ${command}`,
          };
        }
        const version = await runVersion(
          located.path,
          [...located.prefixArgs, "--version"],
          located.env,
        )
          .then((output) => output.trim().split("\n")[0] || null)
          .catch(() => null);
        return { ok: true as const, resolvedPath: located.path, version };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "composer:submit",
    async (_event, request: ComposerSubmitRequest) => {
      if (!ptyManager.getPid(request.ptyId)) {
        return {
          ok: false,
          code: "target-not-running",
          stage: "target",
          error: "Target terminal is not running.",
        };
      }

      try {
        const result = await submitComposerRequest(
          request,
          createDefaultComposerSubmitDeps(
            process.platform as "darwin" | "win32" | "linux",
            dataUrlToPngBuffer,
            (ptyId: number, data: string) => {
              ptyManager.write(ptyId, data);
            },
          ),
        );

        if (!result.ok) {
          console.error("[Composer] Submit failed:", {
            terminalId: request.terminalId,
            ptyId: request.ptyId,
            terminalType: request.terminalType,
            stage: result.stage,
            code: result.code,
            detail: result.detail ?? result.error,
            requestId: result.requestId,
          });
        }

        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[Composer] Submit crashed:", {
          terminalId: request.terminalId,
          ptyId: request.ptyId,
          terminalType: request.terminalType,
          detail,
        });
        return {
          ok: false,
          code: "internal-error",
          stage: "submit",
          error: detail,
          detail,
        };
      }
    },
  );

  ipcMain.handle("usage:query", async (_event, dateStr: string) => {
    const startedAt = Date.now();
    const result = await collectUsage(dateStr);
    perfLog("usage:query", {
      dateStr,
      ms: Date.now() - startedAt,
      sessions: result.sessions,
      totalCost: result.totalCost,
    });
    return result;
  });

  ipcMain.handle(
    "usage:query-range",
    async (_event, startDate: string, endDate: string) => {
      const startedAt = Date.now();
      const result = await collectUsageRange(startDate, endDate);
      perfLog("usage:query-range", {
        startDate,
        endDate,
        ms: Date.now() - startedAt,
        sessions: result.sessions,
        totalCost: result.totalCost,
      });
      return result;
    },
  );

  ipcMain.handle("usage:heatmap", async () => {
    const startedAt = Date.now();
    const result = await collectHeatmapData();
    perfLog("usage:heatmap", {
      ms: Date.now() - startedAt,
      days: Object.keys(result).length,
    });
    return result;
  });

  ipcMain.handle("usage:query-cloud", async (_event, dateStr: string) => {
    return await queryCloudUsage(dateStr);
  });

  ipcMain.handle(
    "usage:query-range-cloud",
    async (_event, startDate: string, endDate: string) => {
      return await queryCloudUsageRange(startDate, endDate);
    },
  );

  ipcMain.handle("usage:heatmap-cloud", async () => {
    return await queryCloudHeatmap();
  });

  ipcMain.handle("quota:fetch", async () => {
    const { fetchQuota } = await import("./quota-fetcher");
    const startedAt = Date.now();
    const result = await fetchQuota();
    perfLog("quota:fetch", {
      ms: Date.now() - startedAt,
      ok: result.ok,
      rateLimited: result.ok ? false : result.rateLimited,
    });
    return result;
  });

  ipcMain.handle("codex-quota:fetch", async () => {
    const { fetchCodexQuota } = await import("./codex-quota-fetcher");
    const startedAt = Date.now();
    const result = await fetchCodexQuota();
    perfLog("codex-quota:fetch", {
      ms: Date.now() - startedAt,
      ok: result.ok,
      rateLimited: result.ok ? false : result.rateLimited,
    });
    return result;
  });

  ipcMain.handle(
    "summary:generate",
    async (
      _event,
      input: {
        terminalId: string;
        sessionId: string;
        sessionType: "claude" | "codex";
        cwd: string;
        summaryCli: "claude" | "codex";
      },
    ) => {
      const { generateSummary } = await import("./summary-service.js");
      return generateSummary(input);
    },
  );

  let activeInsightsJobId: string | null = null;
  ipcMain.handle(
    "insights:generate",
    async (_event, cliTool: "claude" | "codex", jobId: string) => {
      if (activeInsightsJobId && activeInsightsJobId !== jobId) {
        return {
          ok: false as const,
          jobId,
          error: {
            code: "job_in_progress",
            message: "Another insights job is already running",
          },
        };
      }

      activeInsightsJobId = jobId;
      try {
        const { generateInsights } = await import("./insights-engine");
        return await generateInsights(cliTool, jobId, (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("insights:progress", progress);
          }
        });
      } finally {
        if (activeInsightsJobId === jobId) {
          activeInsightsJobId = null;
        }
      }
    },
  );

  ipcMain.handle("insights:open-report", async (_event, filePath: string) => {
    await shell.openExternal(toFileUrl(filePath));
  });

  ipcMain.handle("insights:get-last-report", async () => {
    const reportsDir = path.join(TACIT_DIR, "insights-reports");
    try {
      if (!fs.existsSync(reportsDir)) return null;
      const files = fs
        .readdirSync(reportsDir)
        .filter((f) => f.startsWith("insights-") && f.endsWith(".html"));
      if (files.length === 0) return null;
      files.sort().reverse();
      const filePath = path.join(reportsDir, files[0]);
      if (!fs.existsSync(filePath)) return null;
      return filePath;
    } catch {
      return null;
    }
  });

  const fontsDir = path.join(app.getPath("userData"), "fonts");

  // Fonts are named by file, and only the registry's downloadable ones: the
  // renderer can't pick a path or a download URL. A font reaches the
  // renderer as bytes, since a file:// URL is a local resource its page
  // isn't allowed to load (SHR-93).
  ipcMain.handle("font:list-downloaded", (event) => {
    if (!isMainWindowSender(event)) throw new Error("font:list-downloaded is only for the app's window");
    try {
      if (!fs.existsSync(fontsDir)) return [];
      return fs.readdirSync(fontsDir).filter((name) => downloadableFont(name));
    } catch {
      return [];
    }
  });

  ipcMain.handle("font:read", async (event, fileName: unknown) => {
    if (!isMainWindowSender(event)) throw new Error("font:read is only for the app's window");
    const font = downloadableFont(fileName);
    if (!font) throw new Error("Not a Tacit font");
    const data = await fs.promises.readFile(path.join(fontsDir, font.fileName));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });

  ipcMain.handle(
    "font:download",
    async (event, fileName: unknown) => {
      if (!isMainWindowSender(event)) throw new Error("font:download is only for the app's window");
      const font = downloadableFont(fileName);
      if (!font) return { ok: false, error: "Not a Tacit font" };
      const url = font.url;
      if (!fs.existsSync(fontsDir)) {
        fs.mkdirSync(fontsDir, { recursive: true });
      }
      const destPath = path.join(fontsDir, font.fileName);
      if (fs.existsSync(destPath)) {
        return { ok: true };
      }

      try {
        const tmpZip = path.join(fontsDir, `_download_${Date.now()}.zip`);

        const buf = await new Promise<Buffer>((resolve, reject) => {
          const follow = (u: string, redirects = 0) => {
            if (redirects > 5) {
              reject(new Error("Too many redirects"));
              return;
            }
            https
              .get(u, (res) => {
                if (
                  (res.statusCode === 301 || res.statusCode === 302) &&
                  res.headers.location
                ) {
                  follow(res.headers.location, redirects + 1);
                  return;
                }
                if (res.statusCode !== 200) {
                  reject(new Error(`HTTP ${res.statusCode}`));
                  return;
                }
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
                res.on("error", reject);
              })
              .on("error", reject);
          };
          follow(url);
        });
        if (buf.length < 100) {
          return {
            ok: false,
            error: "Downloaded file is too small, likely not a valid archive",
          };
        }
        fs.writeFileSync(tmpZip, buf);

        const zip = new AdmZip(tmpZip);
        const zipEntries = zip.getEntries();
        const matchEntry = zipEntries.find((e) =>
          e.entryName.endsWith(font.fileName),
        );
        if (!matchEntry) {
          fs.unlinkSync(tmpZip);
          return {
            ok: false,
            error: `Font file "${font.fileName}" not found in archive`,
          };
        }
        fs.writeFileSync(destPath, matchEntry.getData());
        fs.unlinkSync(tmpZip);

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("auth:login", async () => {
    return login();
  });

  ipcMain.handle("auth:logout", async () => {
    await logout();
  });

  ipcMain.handle("auth:get-user", () => {
    return getAuthUser();
  });

  ipcMain.handle("auth:get-device-id", () => {
    return getDeviceId();
  });

  ipcMain.on("app:request-close", () => {
    if (mainWindow) {
      mainWindow.close();
    }
  });

  ipcMain.on("app:flush-before-quit-done", () => {
    resolvePendingFlush?.();
  });

  ipcMain.handle(
    "agent:send",
    async (
      _event,
      sessionId: string,
      text: string,
      config: {
        type: "anthropic" | "openai";
        baseURL: string;
        apiKey: string;
        model: string;
      },
    ) => {
      agentService.send(sessionId, text, config);
    },
  );

  ipcMain.handle("agent:abort", (_event, sessionId: string) => {
    agentService.abort(sessionId);
  });

  ipcMain.handle("agent:clear", (_event, sessionId: string) => {
    agentService.clearSession(sessionId);
  });

  ipcMain.handle("agent:delete", (_event, sessionId: string) => {
    agentService.deleteSession(sessionId);
  });

  ipcMain.handle(
    "agent:start",
    (_event, sessionId: string, config: AgentConfig) => {
      agentService.startClaudeCode(sessionId, config);
      const { getSlashCommandNames } =
        require("./slash-commands") as typeof import("./slash-commands");
      return { slashCommands: getSlashCommandNames(config.cwd) };
    },
  );

  ipcMain.handle(
    "agent:approve",
    (_event, sessionId: string, requestId: string) => {
      agentService.approve(sessionId, requestId);
    },
  );

  ipcMain.handle(
    "agent:deny",
    (_event, sessionId: string, requestId: string, reason?: string) => {
      agentService.deny(sessionId, requestId, reason);
    },
  );

  ipcMain.handle("secure:is-available", () =>
    safeStorage.isEncryptionAvailable(),
  );

  ipcMain.handle("secure:encrypt", (_event, plaintext: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage unavailable");
    }
    return safeStorage.encryptString(plaintext).toString("base64");
  });

  ipcMain.handle("secure:decrypt", (_event, base64: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage unavailable");
    }
    return safeStorage.decryptString(Buffer.from(base64, "base64"));
  });

  // Tasks and notes: only the app's own window, and the store checks each
  // field. Changes from here are the person's ("user") in a task's history.
  ipcMain.handle("pin:list", (event, repo: unknown) => {
    if (!isMainWindowSender(event) || typeof repo !== "string") return [];
    return taskStore.list(repo);
  });

  ipcMain.handle(
    "pin:create",
    (event, input: Parameters<typeof taskStore.create>[0]) => {
      if (!isMainWindowSender(event)) throw new Error("Not allowed");
      return taskStore.create(input, "user");
    },
  );

  ipcMain.handle(
    "pin:update",
    (
      event,
      repo: string,
      id: string,
      patch: Parameters<typeof taskStore.update>[2],
    ) => {
      if (!isMainWindowSender(event) || typeof repo !== "string" || typeof id !== "string") throw new Error("Not allowed");
      return taskStore.update(repo, id, patch, "user");
    },
  );

  ipcMain.handle("pin:remove", (event, repo: string, id: string) => {
    if (!isMainWindowSender(event) || typeof repo !== "string" || typeof id !== "string") throw new Error("Not allowed");
    taskStore.remove(repo, id);
  });

  ipcMain.handle("pin:open-preview", (_event, repo: string, id: string) => {
    openPinPreviewWindow(repo, id);
  });

  ipcMain.handle(
    "pin:save-attachment",
    (
      _event,
      repo: string,
      id: string,
      fileName: string,
      data: ArrayBuffer | Uint8Array,
    ) => {
      const buffer = Buffer.from(
        data instanceof Uint8Array ? data : new Uint8Array(data),
      );
      return taskStore.saveAttachment(repo, id, fileName, buffer);
    },
  );

  // Inject a pin's body + image attachments into a terminal via the existing
  // composer-submit pipeline. We deliberately do not mutate pin.status here:
  // dispatching the same pin to multiple terminals is a supported flow, and
  // status changes stay manual.
  ipcMain.handle(
    "pin:dispatch-to-terminal",
    async (
      _event,
      repo: string,
      pinId: string,
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: ComposerSupportedTerminalType;
        worktreePath: string;
      },
    ) => {
      const pin = taskStore.get(repo, pinId);
      if (!pin) {
        return {
          ok: false,
          code: "internal-error" as const,
          stage: "validate" as const,
          error: `Pin not found: ${pinId}`,
          detail: `Pin not found: ${pinId}`,
        };
      }

      if (!ptyManager.getPid(target.ptyId)) {
        return {
          ok: false,
          code: "target-not-running" as const,
          stage: "target" as const,
          error: "Target terminal is not running.",
          detail: "Target terminal is not running.",
        };
      }

      const { text, images } = await buildPinComposerPayload(
        pin,
        taskStore.attachmentsDir(repo, pinId),
      );

      // Paste-only — fill the agent's input buffer with the title + body
      // (and stage attachments) but leave submission to the user. They
      // review the prompt in context, edit if needed, and hit Enter
      // themselves.
      const request: ComposerSubmitRequest = {
        terminalId: target.terminalId,
        ptyId: target.ptyId,
        terminalType: target.terminalType,
        worktreePath: target.worktreePath,
        text,
        images,
        submit: false,
      };

      try {
        const result = await submitComposerRequest(
          request,
          createDefaultComposerSubmitDeps(
            process.platform as "darwin" | "win32" | "linux",
            dataUrlToPngBuffer,
            (ptyId: number, data: string) => {
              ptyManager.write(ptyId, data);
            },
          ),
        );

        if (result.ok && handoffs && agentTerminal(target.terminalId)) {
          const handoffEvent = pinDropEvent(pinId, `terminal:${target.terminalId}`);
          const eventId = randomUUID();
          recordHandoff(handoffEvent, eventId, [{ ref: `note:${pinId}`, kind: "node" }]);
          handoffs.awaitPrompt(`terminal:${target.terminalId}`, eventId, text);
        }

        if (!result.ok) {
          console.error("[Pin] Dispatch failed:", {
            pinId,
            terminalId: target.terminalId,
            ptyId: target.ptyId,
            terminalType: target.terminalType,
            stage: result.stage,
            code: result.code,
            detail: result.detail ?? result.error,
          });
        }

        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[Pin] Dispatch crashed:", {
          pinId,
          terminalId: target.terminalId,
          detail,
        });
        return {
          ok: false,
          code: "internal-error" as const,
          stage: "submit" as const,
          error: detail,
          detail,
        };
      }
    },
  );

  // Notifies a terminal that a browser tile has just been wired to it (see
  // src/canvas/ConnectionLayer.tsx's drag-to-connect +
  // src/actions/sceneConnectionActions.ts). Reuses the exact same
  // composer-submit pipeline as pin:dispatch-to-terminal — real injected
  // user-turn text, auto-submitted (unlike the pin flow, which pastes only)
  // so the agent picks it up on its own without the user pressing Enter.
  ipcMain.handle(
    "browser:notify-wired",
    async (
      _event,
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: ComposerSupportedTerminalType;
        worktreePath: string;
      },
      message: string,
    ) => {
      if (!ptyManager.getPid(target.ptyId)) {
        return {
          ok: false,
          code: "target-not-running" as const,
          stage: "target" as const,
          error: "Target terminal is not running.",
          detail: "Target terminal is not running.",
        };
      }

      // Remembered before writing so the prompt hook — which can fire before
      // this call even returns — recognises the text coming back as ours.
      injectedText.note(target.terminalId, message);

      const request: ComposerSubmitRequest = {
        terminalId: target.terminalId,
        ptyId: target.ptyId,
        terminalType: target.terminalType,
        worktreePath: target.worktreePath,
        text: message,
        images: [],
        // Paste-only, same convention as pin dispatch above: this is a
        // notice the app decided to send, not something the user asked for,
        // so it must never spend the agent's turn on its own. It waits in
        // the input until the user actually wants it sent. Agent-to-agent
        // handoff (emit_event, electron/api-server.ts) deliberately still
        // auto-submits — delegation is supposed to run unattended.
        submit: false,
      };

      try {
        const result = await submitComposerRequest(
          request,
          createDefaultComposerSubmitDeps(
            process.platform as "darwin" | "win32" | "linux",
            dataUrlToPngBuffer,
            (ptyId: number, data: string) => {
              ptyManager.write(ptyId, data);
            },
          ),
        );
        if (!result.ok) {
          console.error("[Browser] Wire notification failed:", {
            terminalId: target.terminalId,
            ptyId: target.ptyId,
            terminalType: target.terminalType,
            stage: result.stage,
            code: result.code,
            detail: result.detail ?? result.error,
          });
        }
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[Browser] Wire notification crashed:", {
          terminalId: target.terminalId,
          detail,
        });
        return {
          ok: false,
          code: "internal-error" as const,
          stage: "submit" as const,
          error: detail,
          detail,
        };
      }
    },
  );
}

function getCliDir(): string {
  const prodDir = path.join(process.resourcesPath, "cli");
  if (fs.existsSync(prodDir)) return prodDir;
  return path.resolve(__dirname, "..", "dist-cli");
}

function getTacitBridgeCliPath(): string | null {
  const prodPath = path.join(
    process.resourcesPath,
    "tacit-bridge",
    "tacit-bridge.js",
  );
  if (fs.existsSync(prodPath)) return prodPath;
  const devPath = path.resolve(
    __dirname,
    "..",
    "tacit-bridge",
    "dist",
    "tacit-bridge.js",
  );
  return fs.existsSync(devPath) ? devPath : null;
}

function dataUrlToPngBuffer(dataUrl: string): Buffer {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    throw new Error("Invalid image data.");
  }
  return image.toPNG();
}

const CLI_NAMES = ["tacit", "hydra", "browse"];
const AGENT_SHIM_NAMES = ["codex", "claude", "opencode", "gemini", "agy"];

function ensureCliLinks(): void {
  const cliDir = getCliDir();
  if (!fs.existsSync(cliDir)) return;

  for (const name of CLI_NAMES) {
    const jsFile = path.join(cliDir, `${name}.js`);
    try {
      ensureCliLauncher(jsFile);
    } catch {}
  }

  const shimDir = getAgentShimDir(cliDir);
  if (!fs.existsSync(shimDir)) return;
  for (const name of AGENT_SHIM_NAMES) {
    const jsFile = path.join(shimDir, `${name}.js`);
    try {
      ensureCliLauncher(jsFile);
    } catch {}
  }
}

function getSkillSourceDir(): string {
  return getSkillsSourceDir(process.resourcesPath, __dirname);
}

function installSkill(): boolean {
  return installSkillLinks({
    sourceDir: getSkillSourceDir(),
    appVersion: app.getVersion(),
  });
}

function ensureSkillInstalled(): boolean {
  return ensureSkillLinks({
    sourceDir: getSkillSourceDir(),
    appVersion: app.getVersion(),
  });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("tacit", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("tacit");
}

app.whenReady().then(async () => {
  // Before any terminal can open. If this fails, shell terminals start the
  // old way, and typing `claude` in one may miss its workspace tools.
  try {
    writeShellIntegrationFiles(SHELL_INTEGRATION_DIR);
  } catch (error) {
    fs.rmSync(SHELL_INTEGRATION_DIR, { recursive: true, force: true });
    console.error("[shell-integration] could not write startup files:", error);
    dbg(`shell-integration write failed: ${String(error)}`);
  }

  // A run left open by the last launch is resumed, or ended as idle.
  runTracker.restore();

  renderDiagnostics.recordMainEvent("app_ready", {
    app_version: app.getVersion(),
    isDev,
    platform: process.platform,
    user_data_path: app.getPath("userData"),
  });

  // Before any window exists, so nothing is holding a partition open: adopt
  // directories that predate the registry, drop entries whose directory is
  // gone, and collect removals the last run could not finish. The diff against
  // the workspace happens later, in the renderer, because the workspace is what
  // the renderer owns — and it only ever suggests.
  const partitionReport = browserPartitionStore.start();
  renderDiagnostics.recordMainEvent("browser_partitions_reconciled", { ...partitionReport });

  // Serve pin attachments and canvas background images from disk.
  // Path-traversal guard: resolved disk path must stay under one of these
  // roots. Renderer constructs URLs as tc-attachment://local/<abs-path>;
  // handler decodes pathname back to a real path and streams the file via
  // Electron's net.fetch.
  const ATTACHMENTS_ROOT = path.join(TACIT_DIR, "pins");
  const CANVAS_BACKGROUNDS_ROOT = path.join(TACIT_DIR, "canvas-backgrounds");
  const LOCAL_MEDIA_ROOTS = [ATTACHMENTS_ROOT, CANVAS_BACKGROUNDS_ROOT];
  protocol.handle("tc-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      // A chat attachment, by the id main gave it: tc-attachment://chat/<id>.
      // Range requests pass through, so a video can seek.
      if (url.host === "chat") {
        const held = chatAttachments.get(decodeURIComponent(url.pathname.slice(1)));
        if (!held) return new Response("not found", { status: 404 });
        return await net.fetch(pathToFileURL(held.path).toString(), { headers: request.headers });
      }
      const requestedPath = decodeURIComponent(url.pathname);
      const resolved = path.resolve(requestedPath);
      const allowed = LOCAL_MEDIA_ROOTS.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
      if (!allowed) {
        return new Response("forbidden", { status: 403 });
      }
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(message, { status: 500 });
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    // A browser node's page, or a popup window one of them opened (a sign-in
    // popup runs in its opener's profile, so its session is a guest's).
    const isGuestPage =
      contents.getType() === "webview" ||
      (contents.getType() === "window" && guestSessionProfiles.has(contents.session));
    if (isGuestPage) {
      // As the Chrome it's built from, in the page and in its requests, so
      // Google lets it sign in (SHR-130). Electron's own user agent names
      // Electron, and its brand list leaves out Google Chrome.
      contents.setUserAgent(browserChromeIdentity().userAgent);
      presentPageAsChrome(contents);

      // Sign-in pages go to the system browser, since Google refuses them in
      // a node (SHR-130); TACIT_BROWSER_SIGNIN_IN_APP=1 keeps them here.
      const redirectAuthToSystemBrowser = (url: string): boolean => {
        if (!isSignInSentOut(url)) return false;
        if (isSafeExternalUrl(url)) openSignInOutside(contents, url);
        return true;
      };
      contents.on("will-navigate", (event, url) => {
        if (redirectAuthToSystemBrowser(url)) event.preventDefault();
      });
      contents.on("will-redirect", (event, url) => {
        if (redirectAuthToSystemBrowser(url)) event.preventDefault();
      });
      // Some sites open sign-in in a popup rather than a top-level
      // redirect — this needs the same auth-domain check, or those
      // popups silently land in the user's real browser with no
      // explanation.
      //
      // Everything else now opens as a new canvas node instead of being
      // handed to the real browser. Ejecting on every target="_blank" was
      // the single largest hole in the record: a link click moved the work
      // somewhere Tacit cannot see, and made the app stop feeling like the
      // place the work happens. The popup inherits the source node's
      // profile, so it opens as the same signed-in person.
      //
      // Shared with the context menu below, so "Open Link in New Node" and a
      // target="_blank" click cannot disagree about where a link belongs.
      const reportGuestCopy = (): void => {
        setTimeout(() => {
          if (contents.isDestroyed()) return;
          sendToWindow(mainWindow, "handoff:guest-copied", { sourceWebContentsId: contents.id });
        }, 150);
      };
      const routeOpenedUrl = (url: string, scripted = false): "child-window" | "routed" => {
        const disposition = resolvePopupDisposition({
          url,
          profileId: guestSessionProfiles.get(contents.session),
          scripted,
          isAuthBlocked: isSignInSentOut,
          isSafeExternal: isSafeExternalUrl,
        });
        if (disposition.action === "child-window") return "child-window";
        if (disposition.action === "canvas-node") {
          sendToWindow(mainWindow, "browser:popup-requested", {
            url: disposition.url,
            profileId: disposition.profileId,
            sourceWebContentsId: contents.id,
          });
        } else if (disposition.action === "system-browser") {
          if (disposition.reason === "auth") openSignInOutside(contents, disposition.url);
          else void shell.openExternal(disposition.url);
        }
        return "routed";
      };

      // A popup opened by script (window.open with features: how "Sign in
      // with Google" opens) runs as a real window of this page, in its
      // profile, keeping window.opener so it can hand the sign-in back and
      // close itself (SHR-131). Links still open as tiles on the canvas.
      contents.setWindowOpenHandler(({ url, disposition }) => {
        if (routeOpenedUrl(url, disposition === "new-window") !== "child-window") return { action: "deny" };
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            ...(mainWindow && !mainWindow.isDestroyed() ? { parent: mainWindow } : {}),
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      });

      // Right-click. Built here, in main, from Chromium's own report of what
      // was clicked — the renderer neither builds it nor learns that it
      // happened, and the page cannot ask for an item it was not offered.
      // "Open Link in New Node" deliberately goes through the same routing as
      // a target="_blank" popup, so an auth-blocked link still round-trips to
      // the real browser instead of opening a dead-end tile.
      contents.on("context-menu", (_contextEvent, params) => {
        const entries = buildBrowserContextMenu({
          linkUrl: params.linkURL,
          isEditable: params.isEditable,
          canCopy: params.editFlags.canCopy,
          canPaste: params.editFlags.canPaste,
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
          hasProfile: guestSessionProfiles.has(contents.session),
          isDev,
        });
        const run = (action: BrowserContextMenuAction): void => {
          if (contents.isDestroyed()) return;
          switch (action) {
            case "back": return contents.navigationHistory.goBack();
            case "forward": return contents.navigationHistory.goForward();
            case "reload": return contents.reload();
            case "copy":
              contents.copy();
              return reportGuestCopy();
            case "paste": return contents.paste();
            case "copy-link":
              clipboard.writeText(params.linkURL);
              return reportGuestCopy();
            case "open-link-in-node":
              routeOpenedUrl(params.linkURL);
              return;
            case "inspect": return contents.inspectElement(params.x, params.y);
          }
        };
        const menu = Menu.buildFromTemplate(
          entries.map((entry) =>
            entry.kind === "separator"
              ? { type: "separator" as const }
              : {
                  label: entry.label,
                  enabled: entry.enabled,
                  click: () => run(entry.action),
                },
          ),
        );
        // Anchored to the app window: a guest's webContents is not one, and
        // `popup()` with no window puts the menu on whatever is focused.
        menu.popup(mainWindow ? { window: mainWindow } : undefined);
      });

      // ⌘F and the zoom chords, pressed while the page owns the keyboard.
      // Nothing else is inspected and nothing but the resolved name is
      // forwarded — see browser-guest-shortcuts.ts on why this is kept that
      // tight. The renderer matches the webContents id back to a tile the same
      // way it does for popups.
      contents.on("before-input-event", (inputEvent, input) => {
        // A copy in the page, for handoffs: only that it happened crosses,
        // after the page has had time to write the clipboard.
        if (isGuestCopyChord(input, process.platform)) reportGuestCopy();
        const shortcut = resolveGuestShortcut(input, process.platform);
        if (!shortcut) return;
        inputEvent.preventDefault();
        sendToWindow(mainWindow, "browser:guest-shortcut", {
          shortcut,
          sourceWebContentsId: contents.id,
        });
      });
    }
  });

  try {
    hookSocketPath = await hookReceiver.start();
  } catch (error) {
    hookSocketPath = null;
    console.error("[HookReceiver] Startup disabled:", error);
  }
  let previousSessionHistoryScope = new Map<string, string>();
  sessionScanner.start((sessions) => {
    const nextSessionHistoryScope = buildSessionHistoryScope(sessions);
    const { projectDirs, invalidatedFilePaths } = diffSessionHistoryScopes(
      previousSessionHistoryScope,
      nextSessionHistoryScope,
    );
    previousSessionHistoryScope = nextSessionHistoryScope;
    for (const filePath of invalidatedFilePaths) {
      invalidateSessionIndexForFile(filePath);
    }

    const managed = telemetryService.getManagedSessions();
    const merged = mergeAndDedupeSessions(managed, sessions);
    sendToWindow(mainWindow, "sessions:list-changed", merged);
    emitSessionHistoryChanged({
      reason: "session_scan_changed",
      projectDirs,
    });
  });
  ensureCliLinks();
  syncCliIntegrationOnStartup({
    autoRegisterEnabled: readCliIntegrationState().autoRegister,
    cliRegistered: isCliRegistered(getCliDir()),
    registerCli: () => registerCli(getCliDir()),
    ensureSkills: ensureSkillInstalled,
    persistAutoRegisterEnabled: (enabled) => {
      writeCliIntegrationState({ autoRegister: enabled });
    },
  });
  setupIpc();
  await initAuth();
  createWindow();
  if (mainWindow) setupAutoUpdater(mainWindow);

  onAuthStateChange((user) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("auth:state-changed", user);
    }
    if (user) {
      backfillHistory().catch((err) =>
        console.error("[Auth] Backfill error:", err),
      );
      flushSyncQueue().catch((err) =>
        console.error("[Auth] Queue flush error:", err),
      );
    }
  });

  setInterval(() => {
    if (isLoggedIn()) {
      flushSyncQueue().catch((err) =>
        console.error("[UsageSync] Periodic flush error:", err),
      );
      syncRecentRecords().catch((err) =>
        console.error("[UsageSync] Periodic sync error:", err),
      );
    }
  }, 5 * 60_000);

  app.on("open-url", async (_event, url) => {
    if (url.startsWith("tacit://auth/callback")) {
      await handleAuthCallback(url);
    }
  });

  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const authUrl = argv.find((arg) =>
      arg.startsWith("tacit://auth/callback"),
    );
    if (authUrl) {
      handleAuthCallback(authUrl);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let resolvePendingFlush: (() => void) | undefined;
const FLUSH_BEFORE_QUIT_TIMEOUT_MS = 3000;

/**
 * Waits for the renderer to run one last state.save() before any PTYs get
 * destroyed. Autosave alone (5s debounce, 60s backstop — see App.tsx's
 * useAutoSave) leaves a real window where a quit shortly after a change
 * loses that change even on a clean, graceful quit — this closes that gap
 * for the actual quit path specifically. Bounded by a timeout so a
 * stuck/crashed renderer can never prevent the app from quitting; this is a
 * best-effort improvement, not an ironclad guarantee (a hard kill, e.g.
 * SIGKILL, still bypasses this entirely — nothing running in-process can
 * intercept that).
 */
function requestFinalFlushAndWait(win: BrowserWindow | null): Promise<void> {
  if (!sendToWindow(win, "app:flush-before-quit")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolvePendingFlush = undefined;
      resolve();
    }, FLUSH_BEFORE_QUIT_TIMEOUT_MS);
    resolvePendingFlush = () => {
      clearTimeout(timer);
      resolvePendingFlush = undefined;
      resolve();
    };
  });
}

let isQuitting = false;
app.on("will-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  chromeLoginWatch?.close();
  // Chat-mode managers are child processes; they end with the app.
  chatEngine.stopAll();
  renderDiagnostics.recordMainEvent("app_will_quit", {
    platform: process.platform,
  });
  void (async () => {
    // Every step is best-effort. Without the finally, one throw anywhere in
    // here means `app.quit()` is never reached and the app sits half-quit
    // forever — window alive, unable to exit, and any pending update installer
    // waiting on a process that will never die.
    try {
      await requestFinalFlushAndWait(mainWindow);
      outputBatcher.dispose();
      await ptyManager.destroyAll();
      gitWatcher.unwatchAll();
      fileTreeWatcher.unwatchAll();
      sessionWatcher.unwatchAll();
      hookReceiver.stop();
      stopAutoUpdater();
      apiServer.stop();
      cleanupPortFile();
    } catch (error) {
      console.error("[Tacit] teardown failed; quitting anyway:", error);
    } finally {
      app.quit();
    }
  })();
});

// macOS convention: keep the process alive in the dock when the last window
// closes; the `activate` handler above re-creates a window when the user
// clicks the dock icon. Other platforms still quit. The preference is set
// from the renderer via `app:set-quit-on-last-window-closed` and lets the
// user opt out of the macOS behavior.
let quitOnLastWindowClosed = false;
ipcMain.on("app:set-quit-on-last-window-closed", (_event, value: unknown) => {
  quitOnLastWindowClosed = value === true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || quitOnLastWindowClosed) {
    app.quit();
  }
});
