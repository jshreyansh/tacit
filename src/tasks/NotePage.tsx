import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { NOTE_MAX, goToNote, setNoteText, useNote } from "../board/notes";
import { useBoardStore } from "../stores/boardStore";
import { useTasks } from "./taskStore";
import { openTask } from "./taskActions";
import { startTaskFromNote } from "./noteTask";
import "./tasks.css";

/** A note, full size: the same words as its sticky. */
export function NotePage({ id, onCanvas }: { id: string; onCanvas?: boolean }) {
  const t = useT();
  const note = useNote(id);
  const tasks = useTasks().filter((x) => x.madeFrom?.kind === "note" && x.madeFrom.target === id);
  const [text, setText] = useState(note?.text ?? "");
  const typing = useRef(false);
  const marked = useRef(false);
  // An agent adding to it, or the sticky being typed in, shows here too.
  useEffect(() => {
    if (!typing.current && note) setText(note.text);
  }, [note?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    marked.current = false;
  }, [id]);
  if (!note) return <p className="tc-tk-empty-board">{t.tb.noteEmpty}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="tc-tk-head">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-metadata)]">{t.tb.noteHint}</span>
        {tasks.map((x) => (
          <button key={x.id} type="button" className="tc-tk-btn" data-quiet="true" onClick={() => openTask(x.id)}>{`T-${x.n}`}</button>
        ))}
        {onCanvas && (
          <button type="button" className="tc-tk-btn" data-quiet="true" onClick={() => goToNote(id)}>
            {t.tb.showOnCanvas}
          </button>
        )}
        <button type="button" className="tc-tk-btn" data-strong="true" onClick={() => startTaskFromNote(id)}>
          {t.tb.fromNote}
        </button>
      </div>
      <label className="flex min-h-0 flex-1">
        <span className="sr-only">{t.tb.noteLabel}</span>
        <textarea
          className="mx-auto w-full max-w-[760px] resize-none bg-transparent px-6 py-5 text-[15px] leading-[1.65] text-[var(--text-primary)] outline-none"
          value={text}
          maxLength={NOTE_MAX}
          placeholder={t.tb.noteHint}
          onFocus={() => {
            typing.current = true;
          }}
          onBlur={() => {
            typing.current = false;
            setText(note.text);
          }}
          onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
          onChange={(e) => {
            // One step to undo for a go at it, not one a letter.
            if (!marked.current) {
              useBoardStore.getState().checkpoint();
              marked.current = true;
            }
            setText(e.target.value);
            setNoteText(id, e.target.value);
          }}
        />
      </label>
    </div>
  );
}
