import { useEffect, useState } from "react";
import { useBrowserTabState } from "../stores/browserTabStateStore";
import { setBrowserNodeMuted } from "../browser/BrowserNodeMenu";
import { SpeakerIcon } from "../components/BrowserCard";
import { useT } from "../i18n/useT";

/**
 * A browser's mark in a tab or on its card, as in Chrome: its page's icon,
 * a spinner while it loads, the globe until an icon arrives.
 */
export function BrowserTabIcon({ cardId, favicon, size = 14 }: { cardId: string; favicon?: string; size?: number }) {
  const { loading } = useBrowserTabState(cardId);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [favicon]);
  if (loading) {
    return (
      <span
        className="shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--text-muted)] border-t-transparent"
        style={{ width: size - 2, height: size - 2, margin: 1 }}
        aria-hidden="true"
      />
    );
  }
  if (favicon && !broken) {
    return (
      <img
        src={favicon}
        alt=""
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
        draggable={false}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  );
}

/** A speaker on a tab that plays sound; clicking it mutes the page, or unmutes it. */
export function BrowserTabSound({ cardId }: { cardId: string }) {
  const t = useT();
  const { audible, muted } = useBrowserTabState(cardId);
  if (!audible && !muted) return null;
  const label = muted ? t.browser_menu_unmute : t.browser_menu_mute;
  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex shrink-0 rounded-[4px] p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        setBrowserNodeMuted(cardId, !muted);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        setBrowserNodeMuted(cardId, !muted);
      }}
    >
      <SpeakerIcon muted={muted} size={12} />
    </span>
  );
}
