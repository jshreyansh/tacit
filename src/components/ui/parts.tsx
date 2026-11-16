/**
 * The Foundation parts every panel uses: one look for headers, sections,
 * rows, chips, switches, segmented views, key chips and empty states. The
 * styling lives in index.css (`tc-panel-head`, `tc-section-head`, `tc-row`,
 * `tc-chip`, `tc-switch`, `tc-seg`, `tc-kbd`, `tc-empty`); these wrappers
 * keep the markup and accessibility the same everywhere.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function PanelHeader({
  title,
  subtitle,
  leading,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** An avatar or icon before the title. */
  leading?: ReactNode;
  /** Icon buttons on the right; the collapse button goes last. */
  actions?: ReactNode;
}) {
  return (
    <div className="tc-panel-head">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="tc-panel-title truncate">{title}</span>
        {subtitle && <span className="tc-panel-subtitle">{subtitle}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function SectionHeader({
  label,
  count,
  action,
  className = "",
}: {
  label: ReactNode;
  count?: number | string;
  /** A small icon button at the right, e.g. +. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`tc-section-head ${className}`}>
      <span className="tc-eyebrow">{label}</span>
      {count !== undefined && <span className="tc-count">{count}</span>}
      {action && <span className="ml-auto flex items-center">{action}</span>}
    </div>
  );
}

export type ChipTone = "neutral" | "live" | "ask" | "error";

export function StatusChip({ tone = "neutral", dot, children }: { tone?: ChipTone; dot?: boolean; children: ReactNode }) {
  const toneClass = tone === "neutral" ? "" : ` tc-chip-${tone}`;
  return (
    <span className={`tc-chip${toneClass}`}>
      {(dot ?? tone !== "neutral") && <span className="tc-chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Read by screen readers; the visible label sits beside the switch. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="tc-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  fill,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (next: T) => void;
  label: string;
  /** Stretch the options to the full width. */
  fill?: boolean;
}) {
  return (
    <div role="tablist" aria-label={label} className={`tc-seg${fill ? " tc-seg-fill" : ""}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A keyboard shortcut, one chip per key or one for the whole chord. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="tc-kbd">{children}</kbd>;
}

export function EmptyState({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`tc-empty ${className}`}>{children}</div>;
}

export function ListRow({
  icon,
  title,
  meta,
  trailing,
  selected,
  className = "",
  ...rest
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title">) {
  return (
    <button type="button" data-selected={selected ? "true" : undefined} className={`tc-row w-[calc(100%-12px)] ${className}`} {...rest}>
      {icon && <span className="flex shrink-0 items-center">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="tc-row-title">{title}</span>
        {meta && <span className="tc-row-meta">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
    </button>
  );
}

/**
 * One answer to an agent's question: a full-width row that grows with its
 * text, marked by a number (pick to send), a radio or a checkbox. Used in
 * the chat's questions and in a task that needs you.
 */
export function ChoiceRow({
  label,
  description,
  marker,
  index,
  selected,
  onPick,
}: {
  label: ReactNode;
  description?: ReactNode;
  marker: "number" | "radio" | "check";
  /** 0-based position, shown as 1, 2, 3 for the number marker. */
  index?: number;
  selected?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role={marker === "number" ? undefined : marker === "radio" ? "radio" : "checkbox"}
      aria-checked={marker === "number" ? undefined : !!selected}
      data-selected={selected ? "true" : undefined}
      className="tc-choice"
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="tc-choice-mark" data-marker={marker} aria-hidden="true">
        {marker === "number" ? (index ?? 0) + 1 : marker === "check" && selected ? (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="tc-choice-label">{label}</span>
        {description && <span className="tc-choice-desc">{description}</span>}
      </span>
    </button>
  );
}
