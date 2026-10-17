import { useUpdaterStore } from "../stores/updaterStore";
import type { useT } from "../i18n/useT";

/**
 * The update indicator: renders only when there is something to say. Moved
 * from the right rail to the foot of the left bar when the right rail went
 * away; its whole job is to be noticed without being looked for.
 */

const buttonCls =
  "tc-rail-btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center text-[var(--text-muted)] transition-[background-color,transform,color] duration-quick active:scale-[0.94] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] motion-reduce:transition-none";
const updateButtonClass = buttonCls;

const ICON_BUTTON_TRANSITION = {
  transition:
    "background-color var(--duration-quick) var(--ease-out-soft), color var(--duration-quick) var(--ease-out-soft), transform var(--duration-instant) var(--ease-out-soft)",
} as React.CSSProperties;

type UpdateStatus = ReturnType<typeof useUpdaterStore.getState>["status"];

export function UpdateStatusButton({
  status,
  t,
  onClick,
}: {
  status: UpdateStatus;
  t: ReturnType<typeof useT>;
  onClick: () => void;
}) {
  const label =
    status === "downloading"
      ? t.update_downloading
      : status === "ready"
        ? t.update_ready
        : status === "error"
          ? t.update_error
          : t.update_checking;

  return (
    <button
      type="button"
      // Pop on every status transition so a state change reads as
      // an event, not a silent swap. Keyed on status to remount.
      key={status}
      className={`${updateButtonClass} tc-enter-pop relative motion-reduce:animate-none`}
      style={ICON_BUTTON_TRANSITION}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {status === "downloading" ? (
        <ArrowDownIcon className="motion-safe:animate-bounce" />
      ) : status === "ready" ? (
        <>
          <ArrowUpIcon />
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-[var(--green)] ring-2 ring-[var(--bg)]"
          />
        </>
      ) : status === "error" ? (
        <WarningIcon style={{ color: "var(--amber)" }} />
      ) : (
        <SpinnerIcon className="motion-safe:animate-spin" />
      )}
    </button>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M7 12V4M4 6.5L7 3.5 10 6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 2h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
    >
      <path
        d="M7 2v8M4 7.5L7 10.5 10 7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarningIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={style}>
      <path
        d="M7 2L1.5 12h11L7 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M7 6v3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
    >
      <path
        d="M7 1.5A5.5 5.5 0 1 1 1.5 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

