import { Children, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC, type PropsWithChildren } from "react";
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
import { createdTaskId, spawnedTerminalId, taskTool, toolRunSummary, isAwaitingReply, toThreadMessages, workerSpawn, type TaskToolView } from "./threadMessages";
import { askedView, isAskedTool, type AskedView } from "./askedModel";
import { usePinStore } from "../../stores/pinStore";
import { openPinFull } from "../../tasks/TasksView";
import { parseAnswerMessage } from "../../tasks/taskModel";
import { parsePinStatus } from "../../../shared/pin";
import { statusLabel } from "../../tasks/TaskParts";
import { findTerminal } from "../../actions/terminalLookup";
import { linkNodeIds, NODE_CHIP_HREF, type NodeDescription } from "../sessionReaderModel";
import { todoPlan } from "../../../shared/chat-stream-claude";
import { CompactedDivider, PlanSteps } from "./LongRunning";
import { SentAttachments } from "./Attachments";

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

/**
 * The agent's questions, kept in the thread once answered (as Claude Code
 * and Codex keep them): each question and what was said to it, and what
 * it offered behind Show options.
 */
function AskedCard({ props, view, t }: { props: ToolCardProps; view: AskedView; t: Dict }) {
  const [showOptions, setShowOptions] = useState(false);
  const status = statusOf(props);
  const total = view.questions.length;
  const state = view.settled
    ? view.answered === 0
      ? t.chat_question_skipped
      : t.chat_question_answered_count(view.answered, total)
    : status === "running"
      ? t.chat_question_waiting_short
      : t.chat_question_not_answered;
  const hasOptions = view.questions.some((q) => q.options.length > 0);
  return (
    <div className="my-1 flex flex-col gap-2 rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] px-3 py-2.5">
      <span className="flex items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
        {t.chat_question_asked}
        <span className="text-[11.5px] text-[var(--text-muted)]">· {state}</span>
        {view.settled && view.answered > 0 && (
          <span className="ml-auto">
            <StatusMark status="done" />
          </span>
        )}
      </span>
      {view.questions.map((q) => (
        <span key={q.id} className="flex flex-col gap-1 text-[12px] leading-snug">
          <span className="text-[var(--text-secondary)]">{q.question}</span>
          {q.answer.length > 0 ? (
            <span className="text-[var(--text-primary)]">→ {q.secret ? "••••••" : q.answer.join(", ")}</span>
          ) : (
            view.settled && <span className="text-[11.5px] text-[var(--text-muted)]">{t.chat_question_skipped}</span>
          )}
          {showOptions && q.options.length > 0 && (
            <span className="ml-1 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
              {q.options.map((o) => {
                const picked = q.answer.includes(o.label);
                return (
                  <span key={o.label} className={picked ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                    {picked ? "✓ " : ""}
                    {o.label}
                    {o.description && <span className="text-[var(--text-faint)]"> — {o.description}</span>}
                  </span>
                );
              })}
            </span>
          )}
        </span>
      ))}
      {hasOptions && (
        <button
          type="button"
          className="self-start text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => setShowOptions((v) => !v)}
          aria-expanded={showOptions}
        >
          {showOptions ? t.chat_question_hide_options : t.chat_question_show_options}
        </button>
      )}
    </div>
  );
}

/** Opens a task by id, wherever it is. */
function openTaskById(id: string): void {
  const pin = Object.values(usePinStore.getState().pinsByProject)
    .flat()
    .find((p) => p.id === id);
  if (pin) openPinFull(pin);
}

/**
 * The task tools read as what they did: a task made, a question asked
 * (kept in view, with its choices), the task moved on, the list read.
 */
function TaskToolCard({ props, view, t }: { props: ToolCardProps; view: TaskToolView; t: Dict }) {
  const status = statusOf(props);
  const taskIcon = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4l1.2 1.2L6 3M2.5 8l1.2 1.2L6 7M2.5 12h0.01M8 4h5.5M8 8h5.5M8 12h5.5" />
    </svg>
  );
  if (view.kind === "create" || view.kind === "ask") {
    const id = view.kind === "create" ? createdTaskId(typeof props.result === "string" ? props.result : undefined) : view.taskId;
    const ask = view.kind === "ask";
    return (
      <div
        className="my-1 flex flex-col gap-1.5 rounded-[10px] border px-3 py-2.5"
        style={{ borderColor: ask ? "color-mix(in srgb, var(--amber) 35%, transparent)" : "var(--border)", background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
      >
        <span className="flex items-center gap-2 text-[12.5px]">
          <span className="text-[var(--text-muted)]">{taskIcon}</span>
          <span className="min-w-0 flex-1 text-[var(--text-primary)]">
            {ask ? t.chat_task_asked : t.chat_task_made}
            {view.kind === "create" && view.title && <span className="text-[var(--text-secondary)]"> · {view.title}</span>}
          </span>
          {view.kind === "create" && view.steps > 0 && <span className="text-[11.5px] text-[var(--text-muted)]">{t.chat_task_steps(view.steps)}</span>}
          <StatusMark status={status} />
          {id && (
            <button
              type="button"
              className="tc-rail-btn shrink-0 border border-[var(--border)] px-2 py-0.5 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => openTaskById(id)}
            >
              {t.chat_task_open}
            </button>
          )}
        </span>
        {ask && view.question && <span className="pl-[22px] text-[12.5px] leading-snug" style={{ color: "var(--amber)" }}>{view.question}</span>}
        {ask && view.choices.length > 0 && (
          <span className="flex flex-wrap gap-1 pl-[22px]">
            {view.choices.map((c) => (
              <span key={c} className="rounded-full border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)]">
                {c}
              </span>
            ))}
          </span>
        )}
      </div>
    );
  }
  const detail =
    view.kind === "list"
      ? null
      : [
          view.total > 0 ? t.chat_task_progress(view.done, view.total) : null,
          view.status && parsePinStatus(view.status) ? statusLabel(parsePinStatus(view.status)!, t) : null,
          view.notes ? t.chat_task_notes : null,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <div className="my-0.5 flex items-center gap-1.5 py-0.5 text-[12px]">
      <span className="text-[var(--text-faint)]">{taskIcon}</span>
      <span className="text-[var(--text-secondary)]">{view.kind === "list" ? t.chat_task_read : t.chat_task_updated}</span>
      {detail && <span className="min-w-0 truncate text-[var(--text-muted)]">{detail}</span>}
      <span className="ml-auto shrink-0 pl-2"><StatusMark status={status} /></span>
    </div>
  );
}

const ToolCard: FC<ToolCardProps> = (props) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const spawn = workerSpawn(props.toolName, props.args);
  if (spawn) return <WorkerCard props={props} spawn={spawn} t={t} />;
  const taskView = taskTool(props.toolName, props.args);
  if (taskView) return <TaskToolCard props={props} view={taskView} t={t} />;
  const asked = askedView(props.toolName, props.args, props.result);
  if (asked) return <AskedCard props={props} view={asked} t={t} />;
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
  // Kept in view while folded: workers started, and a task made or a question asked.
  const isWorker = (p: RunPart | undefined) => {
    if (!p?.toolName) return false;
    if (workerSpawn(p.toolName, p.args ?? {}) !== null || isAskedTool(p.toolName)) return true;
    const view = taskTool(p.toolName, p.args ?? {});
    return view?.kind === "create" || view?.kind === "ask";
  };
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

/** What the person wrote; an answer sent from a task reads as just the answer. */
const UserText: FC<{ text: string }> = ({ text }) => {
  const t = useT();
  const answer = parseAnswerMessage(text);
  if (!answer) return <>{text}</>;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[11px] text-[var(--text-muted)]">{answer.question ? t.chat_task_answer_to(answer.question) : t.chat_task_answer_on(answer.title)}</span>
      <span>{answer.answer}</span>
    </span>
  );
};

/** Sent while a turn ran: said above the message, since it changed that turn. */
function SteeredLabel() {
  const t = useT();
  const steered = useAuiState((s) => (s.message.metadata as { custom?: { steered?: boolean } } | undefined)?.custom?.steered === true);
  return steered ? <div className="mb-1 w-full text-right text-[11px] text-[var(--text-muted)]">{t.chat_steered}</div> : null;
}

/** The text, when there is any: a message can be only files. */
function UserBubble() {
  const hasText = useAuiState((s) => s.message.content.length > 0);
  if (!hasText) return null;
  return (
    <div
      className="max-w-[86%] whitespace-pre-wrap break-words border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 text-[var(--text-primary)]"
      style={{ fontSize: "var(--text-sm)", borderRadius: "12px 12px 4px 12px", lineHeight: 1.5 }}
    >
      <MessagePrimitive.Parts components={{ Text: UserText }} />
    </div>
  );
}

const UserMessage: FC = () => (
  <MessageAnchor className="mb-3 flex flex-col items-end">
    <SteeredLabel />
    <SentAttachments />
    <UserBubble />
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
  const part = useAuiState((s) => s.message.parts[0] as { type?: string; data?: { preTokens?: number; text?: string } } | undefined);
  return (
    <MessageAnchor className="flex flex-col">
      {part?.type === "data-briefing" ? <BriefingLine text={part.data?.text ?? ""} /> : <CompactedDivider preTokens={part?.data?.preTokens} t={t} />}
    </MessageAnchor>
  );
}

/** The role briefing Tacit sent when the agent took the seat: a line, opened to read it. */
function BriefingLine({ text }: { text: string }) {
  const t = useT();
  return (
    <details className="group mb-4 text-[11.5px] text-[var(--text-muted)]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-[var(--text-secondary)]">
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" className="transition-transform group-open:rotate-90" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        {t.chat_briefing_sent}
      </summary>
      <div className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[9px] border border-[var(--border)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {text}
      </div>
    </details>
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

/**
 * How a plan goes on, in each agent's own modes: making changes, or asking
 * first. OpenCode has the one mode to work in (Build; what it asks is its
 * settings'), so its plan has the one way to start.
 */
const PLAN_GO_MODES: Record<string, { go: string; ask?: string }> = {
  claude: { go: "acceptEdits", ask: "default" },
  codex: { go: "auto", ask: "read-only" },
  opencode: { go: "build" },
};

/**
 * A plan the agent is ready to start on. Keep planning opens a box for
 * what should change: the agent stays in plan mode and revises with it,
 * or, left empty, asks what to change. Enter sends; Esc goes back.
 */
function PlanCard({
  plan,
  floating,
  glass,
  onGo,
  canAsk,
  onKeepPlanning,
}: {
  plan: string;
  floating: boolean;
  glass: string;
  onGo: (how: "go" | "ask") => void;
  /** Whether there's a mode that asks before edits to start in; without one there's a single Yes. */
  canAsk: boolean;
  onKeepPlanning: (note: string | undefined) => void;
}) {
  const t = useT();
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState("");
  const send = () => onKeepPlanning(note.trim() || undefined);
  return (
    <div
      role="alertdialog"
      aria-label={t.chat_plan_ready}
      className={`rounded-xl border px-3 pb-3 pt-2.5 ${floating ? `tc-enter-fade-up ${glass}` : ""}`}
      style={{ borderColor: "color-mix(in srgb, var(--cyan) 45%, transparent)", ...(floating ? { borderRadius: 16 } : { background: "color-mix(in srgb, var(--cyan) 5%, transparent)" }) }}
    >
      <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.chat_plan_ready}</div>
      {plan && (
        <div
          className={`${markdownClassName} mt-2 max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-3 py-2`}
          style={{ fontSize: "var(--text-sm)" }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }}
        />
      )}
      {keeping ? (
        <div className="mt-2.5">
          <textarea
            autoFocus
            rows={2}
            value={note}
            placeholder={t.chat_plan_change_placeholder}
            aria-label={t.chat_plan_change_placeholder}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // The canvas listens globally for single-key shortcuts.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setKeeping(false);
              }
            }}
            className="block max-h-32 w-full resize-none rounded-lg border border-[var(--border-hover)] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" className="h-8 rounded-[9px] px-3 text-[12px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }} onClick={send}>
              {t.chat_plan_keep}
            </button>
            <button type="button" className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)]" onClick={() => setKeeping(false)}>
              {t.chat_plan_back}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" className="h-8 rounded-[9px] px-3 text-[12px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }} onClick={() => onGo("go")}>
            {canAsk ? t.chat_plan_go_accept : t.chat_plan_go}
          </button>
          {canAsk && (
            <button type="button" className="tc-rail-btn h-8 border border-[var(--border-hover)] px-3 text-[12px] text-[var(--text-primary)]" onClick={() => onGo("ask")}>
              {t.chat_plan_go_ask}
            </button>
          )}
          <button type="button" className="tc-rail-btn h-8 border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)]" onClick={() => setKeeping(true)}>
            {t.chat_plan_keep}
          </button>
        </div>
      )}
    </div>
  );
}

/** Approvals the manager waits on, stuck above the composer. */
export function ApprovalCards({
  approvals,
  onAnswer,
  floating = false,
  glass = "",
  onPlanMode,
  agent = "claude",
}: {
  approvals: readonly PendingApproval[];
  /** `note`: keeping on planning, what the person would change. */
  onAnswer: (requestId: string, decision: ApprovalDecision, note?: string) => void;
  /** Above the pill, over the canvas: the first request only, on glass. */
  floating?: boolean;
  glass?: string;
  /** A plan accepted with how to go on: the mode to work in from here. */
  onPlanMode?: (mode: string) => void;
  /** Whose modes a plan goes on in: Claude's accept-edits or ask, Codex's auto or read-only. */
  agent?: string;
}) {
  const t = useT();
  if (approvals.length === 0) return null;
  const shown = floating ? approvals.slice(0, 1) : approvals;
  return (
    <div className={floating ? "flex w-full flex-col" : "flex flex-col gap-2 px-3 pb-2"}>
      {shown.map((a) => {
        const input = (typeof a.input === "object" && a.input !== null ? a.input : {}) as Record<string, unknown>;
        // A plan, done in plan mode: start on it, and how, or keep planning.
        if (a.toolName === "ExitPlanMode") {
          return (
            <PlanCard
              key={a.requestId}
              plan={typeof input.plan === "string" ? input.plan : ""}
              floating={floating}
              glass={glass}
              canAsk={PLAN_GO_MODES[agent]?.ask !== undefined}
              onGo={(how) => {
                onAnswer(a.requestId, "allow_once");
                const modes = PLAN_GO_MODES[agent];
                onPlanMode?.((how === "ask" ? modes?.ask : modes?.go) ?? (how === "go" ? "acceptEdits" : "default"));
              }}
              onKeepPlanning={(note) => onAnswer(a.requestId, "deny", note)}
            />
          );
        }
        // A command as it will run; access asked for as its summary; else the subject.
        const what =
          typeof input.command === "string" ? input.command : typeof input.summary === "string" ? input.summary : subjectOf(input) || JSON.stringify(a.input).slice(0, 200);
        return (
          <div
            key={a.requestId}
            role="alertdialog"
            aria-label={a.toolName === "Permissions" ? t.chat_approval_permissions : t.chat_approval_title(toolVerb(a.toolName))}
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
              {a.toolName === "Permissions" ? t.chat_approval_permissions : t.chat_approval_title(toolVerb(a.toolName))}
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

/** How many of the latest messages a thread draws at first, and how many more each "Show earlier" adds. */
const THREAD_PAGE = 40;

export function ChatThread({
  transcript,
  agent,
  onSend,
  onCancel,
  replyLabel: replyLabelOverride,
  reveal,
  emptyText,
}: {
  transcript: ChatTranscript;
  agent: string;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  /** What an empty chat says; the manager's own words by default. */
  emptyText?: string;
  /** Who the replies are from; the manager's chat says "· manager". */
  replyLabel?: string;
  /** A message to scroll to, drawing the earlier ones down to it first; `seq` asks again for the same one. */
  reveal?: { id: string; seq: number } | null;
}) {
  const t = useT();
  const all = useMemo(() => toThreadMessages(transcript.messages), [transcript.messages]);
  // A long session runs to a thousand messages and more: drawing them all
  // at once holds the app up, so the thread starts from the latest.
  const [shown, setShown] = useState(THREAD_PAGE);
  const start = Math.max(0, all.length - shown);
  const messages = useMemo(() => (start > 0 ? all.slice(start) : all), [all, start]);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Earlier messages drawn above keep what you were reading in place.
  const keepFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && keepFrom.current !== null) viewport.scrollTop += viewport.scrollHeight - keepFrom.current;
    keepFrom.current = null;
  }, [start]);
  const showEarlier = () => {
    keepFrom.current = viewportRef.current?.scrollHeight ?? null;
    setShown((n) => n + THREAD_PAGE);
  };
  useEffect(() => {
    if (!reveal) return;
    const index = all.findIndex((m) => m.id === reveal.id);
    if (index < 0) return;
    if (index < start) setShown(all.length - index);
    // After the frame that draws it.
    const frame = requestAnimationFrame(() =>
      viewportRef.current?.querySelector(`[data-msg-id="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.id, reveal?.seq, start]);
  // Sent (or briefed), and nothing back yet: the agent's first event makes
  // the reply. Until then the waiting row is ours alone; the runtime isn't
  // told it's running, or it would draw a second empty reply of its own.
  const awaitingReply = isAwaitingReply(transcript);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: messages as unknown as ThreadMessageLike[],
    convertMessage: (m) => m,
    isRunning: transcript.running && !awaitingReply,
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          {start > 0 && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                className="tc-rail-btn h-7 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                onClick={showEarlier}
              >
                {t.chat_show_earlier(start)}
              </button>
            </div>
          )}
          <ThreadPrimitive.Empty>
            <div className="py-8 text-center text-[12.5px] text-[var(--text-muted)]">{emptyText ?? t.chat_empty}</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {awaitingReply && <PendingReply agent={agent} label={replyLabel} />}
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
