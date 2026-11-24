import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/useT";
import { agentIcon } from "../toolbar/agentIcons";
import { DOCK_ENTRIES, DockIcon, useDockAvailability, type DockEntry } from "../toolbar/dockEntries";
import "./agent-picker.css";

/**
 * Choosing an agent, wherever it's done: handing a task over, a folder's +,
 * the grid's +, who manages the workdesk. Agents that are here are rows; a
 * new one is a tile.
 */

const EDGE = 8;

/** A small panel by what opened it: below if it fits, else above; never off the window, never cut short while there's room. */
export function PickerPopover({ anchor, label, width = 320, role = "dialog", onClose, onEscape, children }: { anchor: HTMLElement; label: string; width?: number; role?: "dialog" | "menu"; onClose: (refocus: boolean) => void; onEscape?: () => boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const put = () => {
      const a = anchor.getBoundingClientRect();
      const height = (inner.current?.offsetHeight ?? 0) + 14;
      const below = window.innerHeight - a.bottom - 6 - EDGE;
      const above = a.top - 6 - EDGE;
      const under = height <= below || below >= above;
      const maxHeight = Math.max(160, under ? below : above);
      const shown = Math.min(height, maxHeight);
      setPlace({ left: Math.max(EDGE, Math.min(a.left, window.innerWidth - width - EDGE)), top: Math.max(EDGE, under ? a.bottom + 6 : a.top - 6 - shown), maxHeight });
    };
    put();
    const observer = new ResizeObserver(put);
    if (inner.current) observer.observe(inner.current);
    window.addEventListener("resize", put);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", put);
    };
  }, [anchor, width]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Once it's shown: what's hidden can't be focused.
  const placed = place !== null;
  useEffect(() => {
    if (!placed || ref.current?.contains(document.activeElement)) return;
    (ref.current?.querySelector<HTMLElement>("[data-pick][data-first]") ?? ref.current?.querySelector<HTMLElement>("[data-pick]:not([aria-disabled='true'])"))?.focus();
  }, [placed]);
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className="tc-menu-pop tc-ap"
      style={{ width, maxWidth: `calc(100vw - ${EDGE * 2}px)`, ...(place ?? { left: 0, top: 0, visibility: "hidden" as const }) }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          if (!onEscape?.()) onClose(true);
        } else arrowKeys(e);
      }}
    >
      <div ref={inner}>{children}</div>
    </div>,
    document.body,
  );
}

/** Up and down go from row to row, and left and right along a row of tiles. */
export function arrowKeys(e: KeyboardEvent<HTMLElement>): void {
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
  if (!step || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-pick]:not([aria-disabled='true']):not(:disabled)")];
  const rowOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-pick-row]") ?? el;
  const now = document.activeElement as HTMLElement;
  const at = all.indexOf(now);
  if (all.length === 0) return;
  e.preventDefault();
  if (at < 0) return void all[0].focus();
  const along = all.filter((el) => rowOf(el) === rowOf(now));
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") return void along[(along.indexOf(now) + step + along.length) % along.length].focus();
  const rows = [...new Set(all.map(rowOf))];
  const row = rows[(rows.indexOf(rowOf(now)) + step + rows.length) % rows.length];
  all.find((el) => rowOf(el) === row)?.focus();
}

export function PickerHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="tc-ap-head">
      <span>{children}</span>
      {trailing}
    </div>
  );
}

/** An agent that's here. */
export function AgentOption({ type, name, detail, trailing, first, role, onPick }: { type: string; name: string; detail?: string; trailing?: ReactNode; first?: boolean; role?: "menuitem"; onPick: () => void }) {
  return (
    <button type="button" role={role} data-pick="" data-first={first ? "" : undefined} className="tc-ap-row" onClick={onPick}>
      <span className="tc-ap-mark">
        <img src={agentIcon(type)} alt="" width={18} height={18} draggable={false} />
      </span>
      <span className="tc-ap-words">
        <span className="truncate">{name}</span>
        {detail && <span className="tc-ap-detail truncate">{detail}</span>}
      </span>
      {trailing}
    </button>
  );
}

/** A new agent of each kind; one that isn't installed says so instead of failing. */
export function NewAgentTiles({ role, actionLabel, onPick }: { role?: "menuitem"; /** What picking one does, for screen readers: "New chat with Codex". */ actionLabel: (name: string) => string; onPick: (entry: DockEntry) => void }) {
  return (
    <div className="tc-ap-tiles" data-pick-row="">
      {DOCK_ENTRIES.filter((e) => e.group === "agents").map((entry) => (
        <NewAgentTile key={entry.id} entry={entry} role={role} actionLabel={actionLabel} onPick={onPick} />
      ))}
    </div>
  );
}

function NewAgentTile({ entry, role, actionLabel, onPick }: { entry: DockEntry; role?: "menuitem"; actionLabel: (name: string) => string; onPick: (entry: DockEntry) => void }) {
  const t = useT();
  const { missing, title } = useDockAvailability(entry);
  const name = entry.label(t);
  return (
    <button
      type="button"
      role={role}
      data-pick=""
      className="tc-ap-tile"
      aria-disabled={missing || undefined}
      aria-label={missing ? `${name}: ${t.agent_not_installed}` : actionLabel(name)}
      title={missing ? (title ?? t.agent_not_installed) : actionLabel(name)}
      onClick={() => !missing && onPick(entry)}
    >
      <DockIcon art={entry.art} />
      <span>{name}</span>
      {missing && <small>{t.agent_not_installed}</small>}
    </button>
  );
}
