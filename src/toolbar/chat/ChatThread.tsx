import { Children, useMemo, useState, type FC, type PropsWithChildren } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ChatTranscript, PendingApproval } from "../../../shared/chat-transcript";
import type { ApprovalDecision } from "../../../shared/chat-events";
import { useT } from "../../i18n/useT";
import { markdownClassName, renderMarkdown } from "../../utils/markdownClass";
import { toolVerb } from "../../components/transcriptModel";
import { agentIcon } from "../agentIcons";
import { findAgentAdapter } from "../../../shared/agent-adapters";
import { panToTerminal } from "../../utils/panToTerminal";
import { spawnedTerminalId, toolRunSummary, toThreadMessages, workerSpawn } from "./threadMessages";
import { findTerminal } from "../../actions/terminalLookup";
import { linkNodeIds, NODE_CHIP_HREF, type NodeDescription } from "../sessionReaderModel";
import { todoPlan } from "../../../shared/chat-stream-claude";
import { CompactedDivider, PlanSteps } from "./LongRunning";

/**
 * The docked chat's conversation with a manager in chat mode (T6), drawn by
 * assistant-ui's thread primitives over our own store (its external-store
 * runtime): the library handles the scrolling thread and message parts, and
 * these components give them Tacit's look. Text renders as markdown, tool
 * calls as cards (a Tacit worker it started as a worker card with Show on
 * canvas), thinking as a quiet line.
 */

type Dict = ReturnType<typeof useT>;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 transition-transform duration-quick ${open ? "rotate-90" : ""}`}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** A terminal named in the text, by its name, and whether it's still on the canvas. */
function describeTerminal(id: string, closedLabel: string): NodeDescription {
  const found = findTerminal(id);
  if (!found) return { label: closedLabel, open: false };
  return { label: found.terminal.customTitle?.trim() || found.terminal.title, open: true };
}

/**
 * Markdown, with terminal ids drawn as chips that read as the terminal's
 * name; clicking one shows it on the canvas.
 */
const TextPart: FC<{ text: string }> = ({ text }) => {
  const t = useT();
  const html = useMemo(() => renderMarkdown(linkNodeIds(text, (id) => describeTerminal(id, t.chat_node_closed))), [text, t]);
  return (
    <div
      className={`${markdownClassName} tc-node-chips`}
      style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.6 }}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(`a[href^="${NODE_CHIP_HREF}"]`);
        if (!link) return;
        e.preventDefault();
        const id = link.getAttribute("href")!.slice(NODE_CHIP_HREF.length);
        if (findTerminal(id)) panToTerminal(id);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

const ReasoningPart: FC<{ text: string; status?: { type: string } }> = ({ text, status }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = status?.type === "running";
  return (
    <div className="py-0.5">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[12px] italic text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        onClick={() => setOpen((v) => !v)}
        disabled={!text}
      >
        {text && <Chevron open={open} />}
        <span className={running ? "tc-live-pip" : undefined}>{running ? t.chat_thinking_now : t.chat_thought}</span>
      </button>
      {open && text && <div className="mt-1 whitespace-pre-wrap pl-4 text-[12px] italic text-[var(--text-muted)]">{text}</div>}
    </div>
  );
};

interface ToolCardProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  artifact?: { status: "running" | "done" | "error"; subagentSteps: number };
}

function statusOf(props: ToolCardProps): "running" | "done" | "error" {
  return props.artifact?.status ?? (props.isError ? "error" : props.result !== undefined ? "done" : "running");
}

/** The one line that says what a tool call is about. */
function subjectOf(args: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "command", "pattern", "url", "query", "description", "prompt", "id", "type"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.split("\n", 1)[0].trim();
      return key.endsWith("path") ? (line.split(/[\\/]/).filter(Boolean).pop() ?? line) : line.length > 90 ? `${line.slice(0, 90)}…` : line;
    }
  }
  return "";
}

function StatusMark({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") return <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} aria-hidden="true" />;
  if (status === "error") return <span className="text-[11px]" style={{ color: "var(--red)" }} aria-hidden="true">✕</span>;
  return <span className="text-[11px]" style={{ color: "var(--green)" }} aria-hidden="true">✓</span>;
}

function WorkerCard({ props, spawn, t }: { props: ToolCardProps; spawn: { agent: string | null; title: string }; t: Dict }) {
  const status = statusOf(props);
  const icon = agentIcon(spawn.agent);
  const id = spawnedTerminalId(typeof props.result === "string" ? props.result : undefined);
  const agentName = spawn.agent ? (findAgentAdapter(spawn.agent)?.displayName ?? spawn.agent) : t.chat_worker;
  return (
    <div className="my-1 flex items-center gap-2.5 rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] px-3 py-2.5">
      <span className="tc-icon-shell shrink-0" style={{ width: 26, height: 26 }}>
        {icon && <img src={icon} alt="" className="h-[18px] w-[18px] object-contain" draggable={false} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-[var(--text-primary)]">
          {t.chat_started_worker} · <span className="tc-mono text-[var(--text-secondary)]">{agentName}</span>
        </span>
        {spawn.title && <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-muted)]">“{spawn.title}”</span>}
        {status === "error" && typeof props.result === "string" && (
          <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: "var(--red)" }}>{props.result}</span>
        )}
      </span>
      <StatusMark status={status} />
      {id && (
        <button
          type="button"
          className="tc-rail-btn shrink-0 border border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => panToTerminal(id)}
        >
          {t.chat_show_on_canvas}
        </button>
      )}
    </div>
  );
}

const ToolCard: FC<ToolCardProps> = (props) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const spawn = workerSpawn(props.toolName, props.args);
  if (spawn) return <WorkerCard props={props} spawn={spawn} t={t} />;
  // Claude's todo list reads as its plan, as it does live.
  const plan = props.toolName === "TodoWrite" ? todoPlan(props.args) : null;
  if (plan) {
    return (
      <div className="my-1 rounded-[10px] border border-[var(--border)] px-3 py-2">
        <div className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{t.chat_plan}</div>
        <PlanSteps steps={plan} />
      </div>
    );
  }
  const status = statusOf(props);
  const subject = subjectOf(props.args);
  const steps = props.artifact?.subagentSteps ?? 0;
  // A failed call opens by itself: folding away the one worth reading is
  // what this treatment exists to avoid.
  const expanded = open !== (status === "error");
  const output = typeof props.result === "string" ? props.result : props.result !== undefined ? JSON.stringify(props.result, null, 2) : "";
  return (
    <div className="my-0.5">
      <button type="button" className="flex w-full items-center gap-1.5 py-0.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={expanded}>
        <span className="text-[var(--text-faint)]"><Chevron open={expanded} /></span>
        <span className="tc-mono shrink-0 text-[12px]" style={{ color: status === "error" ? "var(--red)" : "var(--text-secondary)" }}>
          {toolVerb(props.toolName)}
        </span>
        {subject && <span className="tc-mono min-w-0 truncate text-[12px] text-[var(--text-muted)]">{subject}</span>}
        {steps > 0 && <span className="tc-mono shrink-0 text-[11px] text-[var(--text-faint)]">· {t.chat_subagent_steps(steps)}</span>}
        <span className="ml-auto shrink-0 pl-2"><StatusMark status={status} /></span>
      </button>
      {expanded && (
        <div className="mb-1 ml-4 mt-1 overflow-hidden rounded-lg border border-[var(--border)]">
          {props.argsText && (
            <pre className="tc-mono max-h-40 overflow-auto whitespace-pre-wrap break-all bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
              {prettyJson(props.argsText)}
            </pre>
          )}
          {output && (
            <pre
              className="tc-mono max-h-56 overflow-auto whitespace-pre-wrap break-all border-t border-[var(--border)] px-2.5 py-2 text-[11px]"
              style={{ color: status === "error" ? "var(--red)" : "var(--text-secondary)" }}
            >
              {output.length > 8000 ? `${output.slice(0, 8000)}\n…` : output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

interface RunPart {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  artifact?: { status?: string };
}

/** Runs shorter than this stay as they are. */
const FOLD_AT = 3;

/**
 * A run of tool calls in a row, folded into one line ("Used 9 tools ·
 * list_nodes, wait_for_nodes ×2 +5 more") that opens to the rows. Worker
 * cards and failed calls stay visible while it's folded, and while it runs
 * the latest call shows beneath the line.
 */
const ToolRun: FC<PropsWithChildren<{ startIndex: number; endIndex: number }>> = ({ startIndex, endIndex, children }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const parts = useAuiState((s) => s.message.parts) as readonly RunPart[];
  const run = parts.slice(startIndex, endIndex + 1);
  const rows = Children.toArray(children);
  const isWorker = (p: RunPart | undefined) => !!p?.toolName && workerSpawn(p.toolName, p.args ?? {}) !== null;
  const plain = run.filter((p) => !isWorker(p));
  if (plain.length < FOLD_AT) return <>{children}</>;
  const running = plain.some((p) => p.artifact?.status === "running");
  const failed = plain.some((p) => p.artifact?.status === "error" || p.isError);
  const lastPlain = run.reduce((last, p, i) => (isWorker(p) ? last : i), -1);
  const visible = (i: number) => {
    if (open) return true;
    const p = run[i];
    if (isWorker(p) || p?.artifact?.status === "error" || p?.isError) return true;
    return running && i === lastPlain;
  };
  return (
    <div className="my-0.5">
      <button type="button" className="flex w-full items-center gap-1.5 py-0.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="text-[var(--text-faint)]"><Chevron open={open} /></span>
        <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">{running ? t.chat_tool_run_live(plain.length) : t.chat_tool_run(plain.length)}</span>
        <span className="tc-mono min-w-0 truncate text-[12px] text-[var(--text-muted)]">
          {toolRunSummary(plain.map((p) => toolVerb(p.toolName)))}
        </span>
        <span className="ml-auto shrink-0 pl-2"><StatusMark status={running ? "running" : failed ? "error" : "done"} /></span>
      </button>
      <div className={open ? "ml-2 border-l border-[var(--border)] pl-2" : undefined}>
        {rows.map((row, i) => (visible(i) ? row : null))}
      </div>
    </div>
  );
};

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Each message carries its id, so a reader can jump to it. */
function MessageAnchor({ children, className }: PropsWithChildren<{ className: string }>) {
  const id = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root className={className} data-msg-id={id}>
      {children}
    </MessagePrimitive.Root>
  );
}

/** Sent while a turn ran: said above the message, since it changed that turn. */
function SteeredLabel() {
  const t = useT();
  const steered = useAuiState((s) => (s.message.metadata as { custom?: { steered?: boolean } } | undefined)?.custom?.steered === true);
  return steered ? <div className="mb-1 w-full text-right text-[11px] text-[var(--text-muted)]">{t.chat_steered}</div> : null;
}

const UserMessage: FC = () => (
  <MessageAnchor className="mb-3 flex flex-col items-end">
    <SteeredLabel />
    <div
      className="max-w-[86%] whitespace-pre-wrap break-words border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-[var(--text-primary)]"
      style={{ fontSize: "var(--text-sm)", borderRadius: "12px 12px 4px 12px", lineHeight: 1.5 }}
    >
      <MessagePrimitive.Parts components={{ Text: ({ text }) => <>{text}</> }} />
    </div>
  </MessageAnchor>
);

/** Three dots that pulse in turn: the reply is on its way. */
function TypingDots({ label }: { label: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1" role="status" aria-label={label}>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="tc-typing-dot inline-block h-[5px] w-[5px] rounded-full"
          style={{ background: "var(--text-muted)", animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function ReplyHeader({ agent, label, live }: { agent: string; label: string; live?: boolean }) {
  const icon = agentIcon(agent);
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
      {icon && <img src={icon} alt="" className={`h-[14px] w-[14px] object-contain ${live ? "tc-live-pip" : ""}`} draggable={false} />}
      <span>{label}</span>
    </div>
  );
}

/** A reply that has begun but has nothing in it yet. */
function EmptyRunningReply() {
  const t = useT();
  const running = useAuiState((s) => s.message.status?.type === "running");
  return running ? <TypingDots label={t.chat_reply_coming} /> : null;
}

/**
 * Between sending and the agent's first event, before there's a reply to
 * draw: its header, live, with the dots, so the wait reads as work.
 */
function PendingReply({ agent, label }: { agent: string; label: string }) {
  const t = useT();
  return (
    <div className="tc-enter-fade-up mb-4 flex flex-col gap-1">
      <ReplyHeader agent={agent} label={label} live />
      <TypingDots label={t.chat_reply_coming} />
    </div>
  );
}

/** A line between messages, not a reply: earlier turns summarized. */
function NoteMessage() {
  const t = useT();
  const preTokens = useAuiState((s) => {
    const part = s.message.parts[0] as { data?: { preTokens?: number } } | undefined;
    return part?.data?.preTokens;
  });
  return (
    <MessageAnchor className="flex flex-col">
      <CompactedDivider preTokens={preTokens} t={t} />
    </MessageAnchor>
  );
}

function makeAssistantMessage(agent: string, label: string): FC {
  return function AssistantMessage() {
    const note = useAuiState((s) => (s.message.metadata as { custom?: { note?: boolean } } | undefined)?.custom?.note === true);
    if (note) return <NoteMessage />;
    return (
      <MessageAnchor className="mb-4 flex flex-col gap-1">
        <ReplyHeader agent={agent} label={label} />
        <MessagePrimitive.Parts
          components={{
            Text: TextPart,
            Reasoning: ReasoningPart,
            tools: { Override: ToolCard as never },
            ToolGroup: ToolRun,
            data: { Fallback: TurnNote as never },
          }}
        />
        <MessagePrimitive.If hasContent={false}>
          <EmptyRunningReply />
        </MessagePrimitive.If>
      </MessageAnchor>
    );
  };
}

/** The closing line of a turn that was stopped or failed. */
const TurnNote: FC<{ data: unknown }> = ({ data }) => {
  const t = useT();
  const note = (data ?? {}) as { kind?: string; error?: string };
  if (note.kind === "interrupted") {
    return <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{t.chat_interrupted}</div>;
  }
  return (
    <div className="mt-1 rounded-lg border px-2.5 py-1.5 text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, transparent)", color: "var(--red)" }}>
      {note.error ?? t.chat_turn_failed}
    </div>
  );
};

/** Approvals the manager waits on, stuck above the composer. */
export function ApprovalCards({
  approvals,
  onAnswer,
  floating = false,
  glass = "",
}: {
  approvals: readonly PendingApproval[];
  onAnswer: (requestId: string, decision: ApprovalDecision) => void;
  /** Above the pill, over the canvas: the first request only, on glass. */
  floating?: boolean;
  glass?: string;
}) {
  const t = useT();
  if (approvals.length === 0) return null;
  const shown = floating ? approvals.slice(0, 1) : approvals;
  return (
    <div className={floating ? "flex w-full flex-col" : "flex flex-col gap-2 px-3 pb-2"}>
      {shown.map((a) => {
        const input = (typeof a.input === "object" && a.input !== null ? a.input : {}) as Record<string, unknown>;
        const what = typeof input.command === "string" ? input.command : subjectOf(input) || JSON.stringify(a.input).slice(0, 200);
        return (
          <div
            key={a.requestId}
            role="alertdialog"
            aria-label={t.chat_approval_title(toolVerb(a.toolName))}
            className={`rounded-xl border px-3 pb-3 pt-2.5 ${floating ? `tc-enter-fade-up ${glass}` : ""}`}
            style={{
              borderColor: "color-mix(in srgb, var(--amber) 50%, transparent)",
              ...(floating
                ? { borderRadius: 16, cornerShape: "squircle" }
                : { background: "color-mix(in srgb, var(--amber) 6%, transparent)" }),
            }}
          >
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--amber)" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2l5.5 2.5v3.5c0 3.2-2.4 5.3-5.5 6-3.1-.7-5.5-2.8-5.5-6V4.5z" />
              </svg>
              {t.chat_approval_title(toolVerb(a.toolName))}
              {floating && approvals.length > 1 && (
                <span className="ml-auto text-[11px] text-[var(--text-muted)]">{t.chat_approval_more(approvals.length - 1)}</span>
              )}
            </div>
            <pre className="tc-mono mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 py-2 text-[11.5px] text-[var(--text-primary)]">
              {what}
            </pre>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button type="button" className="h-8 rounded-[9px] px-3 text-[12px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }} onClick={() => onAnswer(a.requestId, "allow_once")}>
                {t.chat_approval_allow_once}
              </button>
              <button type="button" className="tc-rail-btn h-8 border border-[var(--border-hover)] px-3 text-[12px] text-[var(--text-primary)]" onClick={() => onAnswer(a.requestId, "allow_always")}>
                {t.chat_approval_allow_always}
              </button>
              <button type="button" className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)]" onClick={() => onAnswer(a.requestId, "deny")}>
                {t.chat_approval_deny}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChatThread({
  transcript,
  agent,
  onSend,
  onCancel,
  replyLabel: replyLabelOverride,
}: {
  transcript: ChatTranscript;
  agent: string;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  /** Who the replies are from; the manager's chat says "· manager". */
  replyLabel?: string;
}) {
  const t = useT();
  const messages = useMemo(() => toThreadMessages(transcript.messages), [transcript.messages]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: messages as unknown as ThreadMessageLike[],
    convertMessage: (m) => m,
    isRunning: transcript.running,
    onNew: async (message) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (text) await onSend(text);
    },
    onCancel,
  });
  const agentName = findAgentAdapter(agent)?.displayName ?? agent;
  const replyLabel = replyLabelOverride ?? t.chat_from_manager(agentName.split(" ")[0]);
  const AssistantMessage = useMemo(() => makeAssistantMessage(agent, replyLabel), [agent, replyLabel]);
  // Sent, and nothing back yet: the agent's first event makes the reply.
  const last = transcript.messages[transcript.messages.length - 1];
  const awaitingReply = last?.role === "user" && !transcript.failure;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <ThreadPrimitive.Empty>
            <div className="py-8 text-center text-[12.5px] text-[var(--text-muted)]">{t.chat_empty}</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {awaitingReply && <PendingReply agent={agent} label={replyLabel} />}
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
