import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import type { Task } from "../types";
import { AgentOption, NewAgentTiles, PickerHeading, PickerPopover } from "../agents/AgentPicker";
import { agentIcon } from "../toolbar/agentIcons";
import { workerFolders } from "../toolbar/dockEntries";
import { useProjectStore } from "../stores/projectStore";
import { handOver, type HandOverOptions } from "./taskActions";
import { startAgentOn, useAgents, type AgentChoice } from "./useAgents";

/** Whom to hand a task (or a part of it) to: an agent that's here, or a new one. */
export function HandOverButton({ task, part, note, label, className, onDone }: { task: Task; part?: string | null; note?: string; label?: string; className?: string; onDone?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" className={className ?? "tc-tk-btn"} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label ?? t.tb.handOver}
      </button>
      {open && button.current && (
        <HandOverMenu
          task={task}
          part={part}
          note={note}
          anchor={button.current}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
          onDone={() => {
            setOpen(false);
            onDone?.();
          }}
        />
      )}
    </>
  );
}

function HandOverMenu({ task, part, note, anchor, onClose, onDone }: { task: Task; part?: string | null; note?: string; anchor: HTMLElement; onClose: (refocus: boolean) => void; onDone: () => void }) {
  const t = useT();
  const all = useAgents();
  const projects = useProjectStore((s) => s.projects);
  // Given again with each go, so it starts empty once someone has had it.
  const again = task.tries.length > 0;
  const last = again ? task.allowed : "";
  const [allowed, setAllowed] = useState(again ? "" : task.allowed);
  const [allowing, setAllowing] = useState(!!last);
  const [busy, setBusy] = useState<AgentChoice | null>(null);
  const [starting, setStarting] = useState(false);
  // Whoever had it knows it already; then who's free.
  const had = task.tries.filter((x) => !part || x.part === part).at(-1)?.terminal ?? null;
  const agents = useMemo(() => [...all].sort((a, b) => Number(b.id === had && !b.busy) - Number(a.id === had && !a.busy)), [all, had]);
  const folders = workerFolders();
  const pathOf = (f: (typeof folders)[number]) => projects.find((p) => p.id === f.projectId)?.worktrees.find((w) => w.id === f.worktreeId)?.path;
  const home = projects.find((p) => p.path === task.folder || p.worktrees.some((w) => w.path === task.folder));
  const start = folders.find((f) => task.folder !== null && pathOf(f) === task.folder) ?? folders.find((f) => f.projectId === home?.id) ?? folders[0];
  const [chosen, setChosen] = useState<string | null>(null);
  const where = folders.find((f) => f.worktreeId === chosen) ?? start;
  const shared = task.folder !== null && agents.some((a) => a.busy && a.task && a.task.id !== task.id && a.worktree === task.folder);
  const options: HandOverOptions = { part: part ?? null, allowed, ...(note ? { note } : {}) };
  const give = async (agent: AgentChoice, how?: "queue" | "interrupt") => {
    const result = await handOver(task, agent.id, { ...options, ...(how ? { how } : {}) });
    if (result === "busy") setBusy(agent);
    else if (result === "done") onDone();
  };
  return (
    <PickerPopover
      anchor={anchor}
      label={t.tb.handTo(`T-${task.n}`)}
      width={344}
      onClose={onClose}
      onEscape={() => {
        if (busy) setBusy(null);
        return !!busy;
      }}
    >
      {busy ? (
        <div className="flex flex-col gap-2 p-1.5" aria-live="polite">
          <p className="px-1 text-[13px] text-[var(--text-primary)]">{t.tb.busy(busy.name)}</p>
          <button type="button" autoFocus data-pick="" className="tc-tk-choice" onClick={() => void give(busy, "queue")}>
            <span>{t.tb.queue}</span>
            <small>{t.tb.queueHint}</small>
          </button>
          <button type="button" data-pick="" className="tc-tk-choice" onClick={() => void give(busy, "interrupt")}>
            <span>{t.tb.interrupt}</span>
            <small>{t.tb.interruptHint}</small>
          </button>
          <button type="button" data-pick="" className="tc-tk-btn self-start" onClick={() => setBusy(null)}>
            {t.tb.cancel}
          </button>
        </div>
      ) : (
        <>
          <PickerHeading>{t.tb.handTo(`T-${task.n}`)}</PickerHeading>
          {agents.length === 0 && <p className="px-2 pb-1 text-[12.5px] text-[var(--text-metadata)]">{t.tb.noAgents}</p>}
          <div className="tc-ap-list">
            {agents.map((a, i) => (
              <AgentOption
                key={a.id}
                type={a.type}
                name={a.name}
                first={i === 0}
                detail={[a.manager ? t.workdesk_manager_badge : "", a.id === had ? t.tb.hadLast : "", projects.length > 1 ? a.folder : ""].filter(Boolean).join(" · ")}
                trailing={<AgentLoad agent={a} />}
                onPick={() => void give(a)}
              />
            ))}
          </div>
          <div className="tc-ap-rule" />
          <PickerHeading
            trailing={
              folders.length > 1 ? (
                <select className="tc-ap-folder" aria-label={t.tb.folder} value={where?.worktreeId} onChange={(e) => setChosen(e.target.value)}>
                  {folders.map((f) => (
                    <option key={f.worktreeId} value={f.worktreeId}>
                      {f.label}
                    </option>
                  ))}
                </select>
              ) : (
                where && <span className="truncate text-[var(--text-primary)]">{where.label}</span>
              )
            }
          >
            {t.tb.startNew}
          </PickerHeading>
          {shared && <p className="px-2 pb-1 text-[12px] text-[var(--text-metadata)]">{t.tb.ownWorktree}</p>}
          <NewAgentTiles
            actionLabel={t.tb.newAgent}
            onPick={(entry) => {
              if (!where || starting) return;
              setStarting(true);
              void startAgentOn(task, entry, entry.label(t), where, options).then((ok) => (ok ? onDone() : setStarting(false)));
            }}
          />
          <div className="tc-ap-rule" />
          <button type="button" data-pick="" className="tc-ap-fold" aria-expanded={allowing} onClick={() => setAllowing(!allowing)}>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 3l5 5-5 5" />
            </svg>
            <span className="shrink-0">{t.tb.allowedTitle}</span>
            <span>{allowing ? "" : allowed.trim() || t.tb.allowedNone}</span>
          </button>
          {allowing && (
            <div className="flex flex-col gap-1.5 px-2 pb-2 pt-1">
              <textarea autoFocus={!last} className="tc-tk-input resize-y" data-short="true" aria-label={t.tb.allowedTitle} value={allowed} maxLength={2000} placeholder={t.tb.allowedHint} onChange={(e) => setAllowed(e.target.value)} />
              {last && last !== allowed && (
                <span className="text-[12px] text-[var(--text-metadata)]">
                  {t.tb.allowedLast(last)}{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => setAllowed(last)}>
                    {t.tb.allowAgain}
                  </button>
                </span>
              )}
              <span className="text-[12px] text-[var(--text-metadata)]">{t.tb.allowedNote}</span>
            </div>
          )}
        </>
      )}
    </PickerPopover>
  );
}

export function AgentMark({ type, size = 16 }: { type: string; size?: number }) {
  const icon = agentIcon(type);
  return icon ? <img src={icon} alt="" width={size} height={size} className="shrink-0 object-contain" /> : <span className="shrink-0" style={{ width: size }} />;
}

export function AgentLoad({ agent }: { agent: AgentChoice }) {
  const t = useT();
  const words = !agent.running ? t.tb.notRunning : agent.task ? t.tb.onIt(`T-${agent.task.n}`) : agent.busy ? t.tb.busyShort : t.tb.idle;
  return (
    <span className="tc-ap-state" data-state={!agent.running ? "off" : agent.task ? "on" : agent.busy ? "busy" : "free"}>
      {agent.queued ? `${words} +${agent.queued}` : words}
    </span>
  );
}
