import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { Dropdown } from "../components/ui/parts";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { PRIORITIES, WORK_KINDS, type Priority, type WorkKind } from "../../shared/task";
import { AgentMark } from "./HandOver";
import type { NewTask as NewTaskInput } from "../../shared/task-ops";
import { useProjectStore } from "../stores/projectStore";
import { useNotificationStore } from "../stores/notificationStore";
import { createTask, handOver, openTask, placeTask } from "./taskActions";
import { useAgents } from "./useAgents";
import { useTaskStore } from "./taskStore";
import { readName } from "./taskWords";

/** Quick capture: only the name is needed. The rest helps whoever does it. */
export function NewTask({ from }: { from: Partial<NewTaskInput> }) {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const agents = useAgents();
  const [text, setText] = useState(from.title ?? "");
  const [kind, setKind] = useState<WorkKind>(from.kind ?? "build");
  const [body, setBody] = useState(from.body ?? "");
  const [doneWhen, setDoneWhen] = useState((from.doneWhen ?? []).join("\n"));
  const [leaveAlone, setLeaveAlone] = useState(from.leaveAlone ?? "");
  const [saving, setSaving] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const read = useMemo(() => readName(text, { folders: projects.map((p) => ({ name: p.name, path: p.path })), terminals: agents.map((a) => ({ id: a.id, name: a.name })) }), [text, projects, agents]);
  const agent = agents.find((a) => a.id === read.terminal);
  // One folder on the workdesk is where it works, unless you say. What you type in the name comes first.
  const [where, setFolder] = useState<string | null>(from.folder ?? (projects.length === 1 ? projects[0].path : null));
  const folder = read.folder ?? (where || null);
  const [picked, setPicked] = useState<Priority>(from.priority ?? "none");
  const priority = read.priority ?? picked;
  const [more, setMore] = useState({ doneWhen: !!from.doneWhen?.length, leaveAlone: !!from.leaveAlone });
  const desc = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(desc, body);

  const add = async (wait: "next" | "later", hand: boolean) => {
    if (saving) return;
    if (!read.title) {
      useNotificationStore.getState().notify("warn", t.tb.needsName);
      name.current?.focus();
      return;
    }
    setSaving(true);
    const made = await createTask({
      ...from,
      title: read.title,
      kind,
      body: body.trim(),
      folder,
      doneWhen: doneWhen.split("\n").map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean),
      leaveAlone: leaveAlone.trim(),
      wait,
      ...(priority !== "none" ? { priority } : {}),
      madeFrom: from.madeFrom ?? { kind: "you", label: "" },
    });
    setSaving(false);
    if (!made) return;
    const { placeAt } = useTaskStore.getState();
    if (placeAt) placeTask(made.id, placeAt);
    useTaskStore.getState().compose(null);
    if (hand && agent) {
      const result = await handOver(made, agent.id);
      // Busy, or refused: its page has Queue and Interrupt.
      if (result !== "done") openTask(made.id);
    }
  };
  return (
    <form
      aria-label={t.tb.add}
      className="tc-tk-new"
      onSubmit={(e) => {
        e.preventDefault();
        void add("next", false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") useTaskStore.getState().compose(null);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add("next", !!agent);
      }}
    >
      <input ref={name} autoFocus className="tc-tk-title" aria-label={t.tb.namePlaceholder} value={text} maxLength={400} placeholder={t.tb.namePlaceholder} onChange={(e) => setText(e.target.value)} />
      <div className="tc-tk-box">
        <textarea ref={desc} rows={3} aria-label={t.tb.description} value={body} placeholder={t.tb.prompts[kind]} onChange={(e) => setBody(e.target.value)} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Dropdown label={t.tb.kind} value={kind} options={WORK_KINDS.map((k) => ({ value: k, label: t.tb.kinds[k] }))} onChange={setKind} />
          <Dropdown label={t.tb.priority} value={priority} options={PRIORITIES.map((p) => ({ value: p, label: p === "none" ? t.tb.noPriority : t.tb.priorities[p] }))} onChange={setPicked} />
          <Dropdown label={t.tb.folder} value={folder ?? ""} options={[{ value: "", label: t.tb.noFolder }, ...projects.map((p) => ({ value: p.path, label: p.name, detail: p.path }))]} onChange={setFolder} />
          {agent && (
            <span className="tc-tk-chip">
              <AgentMark type={agent.type} size={14} />
              {agent.name}
            </span>
          )}
        </div>
      </div>
      {more.doneWhen ? (
        <label className="tc-tk-field">
          <span>{t.tb.doneWhen}</span>
          <textarea autoFocus={!from.doneWhen?.length} className="tc-tk-input resize-y" value={doneWhen} placeholder={t.tb.doneWhenAdd} onChange={(e) => setDoneWhen(e.target.value)} />
        </label>
      ) : null}
      {more.leaveAlone ? (
        <label className="tc-tk-field">
          <span>{t.tb.leaveAlone}</span>
          <textarea autoFocus={!from.leaveAlone} className="tc-tk-input resize-y" data-short="true" value={leaveAlone} placeholder={t.tb.leaveAloneHint} onChange={(e) => setLeaveAlone(e.target.value)} />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {(["doneWhen", "leaveAlone"] as const).map((f) =>
          more[f] ? null : (
            <button key={f} type="button" className="tc-tk-pill" onClick={() => setMore({ ...more, [f]: true })}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              {t.tb.addField[f]}
            </button>
          ),
        )}
        <span className="min-w-0 text-[12px] text-[var(--text-metadata)]">{t.tb.nameHint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] pt-3">
        {agent ? (
          <button type="button" className="tc-tk-btn" data-strong="true" disabled={saving} onClick={() => void add("next", true)}>
            {t.tb.addAndHand(agent.name)}
          </button>
        ) : null}
        <button type="submit" className="tc-tk-btn" data-strong={!agent} disabled={saving}>
          {t.tb.addAction}
        </button>
        <button type="button" className="tc-tk-btn" disabled={saving} onClick={() => void add("later", false)}>
          {t.tb.addLater}
        </button>
        <span className="flex-1" />
        <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => useTaskStore.getState().compose(null)}>
          {t.tb.cancel}
        </button>
      </div>
    </form>
  );
}
