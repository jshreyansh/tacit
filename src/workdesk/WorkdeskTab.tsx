import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { borrowTerminalView, fitTerminalRuntime, useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { usePinStore } from "../stores/pinStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { updatePinInScene } from "../actions/scenePinActions";
import { hasChatMode, requestManagerMove } from "../actions/managerChatMode";
import type { BrowserCard, NoteCard, TabCard, TaskCard, TerminalCard } from "./workdeskModel";
import { PastSessionTab } from "../toolbar/SessionReader";
import { FileEditorDrawer } from "../components/FileEditorDrawer";
import { SessionChatBody } from "../toolbar/chat/SessionChat";
import { useManagerTranscript, usePendingManagerMove } from "../stores/managerChatStore";
import { cancelManagerMove, moveManagerNow } from "../actions/managerChatMode";
import type { Pin } from "../types";
import { TaskSections } from "../tasks/TaskParts";
import { deleteTask, handTaskToManager, makeNote, makeTask, updateTask } from "../tasks/taskActions";

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

/**
 * Terminal or Chat, for an agent that has a chat mode (Claude, Codex):
 * moving stops the process the turn runs in, so mid-turn it waits for the
 * turn to end, with Switch now and Cancel.
 */
function ViewSwitch({ card, busy, t }: { card: TerminalCard; busy: boolean; t: Dict }) {
  const pending = usePendingManagerMove(card.id);
  const openChat = useChatDockStore((s) => s.setOpen);
  const pick = (to: "terminal" | "chat") => {
    if ((to === "chat") === card.chatMode) return;
    requestManagerMove(card.id, to, busy);
    // The manager's chat lives in the dock.
    if (to === "chat" && card.isManager) openChat(true);
  };
  const segment = (to: "terminal" | "chat", label: string) => {
    const on = (to === "chat") === card.chatMode;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={on}
        className="h-6 rounded-[6px] px-2.5 text-[11.5px] transition-colors duration-quick"
        style={{ background: on ? "var(--surface-hover)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-muted)", fontWeight: on ? 600 : 500 }}
        onClick={() => pick(to)}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]">
        {pending ? (pending === "terminal" ? t.chat_move_pending_terminal : t.chat_move_pending_chat) : card.subtitle}
      </span>
      {pending && (
        <>
          <button type="button" className={footButton} onClick={() => moveManagerNow(card.id)} title={t.chat_move_now_hint}>
            {t.chat_move_now}
          </button>
          <button type="button" className={footButton} onClick={() => cancelManagerMove(card.id)}>
            {t.cancel}
          </button>
        </>
      )}
      <div role="tablist" aria-label={t.workdesk_view_as} className="flex gap-0.5 rounded-[8px] border border-[var(--border)] p-0.5">
        {segment("terminal", t.workdesk_view_terminal)}
        {segment("chat", t.workdesk_view_chat)}
      </div>
    </div>
  );
}

function TerminalTab({ card, t }: { card: TerminalCard; t: Dict }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [borrowed, setBorrowed] = useState(true);
  const openChat = useChatDockStore((s) => s.setOpen);
  const transcript = useManagerTranscript(card.chatMode ? card.id : null);
  const switchable = hasChatMode(card.type);
  const busy = card.chatMode ? transcript.running : card.state === "active";
  // A move asked for mid-turn happens when the turn ends (the pill does
  // this for the manager); one that no longer applies is dropped.
  const pending = usePendingManagerMove(card.id);
  useEffect(() => {
    if (card.isManager || !pending) return;
    if ((pending === "terminal") !== card.chatMode) cancelManagerMove(card.id);
    else if (!busy) requestManagerMove(card.id, pending, false);
  }, [pending, busy, card.chatMode, card.isManager, card.id]);

  // A runtime built after the tab opened (a terminal just added), or rebuilt
  // under it, is borrowed again, as the tile re-attaches (TerminalTile).
  const runtimeEpoch = useTerminalRuntimeStore((s) => s.terminals[card.id]?.epoch ?? 0);
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
  }, [container, card.id, card.chatMode, runtimeEpoch]);

  return (
    <>
      {switchable && <ViewSwitch card={card} busy={busy} t={t} />}
      {card.chatMode ? (
        card.isManager ? (
          // The manager's chat is the docked one.
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="text-[13px] text-[var(--text-primary)]">{t.workdesk_in_chat}</div>
            <button type="button" className={footButton} onClick={() => openChat(true)}>
              {t.chat_mode_show_chat}
            </button>
          </div>
        ) : (
          <div className="mx-auto flex min-h-0 w-full max-w-[780px] flex-1 flex-col">
            <SessionChatBody terminalId={card.id} agent={card.type} />
          </div>
        )
      ) : (
        <div className="relative min-h-0 flex-1 bg-[var(--bg)]">
          <div ref={setContainer} className="absolute inset-0 m-2" />
          {!borrowed && (
            <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-muted)]">
              {t.workdesk_terminal_canvas_only}
            </div>
          )}
        </div>
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

export function WorkdeskTab({ card }: { card: TabCard }) {
  const t = useT();
  if (card.kind === "session") return <PastSessionTab key={card.id} filePath={card.id} />;
  if (card.kind === "file") {
    return (
      <FileEditorDrawer
        key={card.id}
        embedded={{
          path: card.id,
          onClose: () => {
            const view = useWorkdeskViewStore.getState();
            view.closeFile(card.id);
            view.setOpenNode(null);
          },
        }}
      />
    );
  }
  if (card.kind === "terminal") return <TerminalTab key={card.id} card={card} t={t} />;
  if (card.kind === "browser") return <BrowserTab key={card.id} card={card} t={t} />;
  if (card.kind === "task") return <TaskTab key={card.id} card={card} t={t} />;
  return <NoteTab key={card.id} card={card} t={t} />;
}
