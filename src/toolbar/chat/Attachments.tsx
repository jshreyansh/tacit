import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessagePrimitive } from "@assistant-ui/react";
import { useT } from "../../i18n/useT";
import type { ChatAttachment } from "../../../shared/chat-events";

/**
 * Files sent with a message, as assistant-ui shows them: an image as its
 * picture, any other file as a tile with its name and type. In the message
 * box each can be removed; an image opens larger when clicked. The same
 * tiles sit above a sent message.
 */

type Shown = Pick<ChatAttachment, "name" | "kind" | "preview">;

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

/** The picture larger, over everything; Escape or a click closes it. */
function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
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
  return createPortal(
    <div
      role="dialog"
      aria-label={name}
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-2 p-8"
      style={{ background: "color-mix(in srgb, black 72%, transparent)" }}
      onClick={onClose}
    >
      <img src={src} alt={name} className="max-h-[80vh] max-w-[90vw] rounded-[10px] object-contain shadow-2xl" />
      <span className="max-w-[90vw] truncate text-[12px] text-white/75">{name}</span>
    </div>,
    document.body,
  );
}

export function AttachmentTile({ attachment, onRemove }: { attachment: Shown; onRemove?: () => void }) {
  const t = useT();
  const [viewing, setViewing] = useState(false);
  const picture = attachment.kind === "image" && attachment.preview;
  return (
    <div className="group/att relative shrink-0" title={attachment.name}>
      {picture ? (
        <button
          type="button"
          className="block h-14 w-14 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-hover)]"
          onClick={() => setViewing(true)}
          aria-label={t.chat_attachment_view(attachment.name)}
        >
          <img src={attachment.preview} alt="" className="h-full w-full object-cover" />
        </button>
      ) : (
        <div className="flex h-14 w-[150px] items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-hover)] px-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-[var(--bg)] text-[var(--text-muted)]">
            <FileIcon />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] text-[var(--text-primary)]">{attachment.name}</span>
            <span className="text-[10.5px] text-[var(--text-faint)]">{extensionOf(attachment.name) || t.chat_attachment_file}</span>
          </span>
        </div>
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
      {viewing && picture && <ImageViewer src={attachment.preview!} name={attachment.name} onClose={() => setViewing(false)} />}
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
