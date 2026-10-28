import type { SceneDocument } from "./scene";
import type {
  TelemetryEventPage,
  TelemetryProvider,
  TerminalTelemetrySnapshot,
  WorkflowTelemetrySnapshot,
} from "../../shared/telemetry";
import type {
  RenderDiagnosticEventInput,
  RenderDiagnosticsLogInfo,
} from "../../shared/render-diagnostics";
import type { SessionHistoryChangedEvent } from "../../shared/sessions";
import type {
  ProjectInstructionsStatus,
  SetUpProjectInstructionsResult,
} from "../../shared/project-instructions";
import type { ApprovalDecision, ChatEvent } from "../../shared/chat-events";
import type {
  CaptureEntryView,
  CaptureEvent,
  CaptureHealth,
  RunChange,
  RunInfo,
} from "../../shared/capture";
import type { UpdaterSnapshot } from "../../electron/updater-state";
import type { BrowserObservationSummary } from "../../shared/browser-observation";
import type { ManagerSessionRow, ManagerTenure } from "../../shared/manager-role";
import type { AgentDetection } from "../../shared/agent-adapters";
import type {
  Pin,
  PinLink,
  PinStatus,
  CreatePinInput,
  UpdatePinInput,
} from "../../shared/pin";

export type { Pin, PinLink, PinStatus, CreatePinInput, UpdatePinInput };

type SessionTelemetryProvider = Exclude<TelemetryProvider, "unknown">;

export type PinEvent =
  | { type: "pin:created"; pin: Pin; repo: string }
  | { type: "pin:updated"; pin: Pin; repo: string }
  | { type: "pin:removed"; id: string; repo: string };

export * from "./scene";

export type TerminalType =
  | "shell"
  | "claude"
  | "codex"
  | "kimi"
  | "gemini"
  | "antigravity"
  | "opencode"
  | "wuu"
  | "lazygit"
  | "tmux";

export interface Position {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export type TerminalStatus =
  | "running"
  | "active"
  | "waiting"
  | "completed"
  | "success"
  | "error"
  | "idle";

export type ComposerSupportedTerminalType = TerminalType;

/**
 * Fired by electron/api-server.ts's browserAction handler around every
 * browser-bridge MCP tool call (browser_navigate/read/click/eval), so the
 * canvas can visually pulse the connection for the call's real duration —
 * see src/stores/bridgeActivityStore.ts and src/canvas/ConnectionLayer.tsx.
 */
export interface BrowserBridgeCallEvent {
  phase: "start" | "end";
  requestId: string;
  browserId: string;
  action: string;
  ok?: boolean;
  error?: string;
}

/**
 * A comfort chord a browser node's page swallowed before the renderer's own
 * shortcut listener could see it — see electron/browser-guest-shortcuts.ts.
 */
export type BrowserGuestShortcut = "find" | "zoom-in" | "zoom-out" | "zoom-reset";

/**
 * A download started or finished inside a browser node. Carries the name main
 * actually wrote and never the path it wrote it to; the renderer's job is to
 * say something true about it, not to reach it.
 */
export interface BrowserDownloadEvent {
  phase: "started" | "done";
  filename: string;
  url: string;
  /** Which guest asked for it, matched back to a tile by webContents id. */
  sourceWebContentsId: number | null;
  /** Present on `done` only. */
  outcome?: "completed" | "cancelled" | "interrupted";
  /** Opaque handle for revealing the file; absent unless completed. */
  revealToken?: string | null;
}

/**
 * Fired by electron/api-server.ts's nodeEmit handler around each connected
 * endpoint an emit_event call notifies, one event per (source, target) pair
 * — so the canvas can pulse any connection an event travels across, not
 * just ones with an active browser-bridge call. See
 * src/stores/bridgeActivityStore.ts's activeConnectionEvents and
 * src/canvas/ConnectionLayer.tsx.
 */
export interface CanvasBridgeEvent {
  phase: "start" | "end";
  requestId: string;
  sourceKind: "terminal" | "browser";
  sourceId: string;
  targetKind: "terminal" | "browser" | "note";
  targetId: string;
  type: string;
  /** The message's first words, on "start", when it carried one. */
  preview?: string;
  ok?: boolean;
  error?: string;
}

export interface ComposerImageAttachment {
  id: string;
  name: string;
  dataUrl: string;
}

export interface ComposerSubmitRequest {
  terminalId: string;
  ptyId: number;
  terminalType: ComposerSupportedTerminalType;
  worktreePath: string;
  text: string;
  images: ComposerImageAttachment[];
  /**
   * When false, paste the text and stage any images but DO NOT send the
   * Enter key — leaves the prompt in the agent's input buffer for the user
   * to review/edit/submit themselves. Defaults to true to preserve the
   * existing composer:submit behavior; pin drag-and-drop opts out.
   */
  submit?: boolean;
}

export type ComposerSubmitIssueStage =
  | "target"
  | "validate"
  | "read-images"
  | "prepare-images"
  | "paste-image"
  | "paste-text"
  | "submit";

export type ComposerSubmitIssueCode =
  | "target-not-running"
  | "unsupported-terminal"
  | "empty-submit"
  | "images-unsupported"
  | "image-read-failed"
  | "image-stage-failed"
  | "pty-write-failed"
  | "submit-key-failed"
  | "internal-error";

export interface ComposerSubmitResult {
  ok: boolean;
  requestId?: string;
  stagedImagePaths?: string[];
  error?: string;
  detail?: string;
  code?: ComposerSubmitIssueCode;
  stage?: ComposerSubmitIssueStage;
}

export type TerminalOrigin = "user" | "agent";

export interface TerminalData {
  id: string;
  title: string;
  customTitle?: string;
  starred?: boolean;
  type: TerminalType;
  minimized: boolean;
  focused: boolean;
  ptyId: number | null;
  status: TerminalStatus;
  x: number;
  y: number;
  width: number;
  height: number;
  tags: string[];
  origin?: TerminalOrigin;
  parentTerminalId?: string;
  scrollback?: string;
  sessionId?: string;
  initialPrompt?: string;
  /**
   * The initial prompt has been handed to the agent once. It stays on the
   * terminal as its stated intent, but a relaunch that can't resume the
   * session must not send it again: that restarted a manager's briefing, or
   * a worker's whole task, on every app restart.
   */
  initialPromptSent?: boolean;
  autoApprove?: boolean;
  stashed?: boolean;
  stashedAt?: number;
  /**
   * The workdesk manager runs in the docked chat instead of this tile (T6).
   * The tile keeps its place and id, since Tacit knows the manager by this
   * terminal, but starts no process: one owner of the session at a time.
   */
  chatMode?: boolean;
  /**
   * The size its process was last told, kept so the next launch starts at
   * it when the tile can't be measured yet (a restart, a tile off screen).
   */
  ptySize?: { cols: number; rows: number };
}

export interface TerminalRuntimeState {
  ptyId: number | null;
  status: TerminalStatus;
}

export type PersistedTerminalData = Omit<
  TerminalData,
  keyof TerminalRuntimeState
>;

export interface StashedTerminal {
  terminal: TerminalData;
  projectId: string;
  worktreeId: string;
  stashedAt: number;
}

export interface PersistedStashedTerminal {
  terminal: PersistedTerminalData;
  projectId: string;
  worktreeId: string;
  stashedAt: number;
}

export interface WorktreeData {
  id: string;
  name: string;
  path: string;
  isPrimary?: boolean;
  terminals: TerminalData[];
}

export interface PersistedWorktreeData extends Omit<WorktreeData, "terminals"> {
  terminals: PersistedTerminalData[];
}

/**
 * A named viewport position the user can jump back to. Slots 1..9
 * are addressed by string-keyed map so the persisted JSON is stable
 * across saves (numeric object keys round-trip as strings anyway).
 */
export interface SpatialWaypoint {
  x: number;
  y: number;
  scale: number;
  savedAt: number;
}

export type SpatialWaypointSlot = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type SpatialWaypointMap = Partial<Record<SpatialWaypointSlot, SpatialWaypoint>>;

export interface ProjectData {
  id: string;
  name: string;
  path: string;
  worktrees: WorktreeData[];
  waypoints?: SpatialWaypointMap;
}

export interface PersistedProjectData extends Omit<ProjectData, "worktrees"> {
  worktrees: PersistedWorktreeData[];
}

export interface CanvasState {
  version?: 1;
  viewport: Viewport;
  projects: ProjectData[];
  drawings?: unknown[];
  browserCards?: Record<string, unknown>;
}

export interface SceneCanvasState {
  version: 2;
  scene: SceneDocument;
}

export type PersistedCanvasState =
  | CanvasState
  | SceneCanvasState
  | { skipRestore: true };

export interface UsageBucket {
  label: string;
  hourStart: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cost: number;
  calls: number;
}

export interface ProjectUsage {
  path: string;
  name: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cost: number;
  calls: number;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cost: number;
  calls: number;
}

export interface UsageSummary {
  date: string;
  sessions: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate5m: number;
  totalCacheCreate1h: number;
  totalCost: number;
  buckets: UsageBucket[];
  projects: ProjectUsage[];
  models: ModelUsage[];
}

export interface UsageRangeDay {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cost: number;
  calls: number;
}

export interface UsageRangeSummary {
  startDate: string;
  endDate: string;
  days: UsageRangeDay[];
  sessions: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate5m: number;
  totalCacheCreate1h: number;
  totalCost: number;
  projects: ProjectUsage[];
  models: ModelUsage[];
}

export interface CloudUsageRangeSummary extends UsageRangeSummary {
  devices: DeviceUsage[];
}

export interface QuotaData {
  fiveHour: { utilization: number; resetsAt: string };
  sevenDay: { utilization: number; resetsAt: string };
  fetchedAt: number;
}

export type QuotaFetchResult =
  | { ok: true; data: QuotaData }
  | { ok: false; rateLimited: boolean };

export interface DeviceUsage {
  deviceId: string;
  tokens: number;
  cost: number;
  calls: number;
}

export interface CloudUsageSummary extends UsageSummary {
  devices: DeviceUsage[];
}

export interface InsightsProgressEvent {
  jobId: string;
  stage:
    | "validating"
    | "scanning"
    | "extracting_facets"
    | "aggregating"
    | "analyzing"
    | "generating_report";
  current: number;
  total: number;
  message: string;
}

export type InsightsGenerateResult =
  | { ok: true; jobId: string; reportPath: string }
  | {
      ok: false;
      jobId: string;
      error: { code: string; message: string; detail?: string };
    };

export interface GitBranchInfo {
  name: string;
  hash: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitLogEntry {
  hash: string;
  parents: string[];
  refs: string[];
  author: string;
  date: string;
  message: string;
}

export interface GitCommitFile {
  name: string;
  additions: number;
  deletions: number;
  binary: boolean;
  isImage: boolean;
  imageOld: string | null;
  imageNew: string | null;
}

export interface GitCommitDetail {
  message: string;
  diff: string;
  files: GitCommitFile[];
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  originalPath?: string;
}

export interface GitStashEntry {
  index: number;
  message: string;
  hash: string;
  date: string;
}

export interface GitTagInfo {
  name: string;
  hash: string;
  isAnnotated: boolean;
  message: string;
  date: string;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitBlameEntry {
  hash: string;
  author: string;
  date: string;
  lineStart: number;
  lineCount: number;
  content: string;
}

export interface GitFileDiff {
  hunks: string[];
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

export type GitMergeState =
  | { type: "none" }
  | { type: "merge" }
  | { type: "rebase"; current: string; total: string }
  | { type: "cherry-pick" };

export type AgentStreamEvent =
  | { type: "stream_start" }
  | { type: "stream_end" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; content: string; is_error?: boolean }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "error"; error: { message: string } }
  | {
      type: "message_start";
      usage?: { input_tokens: number; output_tokens: number };
    }
  | { type: "message_delta"; stop_reason: string | null }
  | {
      type: "approval_request";
      request_id: string;
      tool_name: string;
      tool_input: Record<string, unknown>;
    }
  | {
      type: "system_init";
      model?: string;
      tools_count?: number;
      session_id?: string;
      slash_commands?: string[];
    }
  | {
      type: "result_info";
      cost_usd?: number;
      input_tokens?: number;
      output_tokens?: number;
      duration_ms?: number;
      num_turns?: number;
    };

export interface TacitAPI {
  terminal: {
    create: (options: {
      cwd: string;
      shell?: string;
      args?: string[];
      terminalId?: string;
      terminalType?: string;
      origin?: string;
      theme?: "dark" | "light";
      /** The tile's measured size, so the process starts at it (SHR-95). */
      cols?: number;
      rows?: number;
    }) => Promise<number>;
    destroy: (ptyId: number) => Promise<void>;
    getPid: (ptyId: number) => Promise<number | null>;
    input: (ptyId: number, data: string) => void;
    resize: (ptyId: number, cols: number, rows: number) => void;
    notifyThemeChanged: (ptyId: number) => void;
    onOutput: (callback: (ptyId: number, data: string) => void) => () => void;
    onExit: (callback: (ptyId: number, exitCode: number) => void) => () => void;
    /**
     * An agent terminal started without Tacit's workspace tools, and why.
     * The terminal itself still opens.
     */
    onToolsUnavailable: (
      callback: (notice: {
        terminalId: string;
        terminalType?: string;
        reason: string;
      }) => void,
    ) => () => void;
    detectCli: (ptyId: number) => Promise<{
      cliType: TerminalType;
      pid?: number;
      sessionName?: string;
      autoApprove?: boolean;
    } | null>;
  };
  session: {
    getCodexLatest: () => Promise<string | null>;
    findCodex: (
      cwd: string,
      startedAt?: string,
      createdSince?: string,
    ) => Promise<{
      sessionId: string;
      filePath: string;
      confidence: "medium" | "weak";
    } | null>;
    findClaude: (
      cwd: string,
      startedAt?: string,
      pid?: number | null,
    ) => Promise<{
      sessionId: string;
      filePath: string;
      confidence: "strong" | "medium" | "weak";
    } | null>;
    findWuu: (
      cwd: string,
      startedAt?: string,
    ) => Promise<{
      sessionId: string;
      filePath: string;
      confidence: "medium" | "weak";
    } | null>;
    getPermissionMode: (
      sessionId: string,
      cwd: string,
    ) => Promise<string | null>;
    getBypassState: (
      type: string,
      sessionId: string,
      cwd: string,
    ) => Promise<boolean>;
    getClaudeByPid: (pid: number) => Promise<string | null>;
    findKimi: (
      cwd: string,
      startedAt?: string,
    ) => Promise<{
      sessionId: string;
      filePath: string;
      confidence: "medium" | "weak";
    } | null>;
    findAntigravity: (terminalId: string) => Promise<{
      sessionId: string;
      confidence: "strong";
    } | null>;
    findOpenCode: (
      cwd: string,
      startedAt?: string,
      /** This terminal, so sessions other terminals hold are skipped. */
      terminalId?: string,
    ) => Promise<{
      sessionId: string;
      filePath: string;
      confidence: "medium" | "weak";
    } | null>;
    /**
     * Resolves at OpenCode's next database write, or after 30s. OpenCode has
     * no hook and creates its session at the first message, so a terminal
     * not yet linked to one waits on this before looking again.
     */
    waitForOpenCodeWrite: () => Promise<void>;
    watch: (
      type: string,
      sessionId: string,
      cwd: string,
    ) => Promise<{ ok: boolean; reason?: string }>;
    unwatch: (sessionId: string) => Promise<void>;
    onTurnComplete: (callback: (sessionId: string) => void) => () => void;
    /**
     * The message this session ended on, or why there isn't one. Read in main
     * because transcripts are files; see electron/reply-transcript.ts for why
     * only the final message crosses back.
     */
    finalReply: (input: {
      sessionId: string;
      provider: string;
      cwd: string;
    }) => Promise<
      | { status: "ready"; text: string; turn?: string }
      | { status: "mid-task" }
      | { status: "no-reply" }
      | { status: "unavailable"; reason: string }
    >;
  };
  telemetry: {
    attachSession: (input: {
      terminalId: string;
      provider: SessionTelemetryProvider;
      sessionId: string;
      cwd: string;
      confidence: "strong" | "medium" | "weak";
    }) => Promise<{ ok: boolean; sessionFile: string | null }>;
    detachSession: (terminalId: string) => Promise<void>;
    updateTerminal: (input: {
      terminalId: string;
      worktreePath?: string;
      provider?: TelemetryProvider;
      ptyId?: number | null;
      shellPid?: number | null;
    }) => Promise<TerminalTelemetrySnapshot>;
    getTerminal: (
      terminalId: string,
    ) => Promise<TerminalTelemetrySnapshot | null>;
    getWorkflow: (
      workflowId: string,
      repoPath: string,
    ) => Promise<WorkflowTelemetrySnapshot | null>;
    listEvents: (input: {
      terminalId: string;
      limit?: number;
      cursor?: string;
    }) => Promise<TelemetryEventPage>;
    onSnapshotChanged: (
      callback: (payload: {
        terminalId: string;
        snapshot: TerminalTelemetrySnapshot;
      }) => void,
    ) => () => void;
  };
  capture: {
    /** Returns void, not a promise — nothing awaits a decision record. */
    record: (entry: CaptureEvent) => void;
    setCanvas: (canvasId: string | null) => void;
    getHealth: () => Promise<CaptureHealth>;
  };
  /** The task being recorded (T4.1; a "run" in the record). */
  run: {
    current: () => Promise<RunInfo | null>;
    /** Starts a run as the user; an open one ends as superseded. */
    start: (goal: string | null) => Promise<RunInfo | null>;
    end: () => Promise<boolean>;
    /** Names the open task; naming it makes it the person's. */
    rename: (goal: string) => Promise<RunInfo | null>;
    onChanged: (
      callback: (update: { run: RunInfo | null; change: RunChange | null }) => void,
    ) => () => void;
  };
  /**
   * Handoffs (SHR-62): where focus is, and when a node copied or an agent
   * terminal was pasted into or had files dropped on it. Main reads the
   * clipboard itself and keeps only a keyed fingerprint.
   */
  /** The workdesk manager in chat mode (T6.2). */
  chat: {
    start: (request: { terminalId: string; agent: "claude" | "codex" | "opencode"; cwd: string; sessionId: string | null }) => Promise<{ ok: boolean; error?: string }>;
    /** Sends a message with the files attached to it, by id; rejects when a file is gone. */
    send: (terminalId: string, text: string, attachmentIds?: string[]) => Promise<boolean>;
    /** The open dialog, starting in the chat's folder. */
    pickAttachments: (terminalId: string) => Promise<import("../../shared/chat-events").ChatAttachResult>;
    /** Files dragged from Tacit's own Files panel, by path. */
    attachPaths: (paths: string[]) => Promise<import("../../shared/chat-events").ChatAttachResult>;
    /** An attached file in the Mac's Quick Look (elsewhere, its default app). */
    quickLook: (attachmentId: string) => Promise<void>;
    /** Files dropped or pasted on the message box. */
    attachFiles: (files: File[]) => Promise<import("../../shared/chat-events").ChatAttachResult>;
    interrupt: (terminalId: string) => Promise<void>;
    /** `note`: what the person said with a deny; keeping on planning, what they'd change. */
    answer: (terminalId: string, requestId: string, decision: ApprovalDecision, note?: string) => Promise<void>;
    /** Answers the agent's questions, by question id; null skips them. */
    answerQuestion: (terminalId: string, requestId: string, answers: Record<string, string[]> | null) => Promise<void>;
    /** Picks the model, effort or mode for the chat from its next step. */
    configure: (terminalId: string, settings: { model?: string | null; effort?: string | null; mode?: string | null }) => Promise<void>;
    stop: (terminalId: string) => Promise<void>;
    /** The manager's terminal was closed: stops its chat agent and drops the chat. */
    forget: (terminalId: string) => Promise<void>;
    snapshot: (terminalId: string) => Promise<{ running: boolean; sessionId: string | null; events: ChatEvent[] }>;
    onEvent: (callback: (payload: { terminalId: string; event: ChatEvent }) => void) => () => void;
  };
  handoff: {
    /** A node ref (`terminal:…`, `browser:…`, `note:…`), or null for Tacit's panels. */
    focus: (node: string | null) => Promise<void>;
    copied: (node: string) => Promise<void>;
    pasted: (terminalId: string) => Promise<void>;
    droppedFiles: (terminalId: string, paths: string[], fromFilesPanel: boolean) => Promise<void>;
    /** A copy in a browser tile's page, which only main can see. */
    onGuestCopied: (callback: (payload: { sourceWebContentsId: number }) => void) => () => void;
  };
  browserConnection: {
    beginPairing: () => Promise<{
      endpoint: string;
      code: string;
      expiresAt: string;
    }>;
    listTabs: () => Promise<Array<{
      binding: import("../../shared/browser-connection").ConnectedTabBinding;
      connection: import("../../shared/browser-connection").ConnectedBrowserConnection;
    }>>;
    openExtensionFolder: () => Promise<string>;
    execute: (input: {
      bindingId: string;
      action: import("../../shared/browser-controller").BrowserActionName;
      params: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  managerRole: {
    set: (
      input: {
        terminalId: string;
        cli: string | null;
        canvasId: string | null;
        sessionId?: string | null;
        sessionFile?: string | null;
      } | null,
    ) => void;
    listSessions: () => Promise<ManagerSessionRow[]>;
    getCurrent: () => Promise<ManagerTenure | null>;
  };
  managerChat: {
    send: (
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: string;
        worktreePath: string;
      },
      message: string,
    ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  };
  diagnostics: {
    recordRenderEvent: (input: RenderDiagnosticEventInput) => Promise<void>;
    getRenderLogInfo: () => Promise<RenderDiagnosticsLogInfo>;
  };
  lifecycle: {
    onVisible: (
      callback: (payload: { reason: string; timestamp: number }) => void,
    ) => () => void;
  };
  project: {
    selectDirectory: () => Promise<string | null>;
    /** Multi-select sibling of `selectDirectory`; `[]` when the sheet is
     * cancelled. Used by first-run setup, which asks for folders plural. */
    selectDirectories: () => Promise<string[]>;
    createDirectory: () => Promise<string | null>;
    scan: (dirPath: string) => Promise<{
      name: string;
      path: string;
      worktrees: { path: string; branch: string; isPrimary: boolean }[];
    } | null>;
    listChildGitRepos: (
      dirPath: string,
    ) => Promise<{ name: string; path: string }[]>;
    rescanWorktrees: (
      dirPath: string,
    ) => Promise<{ path: string; branch: string; isPrimary: boolean }[]>;
    createWorktree: (
      repoPath: string,
      branch: string,
    ) => Promise<
      | {
          ok: true;
          path: string;
          worktrees: { path: string; branch: string; isPrimary: boolean }[];
        }
      | { ok: false; error: string }
    >;
    removeWorktree: (
      repoPath: string,
      worktreePath: string,
      force?: boolean,
    ) => Promise<
      | {
          ok: true;
          worktrees: { path: string; branch: string; isPrimary: boolean }[];
        }
      | { ok: false; error: string }
    >;
    deleteFolder: (
      projectPath: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Whether to offer agent instructions for this project folder, and what they'd change. Only reads. */
    instructionsStatus: (dirPath: string) => Promise<ProjectInstructionsStatus>;
    /** Adds or updates Tacit's agent instructions: AGENTS.md, and CLAUDE.md importing it. */
    setUpInstructions: (dirPath: string) => Promise<SetUpProjectInstructionsResult>;
    diff: (worktreePath: string) => Promise<{
      diff: string;
      files: {
        name: string;
        additions: number;
        deletions: number;
        binary: boolean;
        isImage: boolean;
        imageOld: string | null;
        imageNew: string | null;
      }[];
    }>;
  };
  git: {
    watch: (worktreePath: string) => Promise<void>;
    unwatch: (worktreePath: string) => Promise<void>;
    branches: (worktreePath: string) => Promise<GitBranchInfo[]>;
    log: (worktreePath: string, count?: number) => Promise<GitLogEntry[]>;
    isRepo: (dirPath: string) => Promise<boolean>;
    commitDetail: (
      worktreePath: string,
      hash: string,
    ) => Promise<GitCommitDetail | null>;
    checkout: (worktreePath: string, ref: string) => Promise<void>;
    init: (worktreePath: string) => Promise<void>;
    status: (worktreePath: string) => Promise<GitStatusEntry[]>;
    stage: (worktreePath: string, paths: string[]) => Promise<void>;
    unstage: (worktreePath: string, paths: string[]) => Promise<void>;
    discard: (
      worktreePath: string,
      trackedPaths: string[],
      untrackedPaths: string[],
    ) => Promise<void>;
    commit: (worktreePath: string, message: string) => Promise<string>;
    push: (worktreePath: string) => Promise<string>;
    pull: (worktreePath: string) => Promise<string>;
    amend: (worktreePath: string, message: string) => Promise<string>;
    fetch: (worktreePath: string, remote?: string) => Promise<string>;
    // Stash
    stashList: (worktreePath: string) => Promise<GitStashEntry[]>;
    stashCreate: (
      worktreePath: string,
      message: string,
      includeUntracked: boolean,
    ) => Promise<void>;
    stashApply: (worktreePath: string, index: number) => Promise<void>;
    stashPop: (worktreePath: string, index: number) => Promise<void>;
    stashDrop: (worktreePath: string, index: number) => Promise<void>;
    // Branch management
    branchCreate: (
      worktreePath: string,
      name: string,
      startPoint?: string,
    ) => Promise<void>;
    branchDelete: (
      worktreePath: string,
      name: string,
      force: boolean,
    ) => Promise<void>;
    branchRename: (
      worktreePath: string,
      oldName: string,
      newName: string,
    ) => Promise<void>;
    // Tags
    tagList: (worktreePath: string) => Promise<GitTagInfo[]>;
    tagCreate: (
      worktreePath: string,
      name: string,
      ref: string,
      message?: string,
    ) => Promise<void>;
    tagDelete: (worktreePath: string, name: string) => Promise<void>;
    // Remotes
    remoteList: (worktreePath: string) => Promise<GitRemoteInfo[]>;
    remoteAdd: (
      worktreePath: string,
      name: string,
      url: string,
    ) => Promise<void>;
    remoteRemove: (worktreePath: string, name: string) => Promise<void>;
    remoteRename: (
      worktreePath: string,
      oldName: string,
      newName: string,
    ) => Promise<void>;
    // Merge / Rebase / Cherry-pick
    merge: (worktreePath: string, ref: string) => Promise<string>;
    mergeAbort: (worktreePath: string) => Promise<void>;
    rebase: (worktreePath: string, ref: string) => Promise<string>;
    rebaseAbort: (worktreePath: string) => Promise<void>;
    rebaseContinue: (worktreePath: string) => Promise<string>;
    cherryPick: (worktreePath: string, hash: string) => Promise<string>;
    cherryPickAbort: (worktreePath: string) => Promise<void>;
    mergeState: (worktreePath: string) => Promise<GitMergeState>;
    // File diff & partial staging
    fileDiff: (
      worktreePath: string,
      filePath: string,
      staged: boolean,
    ) => Promise<GitFileDiff>;
    stageHunk: (
      worktreePath: string,
      filePath: string,
      hunkHeader: string,
    ) => Promise<void>;
    unstageHunk: (
      worktreePath: string,
      filePath: string,
      hunkHeader: string,
    ) => Promise<void>;
    // Blame
    blame: (worktreePath: string, filePath: string) => Promise<GitBlameEntry[]>;
    // Events
    onChanged: (callback: (worktreePath: string) => void) => () => void;
    onLogChanged: (callback: (worktreePath: string) => void) => () => void;
    onPresenceChanged: (
      callback: (worktreePath: string, payload: { isGitRepo: boolean }) => void,
    ) => () => void;
  };
  search: {
    fileContents: (
      query: string,
      worktreePath?: string,
    ) => Promise<Array<{ filePath: string; line: number; preview: string }>>;
    sessionContents: (
      query: string,
    ) => Promise<
      Array<{
        sessionId: string;
        filePath: string;
        lineNumber: number;
        preview: string;
      }>
    >;
    listSessions: (projectDirs: string[]) => Promise<
      Array<{
        sessionId: string;
        provider: "claude" | "codex" | "kimi";
        projectDir: string;
        filePath: string;
        firstPrompt: string;
        startedAt: string;
        lastActivityAt: string;
        estimatedMessageCount: number;
        fileSize: number;
      }>
    >;
    listSessionsPage: (
      projectDirs: string[],
      options: { limit: number; offset?: number },
    ) => Promise<{
      entries: Array<{
        sessionId: string;
        provider: "claude" | "codex" | "kimi";
        projectDir: string;
        filePath: string;
        firstPrompt: string;
        startedAt: string;
        lastActivityAt: string;
        estimatedMessageCount: number;
        fileSize: number;
      }>;
      total: number;
    }>;
  };
  state: {
    load: () => Promise<PersistedCanvasState | null>;
    save: (state: unknown) => Promise<void>;
    onFlushBeforeQuit: (callback: () => void) => () => void;
    notifyFlushComplete: () => void;
  };
  snapshots: {
    list: () => Promise<
      Array<{
        id: string;
        savedAt: number;
        terminalCount: number;
        projectCount: number;
        label?: string;
      }>
    >;
    read: (id: string) => Promise<unknown | null>;
    append: (args: {
      savedAt: number;
      terminalCount: number;
      projectCount: number;
      label?: string;
      body: unknown;
    }) => Promise<{
      id: string;
      savedAt: number;
      terminalCount: number;
      projectCount: number;
      label?: string;
    }>;
  };
  workspace: {
    save: (data: string) => Promise<string | null>;
    open: () => Promise<string | null>;
    saveToPath: (filePath: string, data: string) => Promise<void>;
    setTitle: (title: string) => Promise<void>;
  };
  canvas: {
    pickBackgroundImage: () => Promise<string | null>;
  };
  browserIdentity: {
    clearData: (
      identityId: string,
    ) => Promise<
      import("../../shared/browser-partition-registry").BrowserPartitionEraseResult
    >;
    listOrphanPartitions: (
      identityIds: string[],
    ) => Promise<
      import("../../shared/browser-partition-registry").OrphanPartitionSummary[]
    >;
    eraseOrphanPartition: (input: {
      identityId: string;
      identityIds: string[];
    }) => Promise<
      import("../../shared/browser-partition-registry").BrowserPartitionEraseResult
    >;
    listImportProfiles: () => Promise<
      import("../../shared/browser-profile-import").ImportableBrowserProfile[]
    >;
    importChromeProfiles: (input: {
      profileIds: string[];
      existingIdentityNames: string[];
    }) => Promise<
      import("../../shared/browser-profile-import").BrowserProfileImportBatchResult
    >;
    /** Copies each imported profile's logins from its Chrome profile again (SHR-132). */
    syncFromChrome: (input: {
      profiles: import("../../shared/browser-profile-sync").ChromeSyncRequest[];
    }) => Promise<import("../../shared/browser-profile-sync").ChromeSyncBatch>;
    /** Tells main which Chrome profile each imported profile came from. */
    setSyncSources: (input: {
      profiles: import("../../shared/browser-profile-sync").ChromeSyncRequest[];
    }) => Promise<void>;
    /** Main says an automatic sync is due: the Mac woke, hours passed, or Chrome got a new login. */
    onSyncDue: (callback: (due: import("../../shared/browser-profile-sync").ChromeSyncDue) => void) => () => void;
  };
  fs: {
    /** One folder's entries, folders first, or why it can't be read. */
    listDir: (
      dirPath: string,
    ) => Promise<{ entries: { name: string; isDirectory: boolean }[] } | { error: string }>;
    /**
     * A git project's whole tree, or word to load it a folder at a time:
     * a folder that isn't a git repository, or a project too large for one tree.
     */
    listAllFiles: (
      dirPath: string,
    ) => Promise<
      | { type: "git"; paths: string[] }
      | { type: "lazy"; reason: "not-git" | "large" }
    >;
    listIgnoredFiles: (dirPath: string) => Promise<string[]>;
    readFile: (
      filePath: string,
    ) => Promise<
      { type: string; content: string } | { error: string; size?: string }
    >;
    writeFile: (
      filePath: string,
      content: string,
    ) => Promise<{ changed: boolean }>;
    copy: (
      sources: string[],
      destDir: string,
    ) => Promise<{
      copied: string[];
      skipped: string[];
    }>;
    getFilePath: (file: File) => string;
    rename: (oldPath: string, newName: string) => Promise<void>;
    move: (oldPath: string, newPath: string) => Promise<void>;
    delete: (targetPath: string) => Promise<void>;
    mkdir: (dirPath: string, name: string) => Promise<void>;
    createFile: (dirPath: string, name: string) => Promise<void>;
    reveal: (targetPath: string) => Promise<void>;
    /**
     * Watches a folder: its whole tree (`recursive`), or only its own
     * entries. Main may refuse (too many folders watched, or the folder is
     * gone); a refused watch isn't watched and needs no unwatch.
     */
    watchDir: (dirPath: string, recursive: boolean) => Promise<import("../../shared/file-watch").WatchDirResult>;
    unwatchDir: (dirPath: string, recursive: boolean) => Promise<void>;
    unwatchAllDirs: () => Promise<void>;
    onDirChanged: (callback: (dirPath: string) => void) => () => void;
    /** Watches that stopped (macOS couldn't keep them); they're no longer watched. */
    onWatchFailed: (
      callback: (failures: import("../../shared/file-watch").WatchDirFailure[]) => void,
    ) => () => void;
  };
  agents: {
    /**
     * Which agent CLIs are installed, and their versions. Cached in main for
     * the app's lifetime; `refresh` re-runs detection.
     */
    detect: (options?: {
      commandOverrides?: Record<string, string>;
      refresh?: boolean;
    }) => Promise<AgentDetection[]>;
  };
  record: {
    /**
     * Newest-first slice of the decision record — the same append-only log
     * the `recall` tool reads, finally pointed at the UI as well.
     */
    list: (options?: {
      limit?: number;
      canvasId?: string | null;
    }) => Promise<CaptureEntryView[]>;
  };
  memory: {
    scan: (worktreePath: string) => Promise<{
      nodes: Array<{
        fileName: string;
        filePath: string;
        name: string;
        description: string;
        type: string;
        body: string;
        mtime: number;
        ctime: number;
      }>;
      edges: Array<{
        source: string;
        target: string;
        label: string;
      }>;
      dirPath: string;
    }>;
    watch: (worktreePath: string) => Promise<void>;
    unwatch: (worktreePath: string) => Promise<void>;
    scanWorkspace: (canvasId: string) => Promise<{
      nodes: Array<{
        fileName: string;
        filePath: string;
        name: string;
        description: string;
        type: string;
        body: string;
        mtime: number;
        ctime: number;
      }>;
      edges: Array<{
        source: string;
        target: string;
        label: string;
      }>;
      dirPath: string;
    }>;
    watchWorkspace: (canvasId: string) => Promise<void>;
    unwatchWorkspace: (canvasId: string) => Promise<void>;
    onChanged: (
      callback: (graph: {
        nodes: Array<{
          fileName: string;
          filePath: string;
          name: string;
          description: string;
          type: string;
          body: string;
          mtime: number;
          ctime: number;
        }>;
        edges: Array<{
          source: string;
          target: string;
          label: string;
        }>;
        dirPath: string;
      }) => void,
    ) => () => void;
  };
  fonts: {
    listDownloaded: () => Promise<string[]>;
    /** A downloaded font's file, by its registry file name. */
    read: (fileName: string) => Promise<ArrayBuffer>;
    /** Downloads a registry font, by its file name. */
    download: (fileName: string) => Promise<{
      ok: boolean;
      error?: string;
    }>;
  };

  cli: {
    isRegistered: () => Promise<boolean>;
    register: () => Promise<{ ok: boolean; skillInstalled: boolean }>;
    unregister: () => Promise<boolean>;
    validateCommand: (
      command: string,
      args?: string[],
    ) => Promise<
      | { ok: true; resolvedPath: string; version: string | null }
      | { ok: false; error: string }
    >;
  };
  composer: {
    submit: (request: ComposerSubmitRequest) => Promise<ComposerSubmitResult>;
  };
  usage: {
    query: (dateStr: string) => Promise<UsageSummary>;
    queryRange: (
      startDate: string,
      endDate: string,
    ) => Promise<UsageRangeSummary>;
    queryCloud?: (dateStr: string) => Promise<CloudUsageSummary | null>;
    queryRangeCloud?: (
      startDate: string,
      endDate: string,
    ) => Promise<CloudUsageRangeSummary | null>;
    heatmap: () => Promise<Record<string, { tokens: number; cost: number }>>;
    heatmapCloud?: () => Promise<Record<string, { tokens: number; cost: number }> | null>;
  };
  quota: {
    fetch: () => Promise<QuotaFetchResult>;
  };
  codexQuota: {
    fetch: () => Promise<QuotaFetchResult>;
  };
  summary: {
    generate: (input: {
      terminalId: string;
      sessionId: string;
      sessionType: "claude" | "codex";
      cwd: string;
      summaryCli: "claude" | "codex";
      locale: "en" | "zh";
    }) => Promise<{
      ok: boolean;
      summary?: string;
      error?: string;
      sessionFileSize?: number;
    }>;
  };
  insights: {
    generate: (
      cliTool: "claude" | "codex",
      jobId: string,
    ) => Promise<InsightsGenerateResult>;
    onProgress: (
      callback: (progress: InsightsProgressEvent) => void,
    ) => () => void;
    openReport: (filePath: string) => Promise<void>;
    getLastReport: () => Promise<string | null>;
  };
  secure: {
    isAvailable: () => Promise<boolean>;
    encrypt: (plaintext: string) => Promise<string>;
    decrypt: (base64: string) => Promise<string>;
  };
  agent: {
    start: (
      sessionId: string,
      config: {
        type: "claude-code";
        cwd?: string;
        resumeSessionId?: string;
        baseURL: string;
        apiKey: string;
        model: string;
      },
    ) => Promise<{ slashCommands: string[] }>;
    send: (
      sessionId: string,
      text: string,
      config: {
        type: "anthropic" | "openai" | "claude-code";
        baseURL: string;
        apiKey: string;
        model: string;
        cwd?: string;
        resumeSessionId?: string;
      },
    ) => Promise<void>;
    abort: (sessionId: string) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
    delete: (sessionId: string) => Promise<void>;
    approve: (sessionId: string, requestId: string) => Promise<void>;
    deny: (
      sessionId: string,
      requestId: string,
      reason?: string,
    ) => Promise<void>;
    onEvent: (
      callback: (sessionId: string, event: AgentStreamEvent) => void,
    ) => () => void;
  };
  wires: {
    onMailboxChanged: (callback: (payload: WireMailboxChange) => void) => () => void;
    onTrackedFlag: (callback: (payload: TrackedHandoffFlag) => void) => () => void;
    onHydraStatus: (callback: (payload: HydraWireStatus) => void) => () => void;
    /** Deliver everything waiting for an agent now, in order. */
    flushWaiting: (terminalId: string) => Promise<{ delivered: number; failed: number }>;
    /** Throw away what is waiting for an agent. */
    discardWaiting: (terminalId: string) => Promise<{ discarded: number }>;
    /** Send, from a wire's panel, into a terminal at the end of the wire. */
    sendToTerminal: (request: WireSendRequest) => Promise<WireSendResult>;
    /**
     * Whether a finished turn of `from` (keyed by shared/agent-reply.ts
     * replyKey) already went to `to` as the answer to its question.
     */
    replyAnswered: (input: { from: string; to: string; key: string }) => Promise<boolean>;
  };
  browser: {
    notifyWired: (
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: ComposerSupportedTerminalType;
        worktreePath: string;
      },
      message: string,
    ) => Promise<ComposerSubmitResult>;
    onBridgeCall: (
      callback: (payload: BrowserBridgeCallEvent) => void,
    ) => () => void;
    onCanvasBridgeEvent: (
      callback: (payload: CanvasBridgeEvent) => void,
    ) => () => void;
    /** `identityId` when sign-in opened in that profile's own Chrome profile. */
    onExternalAuthRedirect: (
      callback: (payload: { url: string; identityId?: string }) => void,
    ) => () => void;
    revealDownload: (token: string) => Promise<boolean>;
    observationSummary: () => Promise<BrowserObservationSummary>;
    clearObservations: (identityId?: string) => Promise<{ cleared: number }>;
    onPopupRequested: (
      callback: (payload: {
        url: string;
        profileId: string;
        sourceWebContentsId: number;
      }) => void,
    ) => () => void;
    onGuestShortcut: (
      callback: (payload: {
        shortcut: BrowserGuestShortcut;
        sourceWebContentsId: number;
      }) => void,
    ) => () => void;
    onDownloadEvent: (
      callback: (payload: BrowserDownloadEvent) => void,
    ) => () => void;
  };
  app: {
    homePath: string;
    platform: "darwin" | "win32" | "linux";
    requestClose: () => void;
    setQuitOnLastWindowClosed: (value: boolean) => void;
    /** Whether the window is full screen now. */
    isFullScreen: () => Promise<boolean>;
    /** The window entered or left full screen. */
    onFullScreenChange: (callback: (fullScreen: boolean) => void) => () => void;
  };
  hooks: {
    getSocketPath: () => Promise<string | null>;
    getHealth: () => Promise<{
      socketPath: string | null;
      lastEventAt: string | null;
      eventsReceived: number;
      parseErrors: number;
    }>;
    onSessionStarted: (
      callback: (payload: {
        terminalId: string;
        sessionId: string;
        transcriptPath: string | null;
        cwd: string | null;
      }) => void,
    ) => () => void;
    onTurnComplete: (
      callback: (payload: {
        terminalId: string;
        sessionId: string | null;
      }) => void,
    ) => () => void;
    onStopFailure: (
      callback: (payload: {
        terminalId: string;
        sessionId: string | null;
        error: string | null;
        errorDetails: string | null;
      }) => void,
    ) => () => void;
  };
  sessions: {
    onListChanged: (
      callback: (
        sessions: import("../../shared/sessions").SessionInfo[],
      ) => void,
    ) => () => void;
    onHistoryChanged: (
      callback: (payload: SessionHistoryChangedEvent) => void,
    ) => () => void;
    loadReplay: (
      filePath: string,
    ) => Promise<import("../../shared/sessions").ReplayTimeline>;
    forkSession: (
      sourceFilePath: string,
      turnIndex: number,
      targetProvider?: "claude" | "codex",
    ) => Promise<{ newSessionId: string; newFilePath: string }>;
  };
  menu: {
    onOpenFolder: (callback: (dirPath: string) => void) => () => void;
    onSelectAll: (callback: () => void) => () => void;
  };
  pins: {
    list: (repo: string) => Promise<Pin[]>;
    create: (input: CreatePinInput) => Promise<Pin>;
    update: (repo: string, id: string, patch: UpdatePinInput) => Promise<Pin>;
    remove: (repo: string, id: string) => Promise<void>;
    openPreview: (repo: string, id: string) => Promise<void>;
    saveAttachment: (
      repo: string,
      id: string,
      fileName: string,
      data: ArrayBuffer,
    ) => Promise<{ relativePath: string; absolutePath: string }>;
    dispatchToTerminal: (
      repo: string,
      pinId: string,
      target: {
        terminalId: string;
        ptyId: number;
        terminalType: ComposerSupportedTerminalType;
        worktreePath: string;
      },
    ) => Promise<ComposerSubmitResult>;
    subscribe: (handler: (event: PinEvent) => void) => () => void;
  };
  updater: {
    check: () => Promise<import("../../shared/updater-types").UpdateCheckOutcome>;
    install: () => void;
    getVersion: () => Promise<string>;
    getState: () => Promise<UpdaterSnapshot>;
    onUpdateAvailable: (
      callback: (info: UpdateEventInfo) => void,
    ) => () => void;
    onDownloadProgress: (
      callback: (progress: { percent: number }) => void,
    ) => () => void;
    onUpdateDownloaded: (
      callback: (info: UpdateEventInfo) => void,
    ) => () => void;
    onError: (callback: (error: { message: string }) => void) => () => void;
    onLocationWarning?: (
      callback: (info: { bundlePath: string }) => void,
    ) => () => void;
  };
}

export interface UpdateEventInfo {
  version: string;
  releaseNotes: string;
  releaseDate: string;
}

declare global {
  interface Window {
    tacit: TacitAPI;
  }
}

/** What is waiting for one agent along its wires (electron/wire-mailbox.ts). */
export interface WireMailboxChange {
  terminalId: string;
  waiting: Array<{ id: string; from: string; preview: string; at: number }>;
}

export interface WireSendRequest {
  target: { terminalId: string; ptyId: number; terminalType: string; worktreePath: string };
  envelope: {
    from: { kind: "terminal" | "browser" | "note"; id: string; title: string; role: "agent" | "shell" | "browser" | "note" | "task" };
    payload: "text" | "command" | "url" | "page" | "selection" | "reply" | "step";
    body: string;
  };
}

export interface WireSendResult {
  ok: boolean;
  detail?: string;
  /** The agent was mid-turn; it gets this when the turn ends. */
  queued?: boolean;
  waiting?: number;
}

/** A tracked hand-off along a wire that came back stuck or failed. */
export interface TrackedHandoffFlag {
  senderTitle: string;
  targetTitle: string;
  outcome: "completed" | "stuck" | "error";
  reason: string | null;
  report: string;
}

/** A Hydra worker's role and assignment status (electron/hydra-wire-status.ts). */
export interface HydraWireStatus {
  terminalId: string;
  role: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "timed_out" | "failed";
}
