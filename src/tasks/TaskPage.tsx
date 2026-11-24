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
import { HandOverButton } from "./HandOver";
import { ReportFacts, RequestBlock } from "./RequestBlock";
import { Dot, useFolderName } from "./TaskCard";
import { useTaskStore } from "./taskStore";
import { ago, partTry, readiness, runLines, sortRequests, timeAndUse, waitsForYou } from "./taskWords";
import { useAgents } from "./useAgents";
import { useNow } from "./useNow";
import { useTaskText } from "./useTaskText";
import "./tasks.css";

/** One task: the brief an agent works from, then the record of what it did. */
export function TaskPage({ task, onBack }: { task: Task; onBack?: () => void }) {
  const t = useT();
  const column = columnOf(task);
  const runs = runLines(task);
  const requests = sortRequests(task);
  // Looked at: no longer new.
  useEffect(() => {
    if (!task.seen) void changeTask(task, { op: "seen" });
  }, [task.id, task.seen]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="tc-tk-head">
        {onBack && (
          <button type="button" className="tc-tk-btn" data-quiet="true" onClick={onBack}>
            ‹ {t.tb.back}
          </button>
        )}
        <span className="tc-tk-id">{`T-${task.n}`}</span>
        <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
          <Dot column={column} />
          {t.tb.columns[column]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-metadata)]">{runs.map((r) => `${r.name}, ${r.waits ? t.tb.waitsForYou : t.tb.runs[r.state]}`).join(" · ")}</span>
        <HeadActions task={task} />
      </div>
      <div className="tc-tk-scroll">
        <div className="tc-tk-page">
          <div className="tc-tk-main">
            <div>
              <TitleField task={task} />
              <DescriptionField task={task} />
            </div>
            {task.suggestion && <SuggestionBlock task={task} />}
            {requests.map((r) => (
              <RequestBlock key={r.id} task={task} request={r} />
            ))}
            {task.report && <ReportSection task={task} />}
            <DoneWhen task={task} />
            <Section title={t.tb.leaveAlone}>
              <TextArea task={task} field="leaveAlone" label={t.tb.leaveAlone} hint={t.tb.leaveAloneHint} min={44} />
            </Section>
            <StartFrom task={task} />
            <Parts task={task} />
            <Work task={task} />
            {task.decisions.length > 0 && (
              <Section title={t.tb.decisions}>
                {task.decisions.map((d) => (
                  <div key={d.id} className="tc-tk-line flex-col !items-start !gap-0.5">
                    <span>{d.text}</span>
                    <span className="text-[var(--cyan)]">
                      {d.answer}
                      {d.pending && <span className="text-[var(--text-metadata)]"> · {t.tb.decisionWaits}</span>}
                    </span>
                  </div>
                ))}
              </Section>
            )}
            <Conversation task={task} />
            <History task={task} />
          </div>
          <Details task={task} />
        </div>
      </div>
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
  const only = on.length === 1 && isLive(on[0].state) && findTerminal(on[0].terminal) ? on[0] : null;
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
      {only && (
        <button type="button" className="tc-tk-btn" onClick={() => goToTerminal(only.terminal)}>
          {t.tb.openTerminal}
        </button>
      )}
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

function TextArea({ task, field, label, hint, min }: { task: Task; field: TextField; label: string; hint: string; min: number }) {
  const text = useTaskText(task, field);
  const ref = useGrow(text.value);
  return (
    <>
      <label className="block">
        <span className="sr-only">{label}</span>
        <textarea ref={ref} className="tc-tk-input w-full resize-none overflow-hidden" style={{ minHeight: min }} value={text.value} placeholder={hint} onChange={(e) => text.change(e.target.value)} onBlur={text.save} onKeyDown={(e) => e.stopPropagation()} />
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
  return (
    <section className="tc-tk-req" data-kind="check" aria-label={t.tb.suggestion(s.byName)}>
      <p className="tc-tk-req-text">{t.tb.suggestion(s.byName)}</p>
      {s.title && <p className="text-[13px]">{s.title}</p>}
      {s.body && <p className="whitespace-pre-wrap text-[13px]">{s.body}</p>}
      {s.doneWhen && (
        <ul className="list-disc pl-5 text-[13px]">
          {s.doneWhen.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {s.leaveAlone && <p className="text-[13px]">{`${t.tb.leaveAlone}: ${s.leaveAlone}`}</p>}
      <div className="flex gap-1.5">
        <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => void changeTask(task, { op: "suggestion", take: true })}>
          {t.tb.accept}
        </button>
        <button type="button" className="tc-tk-btn" onClick={() => void changeTask(task, { op: "suggestion", take: false })}>
          {t.tb.turnDown}
        </button>
      </div>
    </section>
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
function AddLine({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => Promise<unknown> }) {
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
      <input className="tc-tk-input w-full" aria-label={placeholder} placeholder={placeholder} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
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

function DoneWhen({ task }: { task: Task }) {
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
      {task.doneWhen.length === 0 && !task.closed && <p className="pb-1.5 text-[13px] text-[var(--text-metadata)]">{t.tb.doneWhenNone}</p>}
      <AddLine placeholder={t.tb.doneWhenAdd} onAdd={(text) => change({ op: "line", change: { op: "add", text } })} />
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

function StartFrom({ task }: { task: Task }) {
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
          <AddLine placeholder={t.tb.startFromAdd} onAdd={(text) => changeTask(task, { op: "ref", add: refFrom(text) })} />
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

function Parts({ task }: { task: Task }) {
  const t = useT();
  const change = (c: Parameters<typeof changeTask>[1]) => changeTask(task, c);
  return (
    <Section title={t.tb.parts}>
      {task.parts.map((p, i) => (
        <PartRow key={p.id} task={task} part={p} first={i === 0} last={i === task.parts.length - 1} change={change} />
      ))}
      {task.parts.length === 0 && <p className="pb-1.5 text-[13px] text-[var(--text-metadata)]">{t.tb.partsHint}</p>}
      <AddLine placeholder={t.tb.partsAdd} onAdd={(text) => change({ op: "part", change: { op: "add", text } })} />
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

function Work({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  if (task.tries.length === 0) return null;
  return (
    <Section title={t.tb.work}>
      {[...task.tries].reverse().map((x) => (
        <div key={x.id} className="tc-tk-line flex-wrap">
          <span className="w-12 shrink-0 text-[13px] font-medium">{t.tb.tryN(x.n)}</span>
          <button type="button" className="text-left text-[13px] hover:underline" onClick={() => goToTerminal(x.terminal)}>
            {x.name}
          </button>
          <span className="min-w-[120px] flex-1 text-[13px] text-[var(--text-metadata)]">
            {[task.parts.find((p) => p.id === x.part)?.text, t.tb.runs[x.state], x.why, t.tb.waited(ago(x.ended ?? x.at, now)), x.tokens ? t.tb.tokens(x.tokens) : ""].filter(Boolean).join(" · ")}
          </span>
          {x.state === "queued" && (
            <button type="button" className="tc-tk-btn tc-tk-quiet" onClick={() => void sendTaskNow(task, x.id)}>
              {t.tb.sendNow}
            </button>
          )}
          {isActive(x.state) && (
            <button type="button" className="tc-tk-btn tc-tk-quiet" onClick={() => void stopTask(task, x.id)}>
              {t.tb.stop}
            </button>
          )}
        </div>
      ))}
    </Section>
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
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{report.summary}</p>
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

function Conversation({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  const [text, setText] = useState("");
  const on = activeTries(task).filter((x) => isLive(x.state));
  const [to, setTo] = useState<string | null>(null);
  const target = on.find((x) => x.id === to) ?? on[0] ?? null;
  return (
    <Section title={t.tb.conversation}>
      {task.messages.map((m) => (
        <div key={m.id} className="py-1.5">
          <p className="text-[12.5px] text-[var(--text-metadata)]">
            {m.by === "user" ? t.tb.actors.user : m.byName} · {t.tb.waited(ago(m.at, now))}
            {t.tb.said[m.state] && <span className={m.state === "failed" ? "text-[var(--red)]" : ""}> · {t.tb.said[m.state]}</span>}
          </p>
          <p className="whitespace-pre-wrap text-[14px]">{m.text}</p>
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          const words = text.trim();
          if (!words) return;
          setText("");
          void sayOnTask(task, words, target?.id).then((ok) => ok || setText(words));
        }}
      >
        {on.length > 1 && <Dropdown label={t.tb.conversation} value={target?.id ?? ""} options={on.map((x) => ({ value: x.id, label: x.name }))} size="md" onChange={setTo} />}
        <input className="tc-tk-input min-w-[160px] flex-1" aria-label={target ? t.tb.sayTo(target.name) : t.tb.sayNote} placeholder={target ? t.tb.sayTo(target.name) : t.tb.sayNote} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="tc-tk-btn" data-strong={!!text.trim()} disabled={!text.trim()}>
          {t.tb.send}
        </button>
      </form>
    </Section>
  );
}

function History({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  const [all, setAll] = useState(false);
  const entries = [...task.history].reverse();
  const shown = all ? entries : entries.slice(0, 5);
  const who = (by: string) => (by === "user" ? t.tb.actors.user : by === "tacit" ? t.tb.actors.tacit : (task.tries.find((x) => `terminal:${x.terminal}` === by)?.name ?? nameOf(by)));
  return (
    <Section title={t.tb.history}>
      {shown.map((h, i) => (
        <p key={`${h.at}-${i}`} className="tc-tk-hist">
          <span>
            {who(h.by)}: {h.text}
          </span>
          <span className="shrink-0 text-[var(--text-metadata)]">{t.tb.waited(ago(h.at, now))}</span>
        </p>
      ))}
      {entries.length > shown.length && (
        <button type="button" className="tc-tk-btn tc-tk-quiet" onClick={() => setAll(true)}>
          {t.tb.historyMore(entries.length - shown.length)}
        </button>
      )}
    </Section>
  );
}
function nameOf(by: string): string {
  const found = by.startsWith("terminal:") ? findTerminal(by.slice("terminal:".length)) : null;
  return found ? found.terminal.customTitle?.trim() || found.terminal.title : "Agent";
}

/* ---------- its details ---------- */

function Details({ task }: { task: Task }) {
  const t = useT();
  const now = useNow();
  const projects = useProjectStore((s) => s.projects);
  const tasks = useTaskStore((s) => s.tasks);
  const folderName = useFolderName(task.folder);
  const ready = readiness(task);
  const use = timeAndUse(task, now);
  const waiting = !task.closed && task.tries.length === 0;
  const folders = [
    { value: "", label: t.tb.noFolder },
    ...projects.flatMap((p) => p.worktrees.map((w) => ({ value: w.path, label: w.isPrimary || p.worktrees.length === 1 ? p.name : `${p.name} · ${w.name}`, detail: w.path }))),
    ...(task.folder && !projects.some((p) => p.worktrees.some((w) => w.path === task.folder)) ? [{ value: task.folder, label: folderName, detail: task.folder }] : []),
  ];
  const made = task.madeFrom;
  const parent = made?.kind === "task" && made.target ? tasks[made.target] : null;
  return (
    <aside aria-label={t.tb.details} className="tc-tk-side">
      {waiting && (!ready.described || !ready.doneWhen || !ready.folder) && (
        <section className="tc-tk-ready">
          <h3>{t.tb.ready}</h3>
          {(
            [
              [ready.described, t.tb.readyDescription],
              [ready.doneWhen, t.tb.readyDoneWhen],
              [ready.folder, t.tb.readyFolder],
            ] as const
          ).map(([yes, label]) => (
            <p key={label} className={yes ? "" : "text-[var(--text-metadata)]"}>
              <Dot column={yes ? "done" : "later"} hollow={!yes} /> {label}
            </p>
          ))}
        </section>
      )}
      <Row label={t.tb.kind}>
        <Dropdown label={t.tb.kind} value={task.kind} options={WORK_KINDS.map((k) => ({ value: k, label: t.tb.kinds[k] }))} onChange={(kind) => void changeTask(task, { op: "set", settings: { kind } })} />
      </Row>
      <Row label={t.tb.priority}>
        <Dropdown label={t.tb.priority} value={task.priority} options={PRIORITIES.map((p) => ({ value: p, label: t.tb.priorities[p] }))} onChange={(priority) => void changeTask(task, { op: "set", settings: { priority } })} />
      </Row>
      <Row label={t.tb.folder}>
        <Dropdown label={t.tb.folder} value={task.folder ?? ""} options={folders} onChange={(f) => void changeTask(task, { op: "set", settings: { folder: f || null } })} />
      </Row>
      <Row label={t.tb.check}>
        <Dropdown label={t.tb.check} value={task.check} options={CHECK_RULES.map((c) => ({ value: c, label: t.tb.checks[c] }))} onChange={(check) => void changeTask(task, { op: "set", settings: { check } })} />
      </Row>
      <section className="flex flex-col gap-1 border-t border-[var(--border)] pt-3">
        <span className="text-[13px] text-[var(--text-metadata)]">{t.tb.allowedTitle}</span>
        <TextArea task={task} field="allowed" label={t.tb.allowedTitle} hint={t.tb.allowedHint} min={38} />
        <span className="text-[12px] text-[var(--text-metadata)]">{t.tb.allowedNote}</span>
      </section>
      <section className="flex flex-col gap-0.5 border-t border-[var(--border)] pt-3">
        {task.landed && t.tb.landed[task.landed.state] && <Row label={t.tb.landedLabel}>{t.tb.landed[task.landed.state]}</Row>}
        {made && (
          <Row label={t.tb.madeFrom}>
            {parent ? (
              <button type="button" className="text-left hover:underline" onClick={() => openTask(parent.id)}>{`T-${parent.n} ${parent.title}`}</button>
            ) : made.kind === "note" && made.target ? (
              <button type="button" className="text-left hover:underline" onClick={() => goToNote(made.target!)}>{`${t.tb.madeFromKind.note}: ${made.label}`}</button>
            ) : (
              `${t.tb.madeFromKind[made.kind]}${made.label ? ` ${made.label}` : ""}`
            )}
          </Row>
        )}
        {task.ledTo.length > 0 && (
          <Row label={t.tb.ledTo}>
            <span className="flex flex-col items-start">
              {task.ledTo.map((id) => (tasks[id] ? <button key={id} type="button" className="text-left hover:underline" onClick={() => openTask(id)}>{`T-${tasks[id].n} ${tasks[id].title}`}</button> : null))}
            </span>
          </Row>
        )}
        {(use.minutes > 0 || use.tokens > 0) && <Row label={t.tb.time}>{[use.minutes ? t.tb.minutes(use.minutes) : "", use.tokens ? t.tb.tokens(use.tokens) : ""].filter(Boolean).join(", ")}</Row>}
        <Row label={t.tb.created}>{t.tb.waited(ago(task.created, now))}</Row>
      </section>
    </aside>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tc-tk-detail">
      <span className="text-[var(--text-metadata)]">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
