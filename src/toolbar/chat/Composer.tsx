import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { useT } from "../../i18n/useT";
import type { ChatAttachResult, ChatAttachmentInfo } from "../../../shared/chat-events";
import { attachChatFiles, attachChatScreenshot, pickChatAttachments } from "../../actions/managerChatMode";
import { useNotificationStore } from "../../stores/notificationStore";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { AttachmentTray } from "./Attachments";
import { AddMenu, SuggestList, useWorkdeskRefs } from "./ComposerAssist";
import { chatCommands, filterRefs, replaceTrigger, triggerAt, type WorkdeskRef } from "./composerRefs";
import type { SlashCommand } from "../../terminal/slashCommands";

/**
 * The message box both chats share: the files going with the message, the
 * text, and a row under it of +, the chat's chips, the usage ring and send.
 * The + adds files or folders (the open dialog) or something from the
 * workdesk; typing @ points at a chat, page, file or task; / at the start
 * offers the agent's commands. Files can also be dropped on the box (from
 * Finder or the navigator) or an image pasted.
 */

const MAX_ATTACHMENTS = 20;

export interface Attachments {
  items: ChatAttachmentInfo[];
  busy: boolean;
  pick: () => void;
  addFiles: (files: File[]) => void;
  addPaths: (paths: string[]) => void;
  /** Part of the window, captured as an image. */
  addScreenshot: (rect: { x: number; y: number; width: number; height: number }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export function useAttachments(terminalId: string | null): Attachments {
  const [items, setItems] = useState<ChatAttachmentInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const run = useCallback((pending: Promise<ChatAttachResult>) => {
    setBusy(true);
    pending
      .then((result) => {
        setItems((prev) => [...prev, ...result.attachments].slice(0, MAX_ATTACHMENTS));
        if (result.errors.length) useNotificationStore.getState().notify("warn", result.errors.join("\n"));
      })
      .catch((error: unknown) => useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  }, []);
  return {
    items,
    busy,
    pick: () => {
      if (terminalId) run(pickChatAttachments(terminalId));
    },
    addFiles: (files) => {
      if (files.length) run(attachChatFiles(files));
    },
    addPaths: (paths) => {
      if (paths.length) run(attachChatFiles({ paths }));
    },
    addScreenshot: (rect) => run(attachChatScreenshot(rect)),
    remove: (id) => setItems((prev) => prev.filter((a) => a.id !== id)),
    clear: () => setItems([]),
  };
}

export function ComposerBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  inputRef,
  rows = 2,
  attachments,
  settings,
  meter,
  trailing,
  showSend = true,
  canSend,
  compact = false,
  behind,
  place,
  running = false,
  onStop,
  agent,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  rows?: number;
  attachments: Attachments;
  /** The model, effort and mode chips. */
  settings?: ReactNode;
  /** The usage ring, beside send. */
  meter?: ReactNode;
  /** Stop, while a turn runs. */
  trailing?: ReactNode;
  showSend?: boolean;
  canSend: boolean;
  compact?: boolean;
  /**
   * What waits behind the box: a question, an approval, a plan, a queued
   * message. Drawn above it, tucked under its top edge.
   */
  behind?: ReactNode;
  /** Where the agent works, on a line under the box. */
  place?: ReactNode;
  /** A turn is running: with nothing typed, Send becomes Stop. */
  running?: boolean;
  onStop?: () => void;
  /** Whose chat it is, for the / commands it takes. */
  agent?: string;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = inputRef ?? ownRef;
  useAutoGrow(textRef, value);
  const takesDrop = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-tacit-file");
  // Running with nothing typed: the send button stops the turn instead.
  const stopping = running && !!onStop && !canSend;

  // @ and /: what's being typed at the caret opens a list above the box.
  const refs = useWorkdeskRefs();
  const [trigger, setTrigger] = useState<ReturnType<typeof triggerAt>>(null);
  const [active, setActive] = useState(0);
  const mentionHits = trigger?.kind === "mention" ? filterRefs(refs, trigger.query) : [];
  const commandHits = trigger?.kind === "command" ? chatCommands(agent ?? "", trigger.query) : [];
  const hitCount = trigger?.kind === "mention" ? mentionHits.length : commandHits.length;
  // A / with nothing this agent takes stays plain text, with no list.
  const suggesting = !!trigger && (trigger.kind === "mention" || commandHits.length > 0);
  const readTrigger = (text: string, caret: number | null) => {
    const next = caret === null ? null : triggerAt(text, caret);
    setTrigger(next);
    setActive(0);
  };
  const putCaret = (at: number) =>
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  const insertAtTrigger = (text: string) => {
    if (!trigger) return;
    const caret = textRef.current?.selectionStart ?? value.length;
    const next = replaceTrigger(value, trigger.start, caret, text);
    onChange(next.text);
    setTrigger(null);
    putCaret(next.caret);
  };
  /** From @ or the +: a file goes with the message; anything else is written in. */
  const pickRef = (ref: WorkdeskRef, fromTrigger: boolean) => {
    if ("path" in ref.insert) {
      attachments.addPaths([ref.insert.path]);
      if (fromTrigger) insertAtTrigger("");
      return;
    }
    const text = `${ref.insert.text} `;
    if (fromTrigger) return insertAtTrigger(text);
    const el = textRef.current;
    const at = el?.selectionStart ?? value.length;
    const before = value.slice(0, at);
    const spaced = before && !/\s$/.test(before) ? ` ${text}` : text;
    onChange(before + spaced + value.slice(at));
    putCaret(at + spaced.length);
  };
  const pickCommand = (command: SlashCommand) => insertAtTrigger(`${command.command} `);
  return (
    <div className="flex min-w-0 flex-col">
    {behind && <div className="flex flex-col">{behind}</div>}
    <div
      data-composer-box=""
      className="@container relative z-[1] flex flex-col gap-1.5 border px-3 pb-2 pt-2.5 transition-colors"
      style={{
        borderRadius: compact ? 20 : 24,
        cornerShape: "squircle",
        borderColor: dragging ? "var(--cyan)" : "color-mix(in srgb, var(--text-primary) 15%, transparent)",
        background: dragging ? "color-mix(in srgb, var(--cyan) 6%, var(--bg))" : "color-mix(in srgb, var(--bg) 94%, var(--surface))",
        boxShadow: "0 0 0 4px color-mix(in srgb, var(--text-primary) 2.5%, transparent), 0 -10px 26px rgba(0, 0, 0, 0.22)",
      } as React.CSSProperties}
      onDragOver={(e) => {
        if (!takesDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!takesDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        // Tacit's Files panel gives paths; Finder gives files.
        const fromPanel = e.dataTransfer.getData("application/x-tacit-file");
        if (fromPanel) attachments.addPaths(fromPanel.split("\n").filter(Boolean));
        else attachments.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {suggesting && trigger && (
        <SuggestList
          kind={trigger.kind}
          refs={mentionHits}
          commands={commandHits}
          active={active}
          onActive={setActive}
          onPickRef={(ref) => pickRef(ref, true)}
          onPickCommand={pickCommand}
        />
      )}
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
      <label className="min-w-0">
        <span className="sr-only">{placeholder}</span>
        <textarea
          ref={textRef}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={dragging ? t.chat_attach_drop : placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            readTrigger(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => readTrigger(value, e.currentTarget.selectionStart)}
          onBlur={() => setTrigger(null)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();
            attachments.addFiles(files);
          }}
          onKeyDown={(e) => {
            // The canvas listens globally for single-key shortcuts.
            e.stopPropagation();
            if (suggesting && hitCount > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (i + (e.key === "ArrowDown" ? 1 : hitCount - 1)) % hitCount);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (trigger?.kind === "mention") pickRef(mentionHits[active] ?? mentionHits[0], true);
                else pickCommand(commandHits[active] ?? commandHits[0]);
                return;
              }
            }
            if (suggesting && e.key === "Escape") {
              e.preventDefault();
              setTrigger(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className={`block ${compact ? "max-h-32" : "max-h-[min(40vh,22rem)]"} min-h-[1.5rem] w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]`}
        />
      </label>
      <div className="flex min-w-0 items-center gap-0.5">
        <AddMenu busy={attachments.busy} onPickFiles={attachments.pick} onPickRef={(ref) => pickRef(ref, false)} onScreenshot={attachments.addScreenshot} />
        <span className="flex min-w-0 flex-1 items-center">{settings}</span>
        {meter && <span className="flex shrink-0 items-center">{meter}</span>}
        {trailing}
        {running && (
          <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 text-[12px]" style={{ color: "var(--cyan)" }}>
            <span className="tc-live-pip inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--cyan)" }} />
            <span className="@max-[300px]:hidden">{t.chat_working}</span>
          </span>
        )}
        {stopping ? (
          <button
            type="button"
            className="tc-sq-ctl ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center"
            style={{ background: "var(--text-primary)", color: "var(--bg)" }}
            onClick={onStop}
            aria-label={t.project_chat_stop}
            title={t.project_chat_stop}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect width="10" height="10" rx="2.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          showSend && (
            <button
              type="button"
              className="tc-sq-ctl ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center transition-opacity duration-quick disabled:opacity-40"
              style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
              disabled={!canSend}
              onClick={onSubmit}
              aria-label={t.project_chat_send}
              title={t.project_chat_send}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 13V3.5M4 7.5l4-4 4 4" />
              </svg>
            </button>
          )
        )}
      </div>
    </div>
    {place}
    </div>
  );
}
