import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { WORK_KINDS, type WorkKind } from "../../shared/task";
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
  // One folder on the workdesk is where it works, unless you say.
  const folder = read.folder ?? from.folder ?? (projects.length === 1 ? projects[0].path : null);
  const chips = [
    read.folder && { label: t.tb.folder, value: projects.find((p) => p.path === read.folder)?.name ?? "" },
    read.priority && { label: t.tb.priority, value: t.tb.priorities[read.priority] },
    agent && { label: t.tb.handTitle, value: agent.name },
  ].filter((c): c is { label: string; value: string } => !!c);

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
      ...(read.priority ? { priority: read.priority } : {}),
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
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-[var(--text-metadata)]">{t.tb.add}</span>
          <input ref={name} autoFocus className="tc-tk-name" value={text} maxLength={400} placeholder={t.tb.namePlaceholder} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="text-[12.5px] text-[var(--text-metadata)]">{t.tb.nameHint}</p>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-live="polite">
            {chips.map((c) => (
              <span key={c.label} className="tc-tk-chip">
                <span className="text-[var(--text-metadata)]">{c.label}</span> {c.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <div role="group" aria-label={t.tb.kind} className="flex flex-wrap gap-1.5">
        {WORK_KINDS.map((k) => (
          <button key={k} type="button" className="tc-tk-pill" aria-pressed={k === kind} onClick={() => setKind(k)}>
            {t.tb.kinds[k]}
          </button>
        ))}
      </div>
      <label className="tc-tk-field">
        <span>{t.tb.description}</span>
        <textarea className="tc-tk-input resize-y" data-tall="true" value={body} placeholder={t.tb.prompts[kind]} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="tc-tk-field">
        <span>{t.tb.doneWhen}</span>
        <textarea className="tc-tk-input resize-y" value={doneWhen} placeholder={t.tb.doneWhenAdd} onChange={(e) => setDoneWhen(e.target.value)} />
      </label>
      <label className="tc-tk-field">
        <span>{t.tb.leaveAlone}</span>
        <textarea className="tc-tk-input resize-y" data-short="true" value={leaveAlone} placeholder={t.tb.leaveAloneHint} onChange={(e) => setLeaveAlone(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => useTaskStore.getState().compose(null)}>
          {t.tb.cancel}
        </button>
        <span className="flex-1" />
        <button type="button" className="tc-tk-btn" disabled={saving} onClick={() => void add("later", false)}>
          {t.tb.addLater}
        </button>
        <button type="submit" className="tc-tk-btn" data-strong={!agent} disabled={saving}>
          {t.tb.addAction}
        </button>
        {agent && (
          <button type="button" className="tc-tk-btn" data-strong="true" disabled={saving} onClick={() => void add("next", true)}>
            {t.tb.addAndHand(agent.name)}
          </button>
        )}
      </div>
    </form>
  );
}
