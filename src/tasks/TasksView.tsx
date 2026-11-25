import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearTaskToasts } from "../attention/attentionToasts";
import { useT } from "../i18n/useT";
import { Dropdown, Segmented } from "../components/ui/parts";
import type { Task } from "../types";
import { columnOf, type Column, type RequestKind } from "../../shared/task";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useProjectStore } from "../stores/projectStore";
import { AgentLoad, AgentMark } from "./HandOver";
import type { CanvasRequest } from "../../shared/canvas-ops";
import { BoardAskCard } from "../board/CanvasAskCard";
import { useCanvasRequestStore } from "../board/canvasRequests";
import { useCanvasRequestsByTask, useWaitingItems } from "../attention/waiting";
import { AgentWaitCard } from "./AgentWaitCard";
import { shownColumn } from "../attention/waitingCount";
import { changeTask, handOver, newTask, openTask } from "./taskActions";
import { NewTask } from "./NewTask";
import { Dot, TASK_DRAG, TaskCard, useFolderName } from "./TaskCard";
import { TaskPage } from "./TaskPage";
import { useTask, useTasks, useTaskStore } from "./taskStore";
import { matches, runLines, sortRequests } from "./taskWords";
import { useAgents, type AgentChoice } from "./useAgents";
import "./tasks.css";

const COLUMNS: readonly Column[] = ["later", "next", "working", "needs", "done"];
const REASONS: readonly RequestKind[] = ["decide", "allow", "approve", "stuck", "check"];
/**
 * A column is never narrower than its cards can be read at: short of room, the
 * board scrolls sideways. An empty one gives its room to the rest. What needs
 * you has the most to show.
 */
const width = (column: Column, empty: boolean) => (empty ? "minmax(132px, 0.6fr)" : column === "needs" ? "minmax(316px, 1.4fr)" : "minmax(236px, 1fr)");
/** Done piles up; the newest are what you look at. */
const DONE_SHOWN = 30;

/**
 * The workdesk's tasks (docs/architecture/task-board.md): the board, one
 * task's page over it, or a new one. In the pane on the canvas, a tab in the
 * grid.
 */
export function TasksView() {
  const openId = useTaskStore((s) => s.openTask);
  const composing = useTaskStore((s) => s.composing);
  const workdesk = useCanvasRegistryStore((s) => s.activeCanvasId);
  const open = useTask(openId);
  const here = open && open.workdesk === workdesk ? open : null;
  useEffect(() => {
    void window.tacit.tasks.landed(workdesk);
    clearTaskToasts();
  }, [workdesk]);
  if (composing)
    return (
      <div className="tc-tk-scroll">
        <NewTask from={composing} />
      </div>
    );
  if (here) return <TaskPage key={here.id} task={here} onBack={() => useTaskStore.getState().open(null)} />;
  return <Board />;
}

function Board() {
  const t = useT();
  const tasks = useTasks();
  const workdesk = useCanvasRegistryStore((s) => s.activeCanvasId);
  const loaded = useTaskStore((s) => s.loaded);
  const view = useTaskStore((s) => s.view);
  const query = useTaskStore((s) => s.query);
  const folder = useTaskStore((s) => s.folder);
  const showDropped = useTaskStore((s) => s.showDropped);
  const { setView, setQuery, setFolder, setShowDropped } = useTaskStore.getState();
  const projects = useProjectStore((s) => s.projects);
  const [reason, setReason] = useState<RequestKind | null>(null);
  const dragging = useTaskStore((s) => s.dragging);
  const setDragging = (id: string | null) => useTaskStore.setState({ dragging: id });
  const [pending, setPending] = useState<{ task: Task; agent: AgentChoice } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // What agents ask to change on the canvas: on the card of the task its agent
  // was on when it asked, else a card of its own, though it's not a task.
  const { byTask, alone: asks } = useCanvasRequestsByTask(tasks);
  // A task is found by what's on its card, its drawing requests included.
  const shown = useMemo(
    () => tasks.filter((x) => matches(x, query, folder) || (matches(x, "", folder) && (byTask.get(x.id) ?? []).some((r) => askMatches(r, query)))),
    [tasks, query, folder, byTask],
  );
  // A drawing request is something to approve.
  const has = (x: Task, kind: RequestKind) => x.requests.some((r) => r.kind === kind) || (kind === "approve" && byTask.has(x.id));
  const by = useMemo(() => {
    const out = new Map<Column, Task[]>();
    for (const x of shown) {
      const c = shownColumn(x, byTask.has(x.id));
      if (c === "needs" && reason && !has(x, reason)) continue;
      out.set(c, [...(out.get(c) ?? []), x]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reason, byTask]);
  const requests = useMemo(() => {
    if (folder !== null || (reason && reason !== "approve")) return [];
    return query.trim() ? asks.filter((x) => askMatches(x, query)) : asks;
  }, [asks, folder, reason, query]);
  // Agents waiting on you that aren't on a task: a card each, answered there or in their terminal.
  const waitingHere = useWaitingItems().get(workdesk);
  const agentsWaiting = useMemo(() => (waitingHere ?? []).flatMap((x) => (x.kind === "agent" ? [x.terminalId] : [])), [waitingHere]);
  const agents = folder !== null || query.trim() || (reason && reason !== "allow") ? NO_AGENTS : agentsWaiting;
  const reasons = REASONS.map((k) => ({ kind: k, n: shown.filter((x) => shownColumn(x, byTask.has(x.id)) === "needs" && has(x, k)).length + (k === "approve" && folder === null ? asks.length : 0) + (k === "allow" && folder === null ? agentsWaiting.length : 0) })).filter((r) => r.n > 0);
  // Brought here to see one request: nothing you'd narrowed the board to hides it.
  const showing = useCanvasRequestStore((s) => s.shown);
  useEffect(() => {
    if (showing) setReason(null);
  }, [showing]);
  // Its last one was answered: back to all of them, not an empty column.
  useEffect(() => {
    if (reason && !reasons.some((r) => r.kind === reason)) setReason(null);
  });
  const dropped = tasks.some((x) => columnOf(x) === "dropped");
  const columns = showDropped && dropped ? [...COLUMNS, "dropped" as const] : COLUMNS;
  const folders = [
    { value: "all", label: t.tb.allFolders },
    ...projects.map((p) => ({ value: p.path, label: p.name, detail: p.path })),
    ...(tasks.some((x) => x.folder === null) ? [{ value: "none", label: t.tb.noFolder }] : []),
  ];
  const give = async (task: Task, agent: AgentChoice) => {
    const result = await handOver(task, agent.id);
    if (result === "busy") setPending({ task, agent });
  };
  const list = view === "list" || narrow;
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div className="tc-tk-head">
        <label className="contents">
          <span className="sr-only">{t.tb.search}</span>
          <input className="tc-tk-input w-[150px] min-w-0 shrink" value={query} placeholder={t.tb.search} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()} />
        </label>
        {folders.length > 2 && <Dropdown label={t.tb.folder} value={folder === null ? "all" : folder === "" ? "none" : folder} options={folders} onChange={(v) => setFolder(v === "all" ? null : v === "none" ? "" : v)} />}
        <span className="flex-1" />
        {dropped && (
          <button type="button" className="tc-tk-btn" data-quiet="true" aria-pressed={showDropped} onClick={() => setShowDropped(!showDropped)}>
            {showDropped ? t.tb.hideDropped : t.tb.showDropped}
          </button>
        )}
        {!narrow && (
          <Segmented
            label={t.tb.viewLabel}
            value={view}
            options={[
              { value: "board", label: t.tb.board },
              { value: "list", label: t.tb.list },
            ]}
            onChange={setView}
          />
        )}
        <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => newTask(folder ? { folder } : {})}>
          {t.tb.add}
        </button>
      </div>
      {loaded && tasks.length === 0 && asks.length === 0 && agents.length === 0 ? (
        <p className="tc-tk-empty-board">{t.tb.emptyBoard}</p>
      ) : loaded && shown.length === 0 && requests.length === 0 && agents.length === 0 ? (
        <p className="tc-tk-empty-board">{t.tb.noneMatch}</p>
      ) : list ? (
        <List columns={columns} by={by} requests={requests} agents={agents} reason={reason} reasons={reasons} setReason={setReason} onDrag={setDragging} />
      ) : (
        <Columns template={columns.map((c) => width(c, !by.get(c)?.length && !(c === "needs" && requests.length))).join(" ")}>
          {columns.map((c) => (
            <ColumnView key={c} column={c} tasks={by.get(c) ?? []} requests={c === "needs" ? requests : NONE} agents={c === "needs" ? agents : NO_AGENTS} dragging={dragging} reason={reason} reasons={reasons} setReason={setReason} onDrag={setDragging} />
          ))}
        </Columns>
      )}
      {(dragging || pending) && (
        <Tray
          pending={pending}
          onDrop={(agent, id) => {
            const task = tasks.find((x) => x.id === id);
            setDragging(null);
            if (task) void give(task, agent);
          }}
          onChoose={(how) => {
            if (pending && how) void handOver(pending.task, pending.agent.id, { how });
            setPending(null);
          }}
        />
      )}
    </div>
  );
}

/** The columns, scrolling sideways when they don't all fit, with an edge that says there's more. */
function Columns({ template, children }: { template: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const look = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setMore((was) => (was.left === left && was.right === right ? was : { left, right }));
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(look);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(look, [template]);
  return (
    <div className="tc-tk-columns-frame" data-more-left={more.left || undefined} data-more-right={more.right || undefined}>
      <div ref={ref} className="tc-tk-columns" style={{ gridTemplateColumns: template }} onScroll={look}>
        {children}
      </div>
    </div>
  );
}

const NONE: CanvasRequest[] = [];
const NO_AGENTS: readonly string[] = [];

/** A drawing request found by its agent's name or the drawings' names. */
const askMatches = (r: CanvasRequest, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !q || [r.name, ...r.titles].some((w) => w.toLowerCase().includes(q));
};

interface ColumnProps {
  requests: CanvasRequest[];
  /** Agents on no task waiting on you: Needs you only. */
  agents: readonly string[];
  reason: RequestKind | null;
  reasons: Array<{ kind: RequestKind; n: number }>;
  setReason: (reason: RequestKind | null) => void;
  onDrag: (id: string | null) => void;
}

/** Nothing is dragged into Needs you, and Working starts at an agent. */
const ACCEPTS: ReadonlySet<Column> = new Set(["later", "next", "done", "dropped"]);

function ColumnView({ column, tasks, requests, agents, dragging, reason, reasons, setReason, onDrag }: ColumnProps & { column: Column; tasks: Task[]; dragging: string | null }) {
  const t = useT();
  const [over, setOver] = useState(false);
  const all = useTaskStore((s) => s.tasks);
  const accepts = ACCEPTS.has(column);
  const held = dragging ? all[dragging] : null;
  const drop = (id: string) => {
    const task = all[id];
    if (!task || columnOf(task) === column) return;
    if (column === "done") void changeTask(task, { op: "accept" });
    else if (column === "dropped") void changeTask(task, { op: "drop" });
    else if (task.closed) void changeTask(task, { op: "reopen" }).then((back) => (back && column === "later" ? changeTask(back, { op: "wait", wait: "later" }) : null));
    else void changeTask(task, { op: "wait", wait: column as "later" | "next" });
  };
  return (
    <section
      className="tc-tk-column"
      aria-label={t.tb.columns[column]}
      data-over={over && accepts ? "true" : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
        setOver(true);
        if (!accepts) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(TASK_DRAG);
        if (!id || !accepts) return;
        e.preventDefault();
        drop(id);
      }}
    >
      <header className="tc-tk-column-head">
        <Dot column={column} />
        <h3>{t.tb.columns[column]}</h3>
        <span className="tc-tk-count">{tasks.length + requests.length + agents.length}</span>
        <span className="flex-1" />
        {(column === "later" || column === "next") && (
          <button type="button" className="tc-tk-add" aria-label={t.tb.addTo(t.tb.columns[column])} title={t.tb.addTo(t.tb.columns[column])} onClick={() => newTask({ wait: column })}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}
      </header>
      {column === "needs" && reasons.length > 1 && <Reasons reason={reason} reasons={reasons} setReason={setReason} />}
      <div className="tc-tk-column-body">
        {held && over && !accepts && columnOf(held) !== column && <p className="tc-tk-hint">{column === "needs" ? t.tb.cantDropHere.needs : t.tb.cantDropHere.working}</p>}
        {agents.map((id) => (
          <AgentWaitCard key={id} terminalId={id} />
        ))}
        {requests.map((x) => (
          <BoardAskCard key={x.id} request={x} />
        ))}
        {tasks.slice(0, column === "done" || column === "dropped" ? DONE_SHOWN : undefined).map((x) => (
          <TaskCard key={x.id} task={x} reason={column === "needs" ? reason : null} onDrag={onDrag} />
        ))}
        {tasks.length === 0 && requests.length === 0 && agents.length === 0 && <p className="tc-tk-empty">{t.tb.empty[column]}</p>}
      </div>
    </section>
  );
}

function Reasons({ reason, reasons, setReason }: Pick<ColumnProps, "reason" | "reasons" | "setReason">) {
  const t = useT();
  return (
    <div role="group" aria-label={t.tb.columns.needs} className="flex flex-wrap gap-1 px-0.5 pb-2">
      <button type="button" className="tc-tk-pill" data-small="true" aria-pressed={reason === null} onClick={() => setReason(null)}>
        {t.tb.all}
      </button>
      {reasons.map((r) => (
        <button key={r.kind} type="button" className="tc-tk-pill" data-small="true" aria-pressed={reason === r.kind} onClick={() => setReason(reason === r.kind ? null : r.kind)}>
          {t.tb.reasons[r.kind]} {r.n}
        </button>
      ))}
    </div>
  );
}

function List({ columns, by, requests, agents, reason, reasons, setReason, onDrag }: ColumnProps & { columns: readonly Column[]; by: Map<Column, Task[]> }) {
  const t = useT();
  // What needs you first, when there isn't room to see it all.
  const order = [...columns].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return (
    <div className="tc-tk-scroll px-3 pb-4">
      {order.map((c) => {
        const tasks = by.get(c) ?? [];
        const asks = c === "needs" ? requests : NONE;
        const waiting = c === "needs" ? agents : NO_AGENTS;
        if (tasks.length === 0 && asks.length === 0 && waiting.length === 0) return null;
        return (
          <section key={c} className="mb-4" aria-label={t.tb.columns[c]}>
            <header className="tc-tk-column-head">
              <Dot column={c} />
              <h3>{t.tb.columns[c]}</h3>
              <span className="tc-tk-count">{tasks.length + asks.length + waiting.length}</span>
            </header>
            {c === "needs" && reasons.length > 1 && <Reasons reason={reason} reasons={reasons} setReason={setReason} />}
            {c === "needs" ? (
              <div className="flex flex-col gap-2">
                {waiting.map((id) => (
                  <AgentWaitCard key={id} terminalId={id} />
                ))}
                {asks.map((x) => (
                  <BoardAskCard key={x.id} request={x} />
                ))}
                {tasks.map((x) => (
                  <TaskCard key={x.id} task={x} reason={reason} onDrag={onDrag} />
                ))}
              </div>
            ) : (
              tasks.slice(0, c === "done" || c === "dropped" ? DONE_SHOWN : undefined).map((x) => <ListRow key={x.id} task={x} onDrag={onDrag} />)
            )}
          </section>
        );
      })}
    </div>
  );
}
const ORDER: readonly Column[] = ["needs", "working", "next", "later", "done", "dropped"];

function ListRow({ task, onDrag }: { task: Task; onDrag: (id: string | null) => void }) {
  const t = useT();
  const folder = useFolderName(task.folder);
  const runs = runLines(task);
  const note = sortRequests(task)[0]?.text ?? (runs.length ? `${runs[0].name}, ${(runs[0].waits ? t.tb.waitsForYou : t.tb.runs[runs[0].state])}${runs.length > 1 ? ` +${runs.length - 1}` : ""}` : (task.closed?.how ?? ""));
  return (
    <button
      type="button"
      className="tc-tk-row"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_DRAG, task.id);
        onDrag(task.id);
      }}
      onDragEnd={() => onDrag(null)}
      onClick={() => openTask(task.id)}
    >
      <span className="tc-tk-id">{`T-${task.n}`}</span>
      <span className="min-w-0 truncate text-[var(--text-primary)]">
        {task.closed && !task.seen && <span className="tc-tk-unseen mr-1.5 inline-block" title={t.tb.unseen} aria-label={t.tb.unseen} />}
        {task.title}
      </span>
      <span className="truncate">{folder}</span>
      <span className="truncate text-right">{note}</span>
    </button>
  );
}

/** The agents, while a card is held: where to drop it. */
function Tray({ pending, onDrop, onChoose }: { pending: { task: Task; agent: AgentChoice } | null; onDrop: (agent: AgentChoice, id: string) => void; onChoose: (how: "queue" | "interrupt" | null) => void }) {
  const t = useT();
  const agents = useAgents();
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="tc-tk-tray">
      {pending ? (
        <div role="group" aria-live="polite" className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[var(--text-primary)]">{t.tb.busy(pending.agent.name)}</span>
          <button type="button" autoFocus className="tc-tk-btn" data-strong="true" title={t.tb.queueHint} onClick={() => onChoose("queue")}>
            {t.tb.queue}
          </button>
          <button type="button" className="tc-tk-btn" title={t.tb.interruptHint} onClick={() => onChoose("interrupt")}>
            {t.tb.interrupt}
          </button>
          <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => onChoose(null)}>
            {t.tb.cancel}
          </button>
        </div>
      ) : (
        <>
          <span className="text-[13px] text-[var(--text-metadata)]">{agents.length ? t.tb.dropHere : t.tb.noAgents}</span>
          <div className="flex flex-wrap gap-1.5">
            {agents.map((a) => (
              <span
                key={a.id}
                className="tc-tk-target"
                data-over={over === a.id ? "true" : undefined}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TASK_DRAG)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setOver(a.id);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  onDrop(a, e.dataTransfer.getData(TASK_DRAG));
                }}
              >
                <AgentMark type={a.type} size={14} />
                {a.name}
                <AgentLoad agent={a} />
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
