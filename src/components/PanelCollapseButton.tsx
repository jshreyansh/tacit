import { useT } from "../i18n/useT";

/**
 * The one control that folds an open panel back into the left rail.
 *
 * There were three of these, drawn separately in three files, and they had
 * drifted into three different marks: a left chevron on Sessions and History,
 * a right chevron on Files / Diff / Git / Memory, and a × on the Hub. The
 * right chevron was honest while that panel opened on the right edge and
 * collapsed that way. Every panel hinges on the left rail now, so it pointed
 * away from where the panel actually goes.
 *
 * A left chevron for all three, because it names the motion: fold back to the
 * rail. A × would claim the surface is being dismissed, and nothing is —
 * the tab stays lit and the panel reopens exactly where you left it.
 *
 * One component rather than three copies, so the marks cannot drift again.
 */
export function PanelCollapseButton({
  onCollapse,
  className = "",
}: {
  onCollapse: () => void;
  className?: string;
}) {
  const t = useT();

  return (
    <button
      type="button"
      onClick={onCollapse}
      title={t.right_panel_collapse}
      aria-label={t.right_panel_collapse}
      className={`tc-row-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${className}`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M7 2L3 5L7 8"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
