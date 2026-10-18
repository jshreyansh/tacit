import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessagePrimitive } from "@assistant-ui/react";
import { useT } from "../../i18n/useT";
import type { ChatAttachment } from "../../../shared/chat-events";
import { attachmentUrl, quickLookAttachment } from "../../actions/managerChatMode";
import { useNotificationStore } from "../../stores/notificationStore";
import { markdownClassName, renderMarkdown } from "../../utils/markdownClass";
import { previewKind, UNHELD_PREFIX, type PreviewKind } from "./attachmentPreview";

/**
 * Files sent with a message, as assistant-ui shows them: an image as its
 * picture, any other file as a tile with its thumbnail (a PDF's first page,
 * a video frame), name and type. In the message box each can be removed.
 * Clicking one opens it: images, video, audio, Markdown and text in Tacit's
 * viewer, anything else (PDF, slides, documents) in the Mac's Quick Look.
 * The same tiles sit above a sent message.
 */

type Shown = Pick<ChatAttachment, "id" | "name" | "kind" | "preview">;

export function PaperclipIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 7.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5l5.6-5.6a2.1 2.1 0 013 3l-5.6 5.6a1.1 1.1 0 01-1.5-1.5L10.4 4.6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z" />
      <path d="M9 1.75V5.25h3.5" />
    </svg>
  );
}

function extensionOf(name: string): string {
  return /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toUpperCase() ?? "";
}

/** A text file's contents, read once; long ones are cut short. */
function useFileText(url: string | null): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((text) => !cancelled && setState({ text: text.length > 500_000 ? `${text.slice(0, 500_000)}\n…` : text, error: null }))
      .catch((e: unknown) => !cancelled && setState({ text: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

function ViewerBody({ kind, url, name }: { kind: PreviewKind; url: string; name: string }) {
  const t = useT();
  const { text, error } = useFileText(kind === "markdown" || kind === "text" ? url : null);
  switch (kind) {
    case "image":
      return <img src={url} alt={name} className="max-h-full max-w-full rounded-[10px] object-contain" />;
    case "video":
      return <video src={url} controls autoPlay className="max-h-full max-w-full rounded-[10px] bg-black" />;
    case "audio":
      return <audio src={url} controls autoPlay className="w-[min(480px,80vw)]" />;
    case "markdown":
    case "text":
      if (error) return <div className="text-[13px] text-[var(--text-muted)]">{t.chat_attachment_unreadable}</div>;
      if (text === null) return <div className="text-[13px] text-[var(--text-muted)]">{t.loading}</div>;
      return (
        <div className="h-full w-full overflow-auto rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-6 py-5">
          {kind === "markdown" ? (
            <div className={markdownClassName} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-[var(--text-secondary)]">{text}</pre>
          )}
        </div>
      );
    default:
      return null;
  }
}

/** The file larger, over everything; Escape, the close button or a click outside closes it. */
function AttachmentViewer({ id, name, kind, onClose }: { id: string; name: string; kind: PreviewKind; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const boxed = kind === "markdown" || kind === "text";
  return createPortal(
    <div
      role="dialog"
      aria-label={name}
      className="fixed inset-0 z-[1000] flex flex-col items-center gap-3 px-8 pb-8 pt-5"
      style={{ background: "color-mix(in srgb, black 76%, transparent)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-[1100px] shrink-0 items-center gap-3 text-white/80" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-[8px] border border-white/20 px-2.5 text-[12px] hover:bg-white/10"
          onClick={() => void quickLookAttachment(id).catch(notifyError)}
        >
          {t.chat_attachment_quick_look}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-[8px] hover:bg-white/10"
          onClick={onClose}
          aria-label={t.close}
          title={t.close}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div
        className={`flex min-h-0 w-full flex-1 items-center justify-center ${boxed ? "max-w-[900px]" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <ViewerBody kind={kind} url={attachmentUrl(id)} name={name} />
      </div>
    </div>,
    document.body,
  );
}

const notifyError = (error: unknown) => useNotificationStore.getState().notify("warn", error instanceof Error ? error.message : String(error));

export function AttachmentTile({ attachment, onRemove }: { attachment: Shown; onRemove?: () => void }) {
  const t = useT();
  const [viewing, setViewing] = useState(false);
  const kind = previewKind(attachment.name);
  const id = attachment.id && !attachment.id.startsWith(UNHELD_PREFIX) ? attachment.id : null;
  const open = id
    ? () => {
        if (kind === "quicklook") void quickLookAttachment(id).catch(notifyError);
        else setViewing(true);
      }
    : undefined;
  const label = id ? t.chat_attachment_view(attachment.name) : attachment.name;
  return (
    <div className="group/att relative shrink-0" title={attachment.name}>
      {attachment.kind === "image" && attachment.preview ? (
        <button
          type="button"
          className="block h-14 w-14 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-hover)] disabled:cursor-default"
          onClick={open}
          disabled={!open}
          aria-label={label}
        >
          <img src={attachment.preview} alt="" className="h-full w-full object-cover" />
        </button>
      ) : (
        <button
          type="button"
          className="flex h-14 w-[160px] items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-hover)] px-2 text-left hover:border-[var(--border-hover)] disabled:cursor-default disabled:hover:border-[var(--border)]"
          onClick={open}
          disabled={!open}
          aria-label={label}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-[var(--bg)] text-[var(--text-muted)]">
            {attachment.preview ? <img src={attachment.preview} alt="" className="h-full w-full object-cover" /> : <FileIcon />}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] text-[var(--text-primary)]">{attachment.name}</span>
            <span className="text-[10.5px] text-[var(--text-faint)]">{extensionOf(attachment.name) || t.chat_attachment_file}</span>
          </span>
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border-hover)] bg-[var(--bg)] text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/att:opacity-100"
          onClick={onRemove}
          aria-label={t.chat_attachment_remove(attachment.name)}
          title={t.chat_attachment_remove(attachment.name)}
        >
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
      {viewing && id && <AttachmentViewer id={id} name={attachment.name} kind={kind} onClose={() => setViewing(false)} />}
    </div>
  );
}

/** The files waiting to go with the message, above its text. */
export function AttachmentTray({ items, onRemove }: { items: readonly (Shown & { id: string })[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 pt-1.5">
      {items.map((a) => (
        <AttachmentTile key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
      ))}
    </div>
  );
}

/** A sent message's files, from assistant-ui's message attachments. */
export function SentAttachments() {
  return (
    <div className="mb-1.5 flex max-w-[86%] flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {({ attachment }) => {
          const image = attachment.content?.find((part) => part.type === "image");
          return (
            <AttachmentTile
              attachment={{
                id: attachment.id,
                name: attachment.name,
                kind: attachment.type === "image" ? "image" : "file",
                ...(image && "image" in image ? { preview: image.image } : {}),
              }}
            />
          );
        }}
      </MessagePrimitive.Attachments>
    </div>
  );
}
