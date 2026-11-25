import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import { Dropdown } from "../components/ui/parts";
import type { Task } from "../types";
import { CHECK_RULES, PRIORITIES, WORK_KINDS, activeTries, columnOf, isActive, isLive, type Part, type Ref, type TextField } from "../../shared/task";
import { findTerminal } from "../actions/terminalLookup";
import { openFileInView } from "../actions/openSession";
import { goToNote, useNotes } from "../board/notes";
import { useProjectStore } from "../stores/projectStore";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { attachToTask, changeTask, deleteTask, goToTerminal, openTask, sayOnTask, sendTaskNow, showTaskOnCanvas, stopTask, takeOffCanvas } from "./taskActions";
import { AskButton, AskFoot, AskHead, AskWords } from "../components/ask/AskCard";
import { useAutoGrow } from "../hooks/useAutoGrow";
import { AgentMark, HandOverButton } from "./HandOver";
import { ReportFacts, TaskAsks } from "./TaskAsks";
import { Dot, RunRow, useFolderName } from "./TaskCard";
import { useTaskStore } from "./taskStore";
import { ago, partTry, runLines, sortRequests, timeAndUse, waitsForYou } from "./taskWords";
import { useAgents } from "./useAgents";
import { useNow } from "./useNow";
import { useTaskText } from "./useTaskText";
import "./tasks.css";

/** One task: the brief an agent works from, then what came of it, then a line to say something. */
export function TaskPage({ task, onBack }: { task: Task; onBack?: () => void }) {
  const t = useT();
  const column = columnOf(task);
  const requests = sortRequests(task);
  // Looked at: no longer new.
  useEffect(() => {
    if (!task.seen) void changeTask(task, { op: "seen" });
  }, [task.id, task.seen]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="tc-tk-head">
        {onBack && (
          <button type="button" className="tc-tk-btn !gap-1 !pl-2" data-quiet="true" onClick={onBack}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3L5 8l5 5" />
            </svg>
            {t.tb.back}
          </button>
        )}
        <span className="tc-tk-id">{`T-${task.n}`}</span>
        <span className="tc-tk-state">
          <Dot column={column} />
          {t.tb.columns[column]}
        </span>
        <span className="flex-1" />
        <HeadActions task={task} />
      </div>
      <div className="tc-tk-scroll">
        <div className="tc-tk-doc">
          <div className="flex flex-col gap-2.5">
            <TitleField task={task} />
            <Chips task={task} />
            <Meta task={task} />
          </div>
          <Runs task={task} />
          {requests.length > 0 && (
            <div className="tc-tk-card tc-tk-asks">
              <TaskAsks task={task} requests={requests} />
            </div>
          )}
          {task.suggestion && <SuggestionBlock task={task} />}
          {task.report && <ReportSection task={task} />}
          <DescriptionField task={task} />
          <Fields key={task.id} task={task} />
          <Decisions task={task} />
          <Activity task={task} />
        </div>
      </div>
      <TaskComposer task={task} />
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="tc-tk-section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function HeadActions({ task }: { task: Task }) {
  const t = useT();
  const [menu, setMenu] = useState(false);
  const [arm, setArm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const placed = useRecordPlaceStore((s) => !!s.places[task.id]);
  const column = columnOf(task);
  useEffect(() => {
    if (!menu) return;
    setArm(false);
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [menu]);
  const on = activeTries(task);
  const item = (label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`tc-menu-option text-[13px] ${danger ? "text-[var(--red)]" : ""}`}
      onClick={() => {
        setMenu(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      {!task.closed && on.length === 0 && task.requests.length === 0 && <HandOverButton task={task} className="tc-tk-btn tc-tk-strong" />}
      {task.closed && (
        <button type="button" className="tc-tk-btn" onClick={() => void changeTask(task, { op: "reopen" })}>
          {t.tb.reopen}
        </button>
      )}
      <div
        ref={ref}
        className="relative"
        onKeyDown={(e) => {
          if (e.key === "Escape" && menu) {
            e.stopPropagation();
            setMenu(false);
          }
        }}
      >
        <button type="button" className="tc-tk-icon" aria-label={t.tb.more} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
        {menu && (
          <div role="menu" className="tc-menu-pop absolute right-0 top-9 z-30 w-[200px]">
            {!task.closed && on.length > 0 && <HandOverButton task={task} className="tc-menu-option text-[13px]" onDone={() => setMenu(false)} />}
            {!task.closed && item(t.tb.markDone, () => void changeTask(task, { op: "accept" }))}
            {column === "next" && item(t.tb.moveLater, () => void changeTask(task, { op: "wait", wait: "later" }))}
            {column === "later" && item(t.tb.moveNext, () => void changeTask(task, { op: "wait", wait: "next" }))}
            {item(placed ? t.tb.showOnCanvas : t.tb.putOnCanvas, () => showTaskOnCanvas(task.id))}
            {placed && item(t.tb.takeOffCanvas, () => takeOffCanvas(task.id))}
            {!task.closed && item(t.tb.drop, () => void changeTask(task, { op: "drop" }), true)}
            {task.closed && (
              <button type="button" role="menuitem" className="tc-menu-option text-[13px] text-[var(--red)]" onClick={() => (arm ? void deleteTask(task) : setArm(true))}>
                {arm ? t.tb.deleteConfirm : t.tb.delete}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- the brief ---------- */

function Conflict({ text }: { text: ReturnType<typeof useTaskText> }) {
  const t = useT();
  if (!text.conflict) return null;
  return (
    <p role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-[var(--amber)]">
      {t.tb.conflict}
      <button type="button" className="tc-tk-btn" onClick={text.useMine}>
        {t.tb.useMine}
      </button>
      <button type="button" className="tc-tk-btn" onClick={text.useTheirs}>
        {t.tb.seeTheirs}
      </button>
    </p>
  );
}

/** As tall as its words. */
function useGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return ref;
}

function TitleField({ task }: { task: Task }) {
  const t = useT();
  const text = useTaskText(task, "title");
  const ref = useGrow(text.value);
  return (
    <>
      <label className="block">
        <span className="sr-only">{t.tb.namePlaceholder}</span>
        <textarea
          ref={ref}
          rows={1}
          className="tc-tk-title"
          value={text.value}
          maxLength={300}
          placeholder={t.tb.namePlaceholder}
          onChange={(e) => text.change(e.target.value.replace(/\n/g, " "))}
          onBlur={text.save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <Conflict text={text} />
    </>
  );
}

function TextArea({ task, field, label, hint, min, focus }: { task: Task; field: TextField; label: string; hint: string; min: number; focus?: boolean }) {
  const text = useTaskText(task, field);
  const ref = useGrow(text.value);
  return (
    <>
      <label className="block">
        <span className="sr-only">{label}</span>
        <textarea ref={ref} autoFocus={focus} className="tc-tk-input w-full resize-none overflow-hidden" style={{ minHeight: min }} value={text.value} placeholder={hint} onChange={(e) => text.change(e.target.value)} onBlur={text.save} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <Conflict text={text} />
    </>
  );
}

const PICTURE = /!\[([^\]]*)\]\(\.\/[a-z0-9-]+\.attachments\/([A-Za-z0-9._-]+)\)/g;

function DescriptionField({ task }: { task: Task }) {
  const t = useT();
  const text = useTaskText(task, "body");
  const ref = useGrow(text.value);
  const [base, setBase] = useState<string | null>(null);
  const pictures = useMemo(() => [...text.value.matchAll(PICTURE)].map((m) => ({ alt: m[1], name: m[2] })), [text.value]);
  useEffect(() => {
    if (pictures.length === 0 || base) return;
    void window.tacit.tasks.attachments(task.workdesk, task.id).then((r) => r.ok && setBase(r.value));
  }, [pictures.length, base, task.workdesk, task.id]);
  const attach = async (files: readonly File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const marks: string[] = [];
    for (const f of images) {
      const mark = await attachToTask(task, f);
      if (mark) marks.push(mark);
    }
    if (marks.length) text.change(`${ref.current?.value.trimEnd() ?? text.value.trimEnd()}\n\n${marks.join("\n\n")}\n`.trimStart());
  };
  return (
    <>
      <label className="block">
        <span className="sr-only">{t.tb.description}</span>
        <textarea
          ref={ref}
          className="tc-tk-body"
          value={text.value}
          placeholder={`${t.tb.prompts[task.kind]}. ${t.tb.descriptionHint}`}
          onChange={(e) => text.change(e.target.value)}
          onBlur={text.save}
          onKeyDown={(e) => e.stopPropagation()}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.some((f) => f.type.startsWith("image/"))) return;
            e.preventDefault();
            e.stopPropagation();
            void attach(files);
          }}
          onDrop={(e) => {
            const files = [...e.dataTransfer.files];
            if (!files.some((f) => f.type.startsWith("image/"))) return;
            e.preventDefault();
            e.stopPropagation();
            void attach(files);
          }}
        />
      </label>
      <Conflict text={text} />
      {base && pictures.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {pictures.map((p) => (
            <img key={p.name} src={`${base}/${p.name}`} alt={p.alt || t.tb.description} className="tc-tk-picture" />
          ))}
        </div>
      )}
    </>
  );
}

function SuggestionBlock({ task }: { task: Task }) {
  const t = useT();
  const s = task.suggestion!;
  const words = [s.title, s.body, s.doneWhen?.length ? `${t.tb.doneWhen}:\n${s.doneWhen.map((l) => `- ${l}`).join("\n")}` : "", s.leaveAlone ? `${t.tb.leaveAlone}: ${s.leaveAlone}` : ""].filter(Boolean).join("\n\n");
  return (
    <div className="tc-tk-card tc-tk-asks">
      <AskHead kind="suggestion" label={t.tb.suggestionLabel} title={t.tb.suggestion(s.byName)} />
      <AskWords mono={false}>{words}</AskWords>
      <AskFoot>
        <AskButton tone="primary" onClick={() => void changeTask(task, { op: "suggestion", take: true })}>
          {t.tb.accept}
        </AskButton>
        <span className="flex-1" />
        <AskButton tone="quiet" onClick={() => void changeTask(task, { op: "suggestion", take: false })}>
          {t.tb.turnDown}
        </AskButton>
      </AskFoot>
    </div>
  );
}

/** A line you can change where it is: saved on Enter or when you leave it, back as it was on Esc. */
function LineField({ value, label, onSave, done }: { value: string; label: string; onSave: (text: string) => void; done?: boolean }) {
  const [text, setText] = useState(value);
  const left = useRef(false);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={`tc-tk-line-input ${done ? "text-[var(--text-metadata)]" : ""}`}
      aria-label={label}
      value={text}
      maxLength={300}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!left.current && text.trim() && text.trim() !== value) onSave(text.trim());
        else setText(value);
        left.current = false;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          left.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
function AddLine({ placeholder, onAdd, focus }: { placeholder: string; focus?: boolean; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const line = text.trim();
        if (!line) return;
        setText("");
        void onAdd(line).then((ok) => ok || setText(line));
      }}
    >
      <input autoFocus={focus} className="tc-tk-input w-full" aria-label={placeholder} placeholder={placeholder} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </form>
  );
}
function LineTools({ onUp, onDown, onRemove }: { onUp?: () => void; onDown?: () => void; onRemove: () => void }) {
  const t = useT();
  const b = (label: string, d: string, run?: () => void) => (
    <button type="button" className="tc-tk-icon" data-small="true" aria-label={label} title={label} disabled={!run} onClick={run}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    </button>
  );
  return (
    <span className="tc-tk-line-tools">
      {b(t.tb.moveUp, "M4 10l4-4 4 4", onUp)}
      {b(t.tb.moveDown, "M4 6l4 4 4-4", onDown)}
      {b(t.tb.remove, "M4 4l8 8M12 4l-8 8", onRemove)}
    </span>
  );
}

/** The brief's other fields: those with something in them, and the rest one press away. */
const FIELDS = ["doneWhen", "leaveAlone", "startFrom", "parts", "allowed"] as const;
type Field = (typeof FIELDS)[number];
function Fields({ task }: { task: Task }) {
  const t = useT();
  const [opened, setOpened] = useState<readonly Field[]>([]);
  const has: Record<Field, boolean> = {
    doneWhen: task.doneWhen.length > 0,
    leaveAlone: task.leaveAlone.trim() !== "",
    startFrom: task.startFrom.length > 0,
    parts: task.parts.length > 0,
    allowed: task.allowed.trim() !== "",
  };
  const shows = (f: Field) => has[f] || opened.includes(f);
  const rest = FIELDS.filter((f) => !shows(f));
  return (
    <>
      {shows("doneWhen") && <DoneWhen task={task} focus={!has.doneWhen} />}
      {shows("leaveAlone") && (
        <Section title={t.tb.leaveAlone}>
          <TextArea task={task} field="leaveAlone" label={t.tb.leaveAlone} hint={t.tb.leaveAloneHint} min={40} focus={!has.leaveAlone} />
        </Section>
      )}
      {shows("startFrom") && <StartFrom task={task} focus={!has.startFrom} />}
      {shows("parts") && <Parts task={task} focus={!has.parts} />}
      {shows("allowed") && (
        <Section title={t.tb.allowedTitle}>
          <TextArea task={task} field="allowed" label={t.tb.allowedTitle} hint={t.tb.allowedHint} min={40} focus={!has.allowed} />
          <p className="pt-1.5 text-[12px] text-[var(--text-metadata)]">{t.tb.allowedNote}</p>
        </Section>
      )}
      {!task.closed && rest.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.tb.details}>
          {rest.map((f) => (
            <button key={f} type="button" className="tc-tk-pill" onClick={() => setOpened([...opened, f])}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              {t.tb.addField[f]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DoneWhen({ task, focus }: { task: Task; focus?: boolean }) {
  const t = useT();
  const change = (c: Parameters<typeof changeTask>[1]) => changeTask(task, c);
  return (
    <Section title={t.tb.doneWhen}>
      {task.doneWhen.map((l, i) => (
        <div key={l.id} className="tc-tk-line">
          <span aria-hidden="true" className="tc-tk-tick" data-src={l.proof?.src} />
          <span className="min-w-0 flex-1">
            <LineField value={l.text} label={t.tb.doneWhen} onSave={(text) => void change({ op: "line", change: { op: "text", id: l.id, text } })} />
            {l.proof && (
              <span className="block text-[12.5px]">
                <span className="tc-tk-src" data-src={l.proof.src}>
                  {t.tb.sources[l.proof.src]}
                </span>{" "}
                <span className="text-[var(--text-metadata)]">{l.proof.text}</span>
              </span>
            )}
          </span>
          <LineTools
            onUp={i > 0 ? () => void change({ op: "line", change: { op: "move", id: l.id, by: -1 } }) : undefined}
            onDown={i < task.doneWhen.length - 1 ? () => void change({ op: "line", change: { op: "move", id: l.id, by: 1 } }) : undefined}
            onRemove={() => void change({ op: "line", change: { op: "remove", id: l.id } })}
          />
        </div>
      ))}
      <AddLine focus={focus} placeholder={t.tb.doneWhenAdd} onAdd={(text) => change({ op: "line", change: { op: "add", text } })} />
    </Section>
  );
}

/** What something typed to start from is: a link, an issue, or a file by its whole path. */
export function refFrom(text: string): Omit<Ref, "id"> {
  const s = text.trim();
  if (/^https?:\/\//i.test(s)) {
    const issue = /^https?:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+|linear\.app\/[^/]+\/issue\/)/i.test(s);
    return { kind: issue ? "issue" : "link", label: s.replace(/^https?:\/\//, "").slice(0, 120), target: s };
  }
  if (s.startsWith("/") || s.startsWith("~/")) return { kind: "file", label: s.split("/").filter(Boolean).pop() ?? s, target: s };
  if (/^(?:[A-Z][A-Z0-9]+-|#)\d+$/.test(s)) return { kind: "issue", label: s, target: s };
  return { kind: "link", label: s.slice(0, 120), target: s };
}

function StartFrom({ task, focus }: { task: Task; focus?: boolean }) {
  const t = useT();
  const notes = useNotes();
  const agents = useAgents();
  const open = (r: Ref) => {
    if (r.kind === "note") goToNote(r.target);
    else if (r.kind === "chat") goToTerminal(r.target);
    else if (r.kind === "file") openFileInView(r.target);
    else if (/^https?:\/\//i.test(r.target)) window.open(r.target, "_blank", "noopener");
  };
  const choices: Array<{ value: string; label: string; detail?: string }> = [
    { value: "", label: `${t.tb.noteLabel}, ${t.tb.madeFromKind.chat.toLowerCase()}…` },
    ...notes.map((n) => ({ value: `note:${n.id}`, label: n.title, detail: t.tb.noteLabel })),
    ...agents.map((a) => ({ value: `chat:${a.id}`, label: a.name, detail: a.folder })),
  ];
  return (
    <Section title={t.tb.startFrom}>
      {task.startFrom.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {task.startFrom.map((r) => (
            <span key={r.id} className="tc-tk-ref">
              <button type="button" onClick={() => open(r)} title={r.target}>
                <span className="text-[var(--text-metadata)]">{t.tb.refKinds[r.kind]}</span> {r.label}
              </button>
              <button type="button" className="tc-tk-icon" data-small="true" aria-label={`${t.tb.remove}: ${r.label}`} onClick={() => void changeTask(task, { op: "ref", remove: r.id })}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <div className="min-w-[180px] flex-1">
          <AddLine focus={focus} placeholder={t.tb.startFromAdd} onAdd={(text) => changeTask(task, { op: "ref", add: refFrom(text) })} />
        </div>
        {choices.length > 1 && (
          <Dropdown
            label={t.tb.startFrom}
            value=""
            options={choices}
            size="md"
            onChange={(v) => {
              const c = choices.find((x) => x.value === v);
              if (!c || !v) return;
              void changeTask(task, { op: "ref", add: { kind: v.startsWith("note:") ? "note" : "chat", label: c.label, target: v.slice(5) } });
            }}
          />
        )}
      </div>
    </Section>
  );
}

function Parts({ task, focus }: { task: Task; focus?: boolean }) {
  const t = useT();
  const change = (c: Parameters<typeof changeTask>[1]) => changeTask(task, c);
  return (
    <Section title={t.tb.parts}>
      {task.parts.map((p, i) => (
        <PartRow key={p.id} task={task} part={p} first={i === 0} last={i === task.parts.length - 1} change={change} />
      ))}
      {task.parts.length === 0 && <p className="pb-1.5 text-[13px] text-[var(--text-metadata)]">{t.tb.partsHint}</p>}
      <AddLine focus={focus} placeholder={t.tb.partsAdd} onAdd={(text) => change({ op: "part", change: { op: "add", text } })} />
    </Section>
  );
}

function PartRow({ task, part, first, last, change }: { task: Task; part: Part; first: boolean; last: boolean; change: (c: Parameters<typeof changeTask>[1]) => Promise<unknown> }) {
  const t = useT();
  const on = partTry(task, part.id);
  const active = on && isActive(on.state) ? on : null;
  return (
    <div className="tc-tk-line flex-wrap">
      <input
        type="checkbox"
        className="tc-tk-check"
        checked={part.state === "done"}
        disabled={!!active}
        aria-label={part.text}
        onChange={(e) => void change({ op: "part-state", id: part.id, state: e.target.checked ? "done" : "todo" })}
      />
      <span className="min-w-[140px] flex-1">
        <LineField value={part.text} label={t.tb.parts} done={part.state === "done"} onSave={(text) => void change({ op: "part", change: { op: "text", id: part.id, text } })} />
      </span>
      {active && (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-metadata)]">
          <Dot column={active.state === "working" ? "working" : "next"} />
          {active.name}, {waitsForYou(task, active) ? t.tb.waitsForYou : t.tb.runs[active.state]}
        </span>
      )}
      {!task.closed && part.state !== "done" && <HandOverButton task={task} part={part.id} className="tc-tk-btn tc-tk-quiet" />}
      <LineTools
        onUp={first ? undefined : () => void change({ op: "part", change: { op: "move", id: part.id, by: -1 } })}
        onDown={last ? undefined : () => void change({ op: "part", change: { op: "move", id: part.id, by: 1 } })}
        onRemove={() => void change({ op: "part", change: { op: "remove", id: part.id } })}
      />
    </div>
  );
}

/* ---------- the work ---------- */

/** Who has it now, with what you can do about each. */
function Runs({ task }: { task: Task }) {
  const t = useT();
  const on = activeTries(task);
  if (on.length === 0) return null;
  const lines = runLines(task);
  return (
    <div className="flex flex-col gap-1">
      {on.map((x) => {
        const run = lines.find((r) => r.id === x.id);
        return (
          <div key={x.id} className="tc-tk-runline">
            {run && <RunRow run={run} />}
            {run?.part && <span className="min-w-0 truncate text-[12.5px] text-[var(--text-metadata)]">{run.part}</span>}
            <span className="flex-1" />
            {x.state === "queued" && (
              <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => void sendTaskNow(task, x.id)}>
                {t.tb.sendNow}
              </button>
            )}
            {findTerminal(x.terminal) && isLive(x.state) && (
              <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => goToTerminal(x.terminal)}>
                {t.tb.openTerminal}
              </button>
            )}
            {isActive(x.state) && (
              <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => void stopTask(task, x.id)}>
                {t.tb.stop}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReportSection({ task }: { task: Task }) {
  const t = useT();
  const report = task.report!;
  const [all, setAll] = useState(false);
  const checking = task.requests.some((r) => r.kind === "check");
  const files = all ? report.files : report.files.slice(0, 8);
  const top = task.tries.find((x) => x.id === report.try)?.worktree;
  return (
    <Section title={t.tb.report}>
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{report.summary}</p>
      {report.left && <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-[var(--text-metadata)]">{report.left}</p>}
      {task.closed?.as === "done" && <p className="mt-1.5 text-[13px] text-[var(--text-metadata)]">{task.closed.by === "user" ? task.closed.how : t.tb.wentStraight(task.closed.how)}</p>}
      {/* While it's being checked, the facts are with the question. */}
      {!checking && (
        <div className="mt-2">
          <ReportFacts task={task} reasons={false} />
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-3">
          <h4 className="pb-1 text-[12.5px] text-[var(--text-metadata)]">{t.tb.changed}</h4>
          {files.map((f) => (
            <button key={f.path} type="button" className="tc-tk-file" disabled={!top || f.kind === "deleted"} onClick={() => top && openFileInView(`${top}/${f.path}`)}>
              <span>{f.path}</span>
              <span className="text-[var(--text-metadata)]">{t.tb.files[f.kind]}</span>
            </button>
          ))}
          {report.files.length > files.length && (
            <button type="button" className="tc-tk-btn tc-tk-quiet" onClick={() => setAll(true)}>
              {t.tb.historyMore(report.files.length - files.length)}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/** What you decided, as the chat keeps your answers. */
function Decisions({ task }: { task: Task }) {
  const t = useT();
  if (task.decisions.length === 0) return null;
  return (
    <Section title={t.tb.decisions}>
      <div className="flex flex-col items-start gap-1.5">
        {task.decisions.map((d) => (
          <span key={d.id} className="tc-tk-receipt" title={d.text}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}>
              <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            </span>
            <span className="min-w-0 truncate text-[var(--text-metadata)]">{d.text}</span>
            <span className="max-w-[50%] shrink-0 truncate">{d.answer}</span>
            {d.pending && <span className="shrink-0 text-[var(--text-metadata)]">{t.tb.decisionWaits}</span>}
          </span>
        ))}
      </div>
    </Section>
  );
}

/** How much of what happened shows at first. */
const SHOWN = 10;

/** What happened and what was said, in order, as a chat is. */
function Activity({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  const [all, setAll] = useState(false);
  const who = (by: string) => (by === "user" ? t.tb.actors.user : by === "tacit" ? t.tb.actors.tacit : (task.tries.find((x) => `terminal:${x.terminal}` === by)?.name ?? nameOf(by)));
  const items = [
    ...task.history.map((h, i) => ({ key: `h${i}`, at: h.at, line: h, message: null })),
    ...task.messages.map((m) => ({ key: m.id, at: m.at, line: null, message: m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const shown = all ? items : items.slice(-SHOWN);
  return (
    <Section title={t.tb.activity}>
      <div className="flex flex-col gap-1.5">
        {items.length > shown.length && (
          <button type="button" className="tc-tk-more !px-0" onClick={() => setAll(true)}>
            {t.tb.earlier(items.length - shown.length)}
          </button>
        )}
        {shown.map(({ key, line, message: m }) =>
          m ? (
            <div key={key} className={`flex flex-col gap-1 py-1 ${m.by === "user" ? "items-end" : "items-start"}`}>
              <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-metadata)]">
                {m.by !== "user" && <AgentMark type={typeOf(m.by)} size={14} />}
                {m.by === "user" ? "" : `${m.byName} `}
                {t.tb.waited(ago(m.at, now))}
                {t.tb.said[m.state] && <span className={m.state === "failed" ? "text-[var(--red)]" : ""}>{t.tb.said[m.state]}</span>}
              </span>
              <p className={m.by === "user" ? "tc-tk-bubble" : "whitespace-pre-wrap text-[13.5px] leading-relaxed [overflow-wrap:anywhere]"}>{m.text}</p>
            </div>
          ) : (
            line && (
              <p key={key} className="tc-tk-event">
                <span className="min-w-0">
                  <span className="text-[var(--text-primary)]">{who(line.by)}</span> {line.text}
                </span>
                <span className="shrink-0">{t.tb.waited(ago(line.at, now))}</span>
              </p>
            )
          ),
        )}
      </div>
    </Section>
  );
}
const typeOf = (by: string) => (by.startsWith("terminal:") ? (findTerminal(by.slice("terminal:".length))?.terminal.type ?? "") : "");

/** Saying something on it: to whoever has it, or a note for the next one. The chat's own box. */
function TaskComposer({ task }: { task: Task }) {
  const t = useT();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  const on = activeTries(task).filter((x) => isLive(x.state));
  const [to, setTo] = useState<string | null>(null);
  const target = on.find((x) => x.id === to) ?? on[0] ?? null;
  const ready = text.trim() !== "";
  const send = () => {
    const words = text.trim();
    if (!words) return;
    setText("");
    void sayOnTask(task, words, target?.id).then((ok) => ok || setText(words));
  };
  return (
    <div className="shrink-0 px-4 pb-3 pt-1">
      <div className="tc-tk-composer">
        {on.length > 1 && <Dropdown label={t.tb.conversation} value={target?.id ?? ""} options={on.map((x) => ({ value: x.id, label: x.name }))} onChange={setTo} />}
        <textarea
          ref={ref}
          rows={1}
          maxLength={8000}
          value={text}
          aria-label={target ? t.tb.sayTo(target.name) : t.tb.sayNote}
          placeholder={target ? t.tb.sayTo(target.name) : t.tb.sayNote}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="tc-sq-ctl inline-flex h-8 w-8 shrink-0 items-center justify-center disabled:opacity-40" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }} disabled={!ready} aria-label={t.tb.send} title={t.tb.send} onClick={send}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 13V3.5M4 7.5l4-4 4 4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function nameOf(by: string): string {
  const found = by.startsWith("terminal:") ? findTerminal(by.slice("terminal:".length)) : null;
  return found ? found.terminal.customTitle?.trim() || found.terminal.title : "Agent";
}

/* ---------- its details ---------- */

/** What kind of work, how urgent, where, and whether you look at the end. */
function Chips({ task }: { task: Task }) {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const folderName = useFolderName(task.folder);
  const folders = [
    { value: "", label: t.tb.noFolder },
    ...projects.flatMap((p) => p.worktrees.map((w) => ({ value: w.path, label: w.isPrimary || p.worktrees.length === 1 ? p.name : `${p.name} · ${w.name}`, detail: w.path }))),
    ...(task.folder && !projects.some((p) => p.worktrees.some((w) => w.path === task.folder)) ? [{ value: task.folder, label: folderName, detail: task.folder }] : []),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      <Dropdown label={t.tb.kind} value={task.kind} options={WORK_KINDS.map((k) => ({ value: k, label: t.tb.kinds[k] }))} onChange={(kind) => void changeTask(task, { op: "set", settings: { kind } })} />
      <Dropdown label={t.tb.priority} value={task.priority} options={PRIORITIES.map((p) => ({ value: p, label: p === "none" ? t.tb.noPriority : t.tb.priorities[p] }))} onChange={(priority) => void changeTask(task, { op: "set", settings: { priority } })} />
      <Dropdown label={t.tb.folder} value={task.folder ?? ""} options={folders} onChange={(f) => void changeTask(task, { op: "set", settings: { folder: f || null } })} />
      <Dropdown label={t.tb.check} value={task.check} options={CHECK_RULES.map((c) => ({ value: c, label: t.tb.checkChips[c] }))} onChange={(check) => void changeTask(task, { op: "set", settings: { check } })} />
    </div>
  );
}

/** Where it came from and what it's cost, in a line. */
function Meta({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  const tasks = useTaskStore((s) => s.tasks);
  const use = timeAndUse(task, now);
  const made = task.madeFrom;
  const parent = made?.kind === "task" && made.target ? tasks[made.target] : null;
  return (
    <p className="tc-tk-meta">
      <span>{t.tb.addedAgo(t.tb.waited(ago(task.created, now)))}</span>
      {made && made.kind !== "you" && (
        <span>
          {`${t.tb.madeFrom} `}
          {parent ? (
            <button type="button" onClick={() => openTask(parent.id)}>{`T-${parent.n} ${parent.title}`}</button>
          ) : made.kind === "note" && made.target ? (
            <button type="button" onClick={() => goToNote(made.target!)}>{made.label}</button>
          ) : (
            `${t.tb.madeFromKind[made.kind]}${made.label ? ` ${made.label}` : ""}`
          )}
        </span>
      )}
      {task.ledTo.map((id) => (tasks[id] ? <span key={id}>{`${t.tb.ledTo} `}<button type="button" onClick={() => openTask(id)}>{`T-${tasks[id].n} ${tasks[id].title}`}</button></span> : null))}
      {use.minutes > 0 && <span>{t.tb.worked(t.tb.minutes(use.minutes))}</span>}
      {use.tokens > 0 && <span>{t.tb.tokens(use.tokens)}</span>}
      {task.landed && t.tb.landed[task.landed.state] && <span>{t.tb.landed[task.landed.state]}</span>}
    </p>
  );
}
