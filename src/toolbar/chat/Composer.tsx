import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { useT } from "../../i18n/useT";
import type { ChatAttachResult, ChatAttachmentInfo } from "../../../shared/chat-events";
import { attachChatFiles, pickChatAttachments } from "../../actions/managerChatMode";
import { useNotificationStore } from "../../stores/notificationStore";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { AttachmentTray, PaperclipIcon } from "./Attachments";

/**
 * The message box both chats share: the files going with the message, the
 * text, and a row under it of attach, the chat's chips, the usage ring and
 * send. Files come from the attach button (the open dialog, in the chat's
 * folder), dropped on the box (from Finder or Tacit's Files panel), or a
 * pasted image.
 */

const MAX_ATTACHMENTS = 20;

export interface Attachments {
  items: ChatAttachmentInfo[];
  busy: boolean;
  pick: () => void;
  addFiles: (files: File[]) => void;
  addPaths: (paths: string[]) => void;
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
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = inputRef ?? ownRef;
  useAutoGrow(textRef, value);
  const takesDrop = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-tacit-file");
  return (
    <div
      data-composer-box=""
      className="@container relative flex flex-col gap-1.5 border px-3 pb-2 pt-2 transition-colors"
      style={{
        borderRadius: compact ? 12 : 14,
        cornerShape: "squircle",
        borderColor: dragging ? "var(--cyan)" : "var(--border-hover)",
        background: dragging ? "color-mix(in srgb, var(--cyan) 6%, var(--bg))" : "color-mix(in srgb, var(--bg) 70%, transparent)",
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
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
      <label className="min-w-0">
        <span className="sr-only">{placeholder}</span>
        <textarea
          ref={textRef}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={dragging ? t.chat_attach_drop : placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();
            attachments.addFiles(files);
          }}
          onKeyDown={(e) => {
            // The canvas listens globally for single-key shortcuts.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className={`block ${compact ? "max-h-32" : "max-h-[min(40vh,22rem)]"} min-h-[1.5rem] w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]`}
        />
      </label>
      <div className="flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          className="tc-rail-btn -ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
          onClick={attachments.pick}
          disabled={attachments.busy}
          aria-label={t.chat_attach}
          title={t.chat_attach_hint}
        >
          {attachments.busy ? <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : <PaperclipIcon size={15} />}
        </button>
        <span className="flex min-w-0 flex-1 items-center">{settings}</span>
        {meter && <span className="flex shrink-0 items-center">{meter}</span>}
        {trailing}
        {showSend && (
          <button
            type="button"
            className="ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] transition-opacity duration-quick disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
            disabled={!canSend}
            onClick={onSubmit}
            aria-label={t.project_chat_send}
            title={t.project_chat_send}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 13V3M4 7l4-4 4 4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
