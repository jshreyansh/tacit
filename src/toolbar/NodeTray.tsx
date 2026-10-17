import { useEffect, useMemo, useRef, useState } from "react";
import { useDockStore } from "../stores/dockStore";
import { useT } from "../i18n/useT";
import {
  DOCK_ENTRIES,
  DockIcon,
  createFromDock,
  filterDockEntries,
  useDockAvailability,
  type DockEntry,
} from "./dockEntries";

/**
 * The All Nodes tray: every kind of node, big, in the middle of the screen,
 * the way macOS shows its app tray. Clicking one adds it to the canvas; the
 * pin on each keeps it in the left bar's dock. The tray is the only place to
 * pin or unpin, so the dock can't be rearranged by accident.
 */

/**
 * Tacit's own mark for "all nodes": nine small tiles in the dock's palette.
 * Drawn here rather than borrowed, since the obvious reference (macOS's app
 * grid) is someone else's icon.
 */
export function AllNodesIcon({ size = 30 }: { size?: number }) {
  const tiles = ["#d98b6f", "#d4a24e", "#6cc4b0", "#7b7ce8", "#c4c0b8", "#e87272", "#6ea6f5", "#4ade80", "#b48ead"];
  return (
    <span className="tc-icon-shell" style={{ width: size, height: size }}>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 18 18" aria-hidden="true">
        {tiles.map((fill, i) => (
          <rect key={fill} x={(i % 3) * 6.2} y={Math.floor(i / 3) * 6.2} width="5" height="5" rx="1.5" fill={fill} />
        ))}
      </svg>
    </span>
  );
}

type Filter = "all" | "agents" | "tools";

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2.5h4l-.6 4 2 2H4.6l2-2z" />
      <path d="M8 8.5v5" />
    </svg>
  );
}

function TrayTile({ entry, onCreated }: { entry: DockEntry; onCreated: () => void }) {
  const t = useT();
  const pinned = useDockStore((s) => s.pinned.includes(entry.id));
  const togglePin = useDockStore((s) => s.togglePin);
  const { missing, title } = useDockAvailability(entry);
  const label = entry.label(t);
  const pinLabel = pinned ? t.dock_unpin(label) : t.dock_pin(label);
  return (
    <div className="relative">
      <button
        type="button"
        className={`tc-rail-btn flex w-full flex-col items-center gap-2 px-1.5 pb-2.5 pt-3.5 text-[var(--text-primary)]${missing ? " opacity-45" : ""}`}
        aria-disabled={missing || undefined}
        title={title ?? label}
        onClick={() => {
          if (createFromDock(entry, title, missing)) onCreated();
        }}
      >
        <DockIcon art={entry.art} scale={2} />
        <span className="max-w-full truncate text-[12.5px]">{label}</span>
      </button>
      <button
        type="button"
        className="absolute left-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors duration-quick focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        style={
          pinned
            ? { background: "var(--accent)", color: "var(--accent-foreground)" }
            : { background: "color-mix(in srgb, var(--bg) 70%, transparent)", color: "var(--text-muted)" }
        }
        aria-pressed={pinned}
        aria-label={pinLabel}
        title={pinLabel}
        onClick={() => togglePin(entry.id)}
      >
        <PinIcon />
      </button>
    </div>
  );
}

export function NodeTray() {
  const t = useT();
  const open = useDockStore((s) => s.trayOpen);
  const close = useDockStore((s) => s.closeTray);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const shown = useMemo(
    () => filterDockEntries(DOCK_ENTRIES, query, t).filter((e) => filter === "all" || e.group === filter),
    [query, filter, t],
  );

  if (!open) return null;
  const agents = shown.filter((e) => e.group === "agents");
  const tools = shown.filter((e) => e.group === "tools");
  const chips: Array<[Filter, string]> = [
    ["all", t.dock_tray_all],
    ["agents", t.dock_tray_agents],
    ["tools", t.dock_tray_tools],
  ];

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ backgroundColor: "var(--scrim)" }}
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.dock_tray_title}
        className="tc-float tc-enter-fade-up mx-4 flex w-full max-w-[720px] flex-col gap-4 px-6 pb-6 pt-5"
      >
        <div className="flex items-center gap-3">
          <AllNodesIcon size={30} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault();
                shown[0].create();
                close();
              }
            }}
            placeholder={t.dock_tray_title}
            aria-label={t.dock_tray_search}
            className="min-w-0 flex-1 bg-transparent text-[24px] font-medium text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          />
          <kbd className="rounded-md border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">esc</kbd>
        </div>

        <div className="flex gap-1.5">
          {chips.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="rounded-full px-3 py-1 text-[12.5px] transition-colors duration-quick"
              style={
                filter === id
                  ? { background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--text-primary)" }
                  : { background: "color-mix(in srgb, var(--text-primary) 6%, transparent)", color: "var(--text-secondary)" }
              }
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="h-px bg-[var(--border)] opacity-70" />

        {shown.length === 0 && (
          <div className="py-6 text-center text-[13px] text-[var(--text-muted)]">{t.dock_tray_empty}</div>
        )}
        {agents.length > 0 && (
          <section className="flex flex-col gap-1.5" aria-label={t.dock_tray_agents}>
            <h3 className="text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">{t.dock_tray_agents}</h3>
            <div className="grid grid-cols-6 gap-1">
              {agents.map((entry) => (
                <TrayTile key={entry.id} entry={entry} onCreated={close} />
              ))}
            </div>
          </section>
        )}
        {tools.length > 0 && (
          <section className="flex flex-col gap-1.5" aria-label={t.dock_tray_tools}>
            <h3 className="text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">{t.dock_tray_tools}</h3>
            <div className="grid grid-cols-6 gap-1">
              {tools.map((entry) => (
                <TrayTile key={entry.id} entry={entry} onCreated={close} />
              ))}
            </div>
          </section>
        )}
        <div className="text-[11.5px] text-[var(--text-muted)]">{t.dock_tray_hint}</div>
      </div>
    </div>
  );
}
