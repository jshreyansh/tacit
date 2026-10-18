import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { borrowTerminalView, fitTerminalRuntime } from "../terminal/terminalRuntimeStore";
import { usePinStore } from "../stores/pinStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { updatePinInScene } from "../actions/scenePinActions";
import { hasChatMode, requestManagerMove } from "../actions/managerChatMode";
import { panToTerminal, flyToBounds } from "../utils/panToTerminal";
import type { BrowserCard, NoteCard, TaskCard, TerminalCard, WorkdeskCard } from "./workdeskModel";
import type { Pin } from "../types";
import { TaskSections } from "../tasks/TaskParts";
import { deleteTask, handTaskToManager, makeNote, makeTask, updateTask } from "../tasks/taskActions";
import { showPinOnCanvas } from "../tasks/TasksView";

/**
 * One node full size in the workdesk view's tabs (T7, G2). A terminal's
 * live view moves in from its tile, to read and type in, and goes back when
 * the tab closes; a browser shows a live picture of its page; a note opens
 * to edit.
 */

type Dict = ReturnType<typeof useT>;

const NOTE_SAVE_MS = 500;
/** The app's own text size: a terminal in a tab reads like the chat beside it. */
const TAB_FONT_SIZE = 13;

/** The canvas, on this node: a task or note not on it yet is put there. */
export async function showOnCanvas(card: WorkdeskCard): Promise<void> {
  if (card.kind === "task" || card.kind === "note") {
    const pin = (usePinStore.getState().pinsByProject[card.projectPath] ?? []).find((p) => p.id === card.id);
    if (pin) return showPinOnCanvas(pin);
    useWorkdeskViewStore.getState().setMode("canvas");
    return;
  }
  useWorkdeskViewStore.getState().setMode("canvas");
  if (card.kind === "terminal") {
    panToTerminal(card.id);
  } else {
    const data = useBrowserCardStore.getState().cards[card.id];
    if (data) flyToBounds(data.x, data.y, data.w, data.h);
  }
}

function Footer({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3.5 py-2.5 text-[12px] text-[var(--text-muted)]">
      <span className="min-w-0 truncate">{hint}</span>
      <span className="ml-auto flex shrink-0 gap-1.5">{children}</span>
    </div>
  );
}

const footButton =
  "tc-rail-btn h-7 shrink-0 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]";

function TerminalTab({ card, t }: { card: TerminalCard; t: Dict }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [borrowed, setBorrowed] = useState(true);
  const openChat = useChatDockStore((s) => s.setOpen);

  useLayoutEffect(() => {
    if (!container || card.chatMode) return;
    const preferred = usePreferencesStore.getState().terminalFontSize;
    const giveBack = borrowTerminalView(card.id, container, Math.min(preferred, TAB_FONT_SIZE));
    setBorrowed(giveBack !== null);
    if (!giveBack) return;
    const fit = () => fitTerminalRuntime(card.id);
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => {
      observer.disconnect();
      giveBack();
    };
  }, [container, card.id, card.chatMode]);

  if (card.chatMode) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-[13px] text-[var(--text-primary)]">{t.workdesk_in_chat}</div>
          <button type="button" className={footButton} onClick={() => openChat(true)}>
            {t.chat_mode_show_chat}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="relative min-h-0 flex-1 bg-[var(--bg)]">
        <div ref={setContainer} className="absolute inset-0 m-2" />
        {!borrowed && (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-muted)]">
            {t.workdesk_terminal_canvas_only}
          </div>
        )}
      </div>
      {card.isManager && hasChatMode(card.type) && (
        <Footer hint={card.subtitle}>
          <button
            type="button"
            className={footButton}
            onClick={() => {
              requestManagerMove(card.id, "chat", card.state === "active");
              openChat(true);
            }}
          >
            {t.workdesk_open_as_chat}
          </button>
        </Footer>
      )}
    </>
  );
}

/**
 * The browser itself, usable: its tile is laid over this window at full
 * scale (CanvasCardLayer), address bar and profile included, and clicks
 * pass through to it. The tile never moves in the page, which would reload it.
 */
function BrowserTab({ card, t }: { card: BrowserCard; t: Dict }) {
  const [hole, setHole] = useState<HTMLDivElement | null>(null);
  const setProjection = useWorkdeskViewStore((s) => s.setProjection);
  useLayoutEffect(() => {
    if (!hole) return;
    const publish = () => {
      const box = hole.getBoundingClientRect();
      setProjection({ cardId: card.id, rect: { x: box.left, y: box.top, w: box.width, h: box.height } });
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(hole);
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      setProjection(null);
    };
  }, [hole, card.id, setProjection]);
  return (
    <>
      <div ref={setHole} className="pointer-events-none min-h-0 flex-1" />
    </>
  );
}

/** Typing in a field is saved shortly after it stops, and on leaving it. */
function useDebouncedSave(save: (value: string) => void) {
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) {
      save(pending.current);
      pending.current = null;
    }
  };
  const change = (value: string) => {
    pending.current = value;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, NOTE_SAVE_MS);
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { change, flush };
}

function usePin(projectPath: string, id: string): Pin | null {
  return usePinStore((s) => s.pinsByProject[projectPath]?.find((p) => p.id === id) ?? null);
}

/** A title you can edit where it is: saved on Enter or when you leave it. */
function EditableTitle({ pin, placeholder }: { pin: Pin; placeholder: string }) {
  const [title, setTitle] = useState(pin.title);
  useEffect(() => setTitle(pin.title), [pin.id, pin.title]);
  const commit = () => {
    const next = title.trim();
    if (next && next !== pin.title) void updateTask(pin, { title: next });
    else setTitle(pin.title);
  };
  return (
    <label className="block">
      <span className="sr-only">{placeholder}</span>
      <input
        value={title}
        placeholder={placeholder}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded-md bg-transparent px-1.5 py-1 text-[20px] font-semibold text-[var(--text-primary)] outline-none focus:bg-[var(--surface-hover)]"
      />
    </label>
  );
}

function BodyField({ pin, placeholder, minHeight }: { pin: Pin; placeholder: string; minHeight: number }) {
  const [body, setBody] = useState(pin.body);
  useEffect(() => setBody(pin.body), [pin.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { change, flush } = useDebouncedSave((value) => void updateTask(pin, { body: value }));
  return (
    <label className="flex">
      <span className="sr-only">{placeholder}</span>
      <textarea
        value={body}
        placeholder={placeholder}
        onChange={(e) => {
          setBody(e.target.value);
          change(e.target.value);
        }}
        onBlur={flush}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ minHeight }}
        className="w-full resize-y rounded-[9px] border border-[var(--border)] bg-transparent px-3 py-2 text-[13.5px] leading-[1.7] text-[var(--text-secondary)] outline-none focus:border-[var(--border-hover)]"
      />
    </label>
  );
}

function TaskTab({ card, t }: { card: TaskCard; t: Dict }) {
  const pin = usePin(card.projectPath, card.id);
  const [armDelete, setArmDelete] = useState(false);
  if (!pin) return null;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-7 py-6">
          <EditableTitle pin={pin} placeholder={t.task_title_placeholder} />
          <TaskSections task={pin} />
          <section className="flex flex-col gap-2" aria-label={t.task_notes}>
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{t.task_notes}</span>
            <BodyField pin={pin} placeholder={t.note_body_placeholder} minHeight={90} />
          </section>
        </div>
      </div>
      <Footer hint={t.workdesk_tasks}>
        {(pin.owners ?? []).every((o) => o !== "manager") && pin.status !== "done" && (
          <button type="button" className={footButton} onClick={() => void handTaskToManager(pin)}>
            {t.task_hand}
          </button>
        )}
        <button type="button" className={footButton} onClick={() => void makeNote(pin)}>
          {t.task_make_note}
        </button>
        <button
          type="button"
          className={`${footButton} !text-[var(--red)]`}
          onClick={() => {
            if (armDelete) void deleteTask(pin);
            else setArmDelete(true);
          }}
          onBlur={() => setArmDelete(false)}
        >
          {armDelete ? t.task_delete_confirm : t.task_delete}
        </button>
      </Footer>
    </>
  );
}

function NoteTab({ card, t }: { card: NoteCard; t: Dict }) {
  const pin = usePin(card.projectPath, card.id);
  if (!pin) return null;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[780px] flex-col gap-3 px-7 py-6">
          <EditableTitle pin={pin} placeholder={t.note_title_placeholder} />
          <BodyField pin={pin} placeholder={t.note_body_placeholder} minHeight={360} />
        </div>
      </div>
      <Footer hint={t.workdesk_note}>
        <button type="button" className={footButton} onClick={() => void makeTask(pin)}>
          {t.note_make_task}
        </button>
      </Footer>
    </>
  );
}

export function WorkdeskTab({ card }: { card: WorkdeskCard }) {
  const t = useT();
  if (card.kind === "terminal") return <TerminalTab key={card.id} card={card} t={t} />;
  if (card.kind === "browser") return <BrowserTab key={card.id} card={card} t={t} />;
  if (card.kind === "task") return <TaskTab key={card.id} card={card} t={t} />;
  return <NoteTab key={card.id} card={card} t={t} />;
}
