import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { borrowTerminalView, fitTerminalRuntime } from "../terminal/terminalRuntimeStore";
import { usePinStore } from "../stores/pinStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { updatePinInScene } from "../actions/scenePinActions";
import { hasChatMode, requestManagerMove } from "../actions/managerChatMode";
import { panToTerminal, flyToBounds } from "../utils/panToTerminal";
import { useBrowserSnapshots } from "./browserSnapshots";
import type { BrowserCard, NoteCard, TerminalCard, WorkdeskCard } from "./workdeskModel";

/**
 * One node full size in the workdesk view's tabs (T7, G2). A terminal's
 * live view moves in from its tile, to read and type in, and goes back when
 * the tab closes; a browser shows a live picture of its page; a note opens
 * to edit.
 */

type Dict = ReturnType<typeof useT>;

const NOTE_SAVE_MS = 500;

export function showOnCanvas(card: WorkdeskCard): void {
  useWorkdeskViewStore.getState().setMode("canvas");
  if (card.kind === "terminal") {
    panToTerminal(card.id);
  } else if (card.kind === "browser") {
    const data = useBrowserCardStore.getState().cards[card.id];
    if (data) flyToBounds(data.x, data.y, data.w, data.h);
  } else {
    const pin = (usePinStore.getState().pinsByProject[card.projectPath] ?? []).find((p) => p.id === card.id);
    if (pin && typeof pin.x === "number" && typeof pin.y === "number") flyToBounds(pin.x, pin.y, pin.w ?? 280, pin.h ?? 200);
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
    const giveBack = borrowTerminalView(card.id, container);
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
        <Footer hint={card.title}>
          <button type="button" className={footButton} onClick={() => showOnCanvas(card)}>
            {t.workdesk_show_on_canvas}
          </button>
        </Footer>
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
      <Footer hint={card.subtitle}>
        {card.isManager && hasChatMode(card.type) && (
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
        )}
        <button type="button" className={footButton} onClick={() => showOnCanvas(card)}>
          {t.workdesk_show_on_canvas}
        </button>
      </Footer>
    </>
  );
}

function BrowserTab({ card, profile, t }: { card: BrowserCard; profile: string; t: Dict }) {
  const snapshots = useBrowserSnapshots([card.id], true, 1500);
  const picture = snapshots[card.id];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="tc-mono min-w-0 flex-1 truncate rounded-full bg-[var(--surface-hover)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
          {card.url}
        </span>
        <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{t.workdesk_profile(profile)}</span>
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[var(--bg)] p-3">
        {picture ? (
          <img src={picture} alt={card.title} className="max-w-full rounded-md border border-[var(--border)]" draggable={false} />
        ) : (
          <div className="self-center text-[12.5px] text-[var(--text-muted)]">{t.workdesk_no_snapshot}</div>
        )}
      </div>
      <Footer hint={t.workdesk_snapshot_hint}>
        <button type="button" className={footButton} onClick={() => showOnCanvas(card)}>
          {t.workdesk_show_on_canvas}
        </button>
      </Footer>
    </>
  );
}

function NoteTab({ card, t }: { card: NoteCard; t: Dict }) {
  const [body, setBody] = useState(card.body);
  const timer = useRef<number | null>(null);
  // Typing is saved shortly after it stops, and on leaving the tab.
  const pending = useRef<string | null>(null);
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) {
      updatePinInScene(card.projectPath, card.id, { body: pending.current });
      pending.current = null;
    }
  };
  useEffect(() => flush, [card.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-7 py-6">
        <div className="text-[18px] font-semibold text-[var(--text-primary)]">{card.title}</div>
        <label className="flex min-h-0 flex-1">
          <span className="sr-only">{card.title}</span>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              pending.current = e.target.value;
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(flush, NOTE_SAVE_MS);
            }}
            onBlur={flush}
            className="min-h-0 flex-1 resize-none bg-transparent text-[14px] leading-[1.8] text-[var(--text-secondary)] outline-none"
          />
        </label>
      </div>
      <Footer hint={t.workdesk_note}>
        <button type="button" className={footButton} onClick={() => showOnCanvas(card)}>
          {t.workdesk_show_on_canvas}
        </button>
      </Footer>
    </>
  );
}

export function WorkdeskTab({ card, profileName }: { card: WorkdeskCard; profileName: (identityId: string) => string }) {
  const t = useT();
  if (card.kind === "terminal") return <TerminalTab key={card.id} card={card} t={t} />;
  if (card.kind === "browser") return <BrowserTab key={card.id} card={card} profile={profileName(card.identityId)} t={t} />;
  return <NoteTab key={card.id} card={card} t={t} />;
}
