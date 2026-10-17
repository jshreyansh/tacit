import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useIdentityStore } from "../stores/identityStore";
import { usePinStore } from "../stores/pinStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useChatDockStore, chatDockOffset } from "../stores/chatDockStore";
import { useManagerChatStore } from "../stores/managerChatStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { CHROME_GAP, CHROME_INSET, LEFT_RAIL_WIDTH } from "../stores/canvasStore";
import { TITLE_STRIP_HEIGHT } from "../toolbar/titleStripHeight";
import { agentIcon } from "../toolbar/agentIcons";
import { findAgentAdapter } from "../../shared/agent-adapters";
import { readTerminalTail } from "../terminal/terminalRegistry";
import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import type { ChatTranscript } from "../../shared/chat-transcript";
import { CanvasViewIcon, GridViewIcon } from "./viewIcons";
import { cleanTailLines } from "./terminalTail";
import { useBrowserSnapshots } from "./browserSnapshots";
import { WorkdeskTab } from "./WorkdeskTab";
import { STATUS_COLOR } from "../tasks/taskModel";
import { statusLabel, useOwnerView } from "../tasks/TaskParts";
import { createTask } from "../tasks/taskActions";
import {
  buildWorkdeskSections,
  minutesSince,
  type BrowserCard,
  type NoteCard,
  type TaskCard,
  type TerminalCard,
  type WorkdeskCard,
  type WorkdeskFilter,
} from "./workdeskModel";

/**
 * The workdesk view (T7): every node on the canvas on screen as a card, in
 * agents, browsers by profile, and terminals and notes, to the right of the
 * docked chat. Cards show live status and the last lines worth reading; a
 * card opens its node full size in the view's tabs.
 */

type Dict = ReturnType<typeof useT>;

const TAIL_ROWS = 40;
const TAIL_LINES = 6;
const TAIL_REFRESH_MS = 1500;

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10l3 2-3 2M12 14h4" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
    </svg>
  );
}

function StatusLabel({ card, now, t }: { card: TerminalCard; now: number; t: Dict }) {
  if (card.state === "active") {
    return (
      <span className="flex items-center gap-1.5" style={{ color: "var(--cyan)" }}>
        <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
        {t.workdesk_state_running(minutesSince(card.since, now))}
      </span>
    );
  }
  if (card.state === "attention") {
    const error = card.attentionReason === "error";
    return <span style={{ color: error ? "var(--red)" : "var(--amber)" }}>{error ? t.workdesk_state_error : t.workdesk_state_needs_you}</span>;
  }
  if (card.state === "done") return <span style={{ color: "var(--green)" }}>{t.workdesk_state_done}</span>;
  return <span className="text-[var(--text-faint)]">{t.workdesk_state_idle}</span>;
}

const cardCls =
  "group flex h-[196px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] text-left transition-[border-color,transform] duration-quick hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] active:scale-[0.99] motion-reduce:transition-none";
const headCls =
  "flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_35%,var(--surface))] px-2.5";

function lastReply(transcript: ChatTranscript | undefined): string[] {
  if (!transcript) return [];
  for (let i = transcript.messages.length - 1; i >= 0; i -= 1) {
    const m = transcript.messages[i];
    if (m.role !== "assistant") continue;
    const text = [...m.parts].reverse().find((p) => p.type === "text" && p.text.trim());
    if (text && text.type === "text") return cleanTailLines(text.text.split("\n"), TAIL_LINES);
  }
  return [];
}

function TerminalCardView({
  card,
  lines,
  now,
  t,
}: {
  card: TerminalCard;
  lines: string[];
  now: number;
  t: Dict;
}) {
  const icon = card.isAgent ? agentIcon(card.type) : null;
  const typeLabel = card.isAgent ? (findAgentAdapter(card.type)?.id ?? card.type) : card.type;
  return (
    <button
      type="button"
      className={cardCls}
      style={card.state === "attention" ? { borderColor: "color-mix(in srgb, var(--amber) 55%, transparent)" } : undefined}
      onClick={() => useWorkdeskViewStore.getState().setOpenNode({ kind: "terminal", id: card.id })}
    >
      <div className={headCls}>
        {icon ? (
          <img src={icon} alt="" className="h-4 w-4 shrink-0 object-contain" draggable={false} />
        ) : (
          <span className="flex shrink-0 text-[var(--text-muted)]"><ShellIcon /></span>
        )}
        <span className="tc-mono shrink-0 text-[12px] text-[var(--text-primary)]">{typeLabel}</span>
        {card.isManager && (
          <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-muted)]">
            {t.workdesk_manager_badge}
          </span>
        )}
        <span className="min-w-0 truncate text-[11.5px] text-[var(--text-muted)]">{card.title !== card.type ? card.title : card.subtitle}</span>
        <span className="ml-auto shrink-0 pl-1 text-[11px]"><StatusLabel card={card} now={now} t={t} /></span>
      </div>
      <div className="tc-mono min-h-0 flex-1 overflow-hidden px-3 py-2.5 text-[11px] leading-[1.65] text-[var(--text-muted)]">
        {card.title !== card.type && card.subtitle && (
          <div className="truncate text-[var(--text-secondary)]">› {card.subtitle}</div>
        )}
        {card.chatMode && lines.length === 0 && <div className="truncate italic">{t.workdesk_in_chat}</div>}
        {lines.length === 0 && !card.chatMode && <div className="truncate italic text-[var(--text-faint)]">{t.workdesk_no_output}</div>}
        {lines.map((line, i) => (
          <div key={i} className={`truncate ${i === lines.length - 1 ? "text-[var(--text-secondary)]" : ""}`}>
            {line}
          </div>
        ))}
      </div>
    </button>
  );
}

function BrowserCardView({ card, picture }: { card: BrowserCard; picture: string | undefined }) {
  return (
    <button
      type="button"
      className={cardCls}
      onClick={() => useWorkdeskViewStore.getState().setOpenNode({ kind: "browser", id: card.id })}
    >
      <div className={headCls}>
        <span className="flex shrink-0 text-[var(--text-muted)]"><GlobeIcon /></span>
        <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">{card.title}</span>
        <span className="tc-mono ml-auto max-w-[45%] shrink-0 truncate pl-1 text-[11px] text-[var(--text-faint)]">{card.host}</span>
      </div>
      {picture ? (
        <div className="m-2 min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border)]">
          <img src={picture} alt="" className="block w-full object-cover object-top" draggable={false} />
        </div>
      ) : (
        <div className="m-2 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-3 py-2.5">
          <div className="line-clamp-2 text-[12.5px] font-medium text-[var(--text-primary)]">{card.title}</div>
          <div className="tc-mono truncate text-[11px] text-[var(--text-muted)]">{card.url}</div>
        </div>
      )}
    </button>
  );
}

function TaskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4l1.2 1.2L6 3M2.5 8l1.2 1.2L6 7M2.5 12h0.01M8 4h5.5M8 8h5.5M8 12h5.5" />
    </svg>
  );
}

/** A task as a card: its status, progress, the step under way (or the question), who's on it. */
function TaskCardView({ card, t }: { card: TaskCard; t: Dict }) {
  const color = STATUS_COLOR[card.status];
  return (
    <button
      type="button"
      className={cardCls}
      style={card.status === "needs_you" ? { borderColor: "color-mix(in srgb, var(--amber) 50%, var(--border))" } : undefined}
      onClick={() => useWorkdeskViewStore.getState().setOpenNode({ kind: "task", id: card.id })}
    >
      <div className={headCls}>
        <span className="flex shrink-0 text-[var(--text-muted)]"><TaskIcon /></span>
        <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">{card.title}</span>
        <span className="ml-auto shrink-0 rounded-full border px-1.5 text-[10.5px]" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
          {statusLabel(card.status, t)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2.5">
        {card.progress && (
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
              <span className="block h-1 rounded-full" style={{ width: `${card.percent}%`, background: color }} />
            </span>
            <span className="tc-mono text-[11px] text-[var(--text-muted)]">{card.progress}</span>
          </span>
        )}
        <span className="line-clamp-3 text-[12px] leading-[1.6]" style={{ color: card.status === "needs_you" ? "var(--amber)" : "var(--text-secondary)" }}>
          {card.current ?? (card.status === "done" ? t.workdesk_all_steps_done : t.workdesk_no_steps)}
        </span>
        <span className="mt-auto">
          <OwnerList owners={card.owners} />
        </span>
      </div>
    </button>
  );
}

function OwnerList({ owners }: { owners: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {owners.map((o) => (
        <OwnerDot key={o} owner={o} />
      ))}
    </span>
  );
}

function OwnerDot({ owner }: { owner: string }) {
  const view = useOwnerView(owner);
  return view.icon ? (
    <img src={view.icon} alt={view.label} title={view.label} className="h-3.5 w-3.5 object-contain" draggable={false} />
  ) : (
    <span className="text-[10.5px] text-[var(--text-faint)]">{view.label}</span>
  );
}

function NoteCardView({ card, t }: { card: NoteCard; t: Dict }) {
  return (
    <button
      type="button"
      className={cardCls}
      onClick={() => useWorkdeskViewStore.getState().setOpenNode({ kind: "note", id: card.id })}
    >
      <div className={headCls}>
        <span className="flex shrink-0 text-[var(--text-muted)]"><NoteIcon /></span>
        <span className="min-w-0 truncate text-[12px] text-[var(--text-primary)]">{card.title}</span>
        <span className="ml-auto shrink-0 pl-1 text-[11px] text-[var(--text-faint)]">{t.workdesk_note}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap px-3 py-2.5 text-[12px] leading-[1.7] text-[var(--text-secondary)]">
        {card.body}
      </div>
    </button>
  );
}

function SectionHead({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">{title}</span>
      <span className="text-[11px] text-[var(--text-faint)]">{summary}</span>
    </div>
  );
}

const gridCols = "grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]";

export function WorkdeskView() {
  const t = useT();
  const mode = useWorkdeskViewStore((s) => s.mode);
  const filter = useWorkdeskViewStore((s) => s.filter);
  const setFilter = useWorkdeskViewStore((s) => s.setFilter);
  const setMode = useWorkdeskViewStore((s) => s.setMode);
  const openNode = useWorkdeskViewStore((s) => s.openNode);
  const setOpenNode = useWorkdeskViewStore((s) => s.setOpenNode);
  // A new task from the grid opens in its tab, ready to name.
  const addGridTask = async () => {
    const { focusedProjectId, projects: all } = useProjectStore.getState();
    const project = all.find((p) => p.id === focusedProjectId) ?? all[0];
    if (!project) return;
    const made = await createTask(project.path);
    if (made) setOpenNode({ kind: "task", id: made.id });
  };
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const browserCards = useBrowserCardStore((s) => s.cards);
  const identities = useIdentityStore((s) => s.identities);
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const transcripts = useManagerChatStore((s) => s.transcripts);
  const chatDock = useChatDockStore();
  const [tails, setTails] = useState<Record<string, string[]>>({});
  const [now, setNow] = useState(() => Date.now());

  const managerTerminalId = (canvases.find((c) => c.id === activeCanvasId) ?? canvases[0])?.workspaceManagerTerminalId ?? null;
  const sections = useMemo(() => {
    const telemetry = new Map<string, TerminalTelemetrySnapshot | null | undefined>();
    for (const [id, runtime] of Object.entries(runtimeTerminals)) telemetry.set(id, runtime.telemetry);
    const identityNames: Record<string, string> = {};
    for (const [id, identity] of Object.entries(identities)) identityNames[id] = identity.name;
    return buildWorkdeskSections({
      projects,
      telemetry,
      browsers: Object.values(browserCards),
      identityNames,
      pins: Object.values(pinsByProject).flat(),
      managerTerminalId,
    });
  }, [projects, runtimeTerminals, browserCards, identities, pinsByProject, managerTerminalId]);

  // The cards' last lines, read from each terminal's screen while the grid shows.
  const terminalIds = useMemo(
    () => [...sections.agents, ...sections.other].filter((c): c is TerminalCard => c.kind === "terminal").map((c) => c.id),
    [sections],
  );
  const allCards = useMemo<WorkdeskCard[]>(
    () => [...sections.agents, ...sections.browserGroups.flatMap((g) => g.cards), ...sections.tasks, ...sections.other],
    [sections],
  );
  const openCard = openNode ? (allCards.find((c) => c.kind === openNode.kind && c.id === openNode.id) ?? null) : null;
  // A node closed while its tab was open: back to the grid.
  useEffect(() => {
    if (openNode && !openCard) setOpenNode(null);
  }, [openNode, openCard, setOpenNode]);
  // The grid opens with the manager's chat docked on its left, as the pill
  // has nowhere to sit over the cards; back on the canvas the chat is left
  // as it was before.
  useEffect(() => {
    if (mode !== "grid") return;
    const dock = useChatDockStore.getState();
    const wasOpen = dock.open;
    dock.setOpen(true);
    return () => {
      if (!wasOpen) useChatDockStore.getState().setOpen(false);
    };
  }, [mode]);
  const browserIds = useMemo(() => sections.browserGroups.flatMap((g) => g.cards.map((c) => c.id)), [sections]);
  const snapshots = useBrowserSnapshots(browserIds, mode === "grid" && !openCard, 3000);

  useEffect(() => {
    if (mode !== "grid" || openCard) return;
    const read = () => {
      const next: Record<string, string[]> = {};
      for (const id of terminalIds) {
        const rows = readTerminalTail(id, TAIL_ROWS);
        if (rows) next[id] = cleanTailLines(rows, TAIL_LINES);
      }
      setTails(next);
      setNow(Date.now());
    };
    read();
    const timer = window.setInterval(read, TAIL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mode, terminalIds, openCard]);

  if (mode !== "grid") return null;

  const left = CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + chatDockOffset(chatDock, CHROME_GAP);
  const linesOf = (card: TerminalCard) => (card.chatMode ? lastReply(transcripts[card.id]) : (tails[card.id] ?? []));
  const show = (f: WorkdeskFilter) => filter === "all" || filter === f;
  const filters: WorkdeskFilter[] = ["all", "agents", "browsers", "tasks", "other"];
  const filterLabel: Record<WorkdeskFilter, string> = {
    all: t.workdesk_filter_all,
    agents: t.workdesk_filter_agents,
    browsers: t.workdesk_filter_browsers,
    tasks: t.workdesk_tasks,
    other: t.workdesk_filter_other,
  };
  const empty = sections.counts.all === 0;
  const browserWindow = openCard?.kind === "browser";
  const barGlass = browserWindow ? "pointer-events-auto bg-[var(--chrome-glass)] [backdrop-filter:blur(22px)_saturate(1.6)]" : "";
  const emptyFilter = !empty && sections.counts[filter] === 0;

  return (
    <section
      className="tc-float tc-enter-fade fixed z-[30] flex flex-col overflow-hidden"
      style={{
        left,
        right: CHROME_INSET,
        top: TITLE_STRIP_HEIGHT + CHROME_INSET,
        bottom: CHROME_INSET,
        // A browser tab is a window onto the tile laid under it: the panel
        // paints only its bars, and lets clicks through to the page.
        ...(browserWindow ? { background: "transparent", backdropFilter: "none", WebkitBackdropFilter: "none", pointerEvents: "none" } : {}),
      }}
      aria-label={t.workdesk_view_grid}
      onKeyDown={(e) => {
        // Esc leaves a tab for the grid, unless it's meant for a terminal or the note.
        if (e.key !== "Escape" || !openCard) return;
        const target = e.target as HTMLElement;
        if (target.closest(".tc-xterm-host") || target.tagName === "TEXTAREA") return;
        setOpenNode(null);
      }}
    >
      <div className={`flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2.5 ${barGlass}`}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className="tc-rail-btn flex h-8 items-center px-2.5 text-[12.5px]"
            data-on={filter === f ? "" : undefined}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            style={{ color: filter === f ? "var(--text-primary)" : "var(--text-muted)" }}
          >
            {filterLabel[f]}
            <span className="ml-1.5 text-[var(--text-faint)]">{sections.counts[f]}</span>
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex gap-0.5 rounded-[9px] border border-[var(--border)] p-0.5" role="group" aria-label={t.workdesk_view_switch}>
          <button
            type="button"
            className="tc-rail-btn flex h-7 items-center gap-1.5 px-2.5 text-[12px] text-[var(--text-muted)]"
            onClick={() => setMode("canvas")}
            aria-pressed={false}
          >
            <CanvasViewIcon size={14} />
            {t.workdesk_view_canvas_short}
          </button>
          <button
            type="button"
            className="tc-rail-btn flex h-7 items-center gap-1.5 px-2.5 text-[12px] text-[var(--text-primary)]"
            data-on=""
            aria-pressed={true}
          >
            <GridViewIcon size={14} />
            {t.workdesk_view_grid_short}
          </button>
        </div>
      </div>

      {openCard && (
        <div className={`flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border)] px-2 ${browserWindow ? barGlass : "bg-[color-mix(in_srgb,var(--bg)_40%,transparent)]"}`} role="tablist">
          <button
            type="button"
            className="tc-rail-btn flex h-[30px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => setOpenNode(null)}
            aria-label={t.workdesk_back_to_grid}
          >
            <GridViewIcon size={13} />
            {t.workdesk_view_grid_short}
          </button>
          <span className="mx-1 h-[18px] w-px shrink-0 bg-[var(--border)]" aria-hidden="true" />
          {allCards.map((card) => {
            const active = card === openCard;
            const icon = card.kind === "terminal" && card.isAgent ? agentIcon(card.type) : null;
            return (
              <button
                key={`${card.kind}:${card.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                className="tc-rail-btn flex h-[30px] max-w-[200px] shrink-0 items-center gap-1.5 px-2.5 text-[12px]"
                data-on={active ? "" : undefined}
                style={{ color: active ? "var(--text-primary)" : "var(--text-muted)" }}
                onClick={() => setOpenNode({ kind: card.kind, id: card.id })}
              >
                {icon ? (
                  <img src={icon} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" draggable={false} />
                ) : (
                  <span className="flex shrink-0">
                    {card.kind === "browser" ? <GlobeIcon /> : card.kind === "note" ? <NoteIcon /> : card.kind === "task" ? <TaskIcon /> : <ShellIcon />}
                  </span>
                )}
                <span className="truncate">{card.title}</span>
                {card.kind === "terminal" && card.state === "active" && (
                  <span className="tc-live-pip inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--cyan)" }} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {openCard && (
        <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
          <WorkdeskTab card={openCard} />
        </div>
      )}

      {!openCard && (
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-24 pt-3">
        {(empty || emptyFilter) && (
          <div className="py-16 text-center text-[13px] text-[var(--text-muted)]">{empty ? t.workdesk_empty : t.workdesk_empty_filter}</div>
        )}
        <div className="flex flex-col gap-2.5">
          {show("agents") && sections.agents.length > 0 && (
            <>
              <SectionHead title={t.workdesk_section_agents} summary={t.workdesk_agents_summary(sections.agents.length, sections.runningAgents)} />
              <div className={gridCols}>
                {sections.agents.map((card) => (
                  <TerminalCardView key={card.id} card={card} lines={linesOf(card)} now={now} t={t} />
                ))}
              </div>
            </>
          )}
          {show("browsers") && sections.browserGroups.length > 0 && (
            <>
              <SectionHead
                title={t.workdesk_section_browsers}
                summary={t.workdesk_browsers_summary(sections.browserGroups.length, sections.counts.browsers)}
              />
              {sections.browserGroups.map((group) => (
                <div key={group.identityId} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
                      style={{ background: "var(--surface-hover)", color: "var(--text-primary)" }}
                      aria-hidden="true"
                    >
                      {group.name.slice(0, 1).toUpperCase()}
                    </span>
                    {group.name}
                  </div>
                  <div className={gridCols}>
                    {group.cards.map((card) => (
                      <BrowserCardView key={card.id} card={card} picture={snapshots[card.id]} />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          {show("tasks") && (
            <>
              <div className="flex items-center gap-2">
                <SectionHead title={t.workdesk_tasks} summary={String(sections.tasks.length)} />
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[var(--text-secondary)] text-[var(--bg)] hover:bg-[var(--text-primary)]"
                  title={t.tasks_new}
                  aria-label={t.tasks_new}
                  onClick={() => void addGridTask()}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </button>
              </div>
              {sections.tasks.length > 0 && (
                <div className={gridCols}>
                  {sections.tasks.map((card) => (
                    <TaskCardView key={card.id} card={card} t={t} />
                  ))}
                </div>
              )}
            </>
          )}
          {show("other") && sections.other.length > 0 && (
            <>
              <SectionHead title={t.workdesk_section_other} summary={String(sections.other.length)} />
              <div className={gridCols}>
                {sections.other.map((card) =>
                  card.kind === "note" ? (
                    <NoteCardView key={card.id} card={card} t={t} />
                  ) : (
                    <TerminalCardView key={card.id} card={card} lines={linesOf(card)} now={now} t={t} />
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </section>
  );
}
