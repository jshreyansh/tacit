import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/useT";
import { useChatDockStore, type ChatPlacement } from "../../stores/chatDockStore";

/**
 * The chat header's ⋮: where the chat lives (docked, popped out or full
 * screen), and going to the manager's tile. The menu is laid on the page,
 * so the chat's clipped frame doesn't cut it off.
 */

type Extra = { label: string; onClick: () => void; disabled?: boolean };

function PlacementIcon({ placement }: { placement: ChatPlacement }) {
  const common = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (placement) {
    case "dock":
      return (
        <svg {...common}>
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <path d="M6.5 2.5v11" />
        </svg>
      );
    case "float":
      return (
        <svg {...common}>
          <rect x="2" y="2.5" width="12" height="11" rx="2" opacity="0.45" />
          <rect x="7" y="7" width="6" height="5" rx="1.2" />
        </svg>
      );
    case "full":
      return (
        <svg {...common} strokeLinecap="round">
          <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" />
        </svg>
      );
  }
}

export function ChatPlacementMenu({ buttonClass, extras }: { buttonClass: string; extras: Extra[] }) {
  const t = useT();
  const placement = useChatDockStore((s) => s.placement);
  const setPlacement = useChatDockStore((s) => s.setPlacement);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const places: { id: ChatPlacement; label: string }[] = [
    { id: "dock", label: t.chat_place_dock },
    { id: "float", label: t.chat_place_float },
    { id: "full", label: t.chat_place_full },
  ];
  const rect = open ? buttonRef.current?.getBoundingClientRect() : undefined;
  const item = "tc-rail-btn flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-[12.5px] text-[var(--text-primary)] disabled:opacity-45";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        data-on={open ? "" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.chat_more}
        title={t.chat_more}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3.5" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="8" cy="12.5" r="1.25" />
        </svg>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t.chat_more}
            className="tc-float tc-enter-fade-down fixed z-[1000] w-[230px] p-1.5"
            style={{ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238)), borderRadius: 12 }}
          >
            <div className="px-2.5 pb-1 pt-0.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-faint)]">{t.chat_place_title}</div>
            {places.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={placement === p.id}
                className={item}
                data-on={placement === p.id ? "" : undefined}
                onClick={() => {
                  setOpen(false);
                  setPlacement(p.id);
                }}
              >
                <span className="flex w-4 shrink-0 justify-center text-[var(--text-muted)]">
                  <PlacementIcon placement={p.id} />
                </span>
                <span className="flex-1">{p.label}</span>
                {placement === p.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </button>
            ))}
            {extras.length > 0 && <div className="mx-2 my-1 h-px bg-[var(--border)]" />}
            {extras.map((x) => (
              <button
                key={x.label}
                type="button"
                role="menuitem"
                className={item}
                disabled={x.disabled}
                onClick={() => {
                  setOpen(false);
                  x.onClick();
                }}
              >
                <span className="w-4 shrink-0" />
                {x.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
