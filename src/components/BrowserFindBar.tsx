import { useEffect, useRef } from "react";
import { useBrowserFindStore } from "../stores/browserFindStore";
import { useT } from "../i18n/useT";

interface Props {
  cardId: string;
}

/**
 * Chrome's find bar, in a canvas tile. Same position, same shape, same two
 * arrows — the point of this feature is that nobody has to learn it.
 *
 * Visually a sibling of TerminalFindOverlay, minus the match-case / whole-word
 * / regex toggles, which Chrome's own find bar does not have either.
 */
export function BrowserFindBar({ cardId }: Props) {
  const t = useT();
  const openCardId = useBrowserFindStore((s) => s.openCardId);
  const query = useBrowserFindStore((s) => s.query);
  const activeMatch = useBrowserFindStore((s) => s.activeMatch);
  const matches = useBrowserFindStore((s) => s.matches);
  const focusNonce = useBrowserFindStore((s) => s.focusNonce);
  const setQuery = useBrowserFindStore((s) => s.setQuery);
  const findNext = useBrowserFindStore((s) => s.findNext);
  const findPrevious = useBrowserFindStore((s) => s.findPrevious);
  const close = useBrowserFindStore((s) => s.close);

  const inputRef = useRef<HTMLInputElement>(null);
  const isOpen = openCardId === cardId;

  // Focus on open and on every re-press. This one has to steal focus from the
  // guest itself: the chord most often arrives while the page owns the
  // keyboard, forwarded from main, and without the steal the bar would appear
  // with the user's typing still going into the page behind it.
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, focusNonce]);

  if (!isOpen) return null;

  const counterText =
    query && matches > 0
      ? `${activeMatch} / ${matches}`
      : query
        ? t.browser_find_no_match
        : "";

  const navIconClass =
    "shrink-0 rounded p-1 text-[var(--text-faint)] hover:bg-[var(--border)] hover:text-[var(--text-primary)] transition-colors duration-100";

  return (
    <div
      className="absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] px-2 py-1 shadow-lg backdrop-blur-sm"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{ minWidth: 220, maxWidth: "calc(100% - 16px)" }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t.browser_find_placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="min-w-0 flex-1 bg-transparent py-1 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
        style={{ fontFamily: '"Geist Mono", monospace' }}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Stopped here so the canvas's own shortcut listener never sees text
          // typed into this box — Escape and Enter included.
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) findPrevious();
            else findNext();
          }
        }}
      />
      {counterText && (
        <span
          className="shrink-0 text-[10px] text-[var(--text-faint)] tabular-nums"
          style={{ fontFamily: '"Geist Mono", monospace' }}
        >
          {counterText}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5 border-l border-[var(--border)] pl-1.5">
        <button
          type="button"
          title={t.browser_find_previous}
          className={navIconClass}
          onClick={findPrevious}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path
              d="M2.5 6.5L5 4l2.5 2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          title={t.browser_find_next}
          className={navIconClass}
          onClick={findNext}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path
              d="M2.5 3.5L5 6l2.5-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <button
        type="button"
        title={t.browser_find_close}
        className="shrink-0 rounded p-1 text-[var(--text-faint)] transition-colors duration-100 hover:bg-[var(--border)] hover:text-[var(--red)]"
        onClick={close}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path
            d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
