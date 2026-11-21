import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/useT";
import { findAgentAdapter } from "../../../shared/agent-adapters";
import { pinKind } from "../../../shared/pin";
import { useProjectStore } from "../../stores/projectStore";
import { useBrowserCardStore } from "../../stores/browserCardStore";
import { useFileTileStore } from "../../stores/fileTileStore";
import { usePinStore } from "../../stores/pinStore";
import { filterRefs, workdeskRefs, type WorkdeskRef, type WorkdeskRefKind } from "./composerRefs";
import type { SlashCommand } from "../../terminal/slashCommands";

/** Everything on this workdesk a message can point at. */
export function useWorkdeskRefs(): WorkdeskRef[] {
  const projects = useProjectStore((s) => s.projects);
  const cards = useBrowserCardStore((s) => s.cards);
  const tiles = useFileTileStore((s) => s.tiles);
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  return useMemo(
    () =>
      workdeskRefs({
        terminals: projects.flatMap((p) =>
          p.worktrees.flatMap((w) =>
            w.terminals
              .filter((term) => !term.stashed)
              .map((term) => ({
                id: term.id,
                title: term.customTitle?.trim() || term.title,
                type: term.type,
                folder: p.name,
                agent: !!findAgentAdapter(term.type),
              })),
          ),
        ),
        pages: Object.entries(cards).map(([id, card]) => ({ id, title: card.title, url: card.url })),
        files: Object.values(tiles).map((tile) => ({ id: tile.id, path: tile.path })),
        tasks: projects.flatMap((p) =>
          (pinsByProject[p.path] ?? [])
            .filter((pin) => pinKind(pin) === "task" && pin.status !== "done" && pin.status !== "dropped")
            .map((pin) => ({ id: pin.id, title: pin.title || "Untitled task", folder: p.name })),
        ),
      }),
    [projects, cards, tiles, pinsByProject],
  );
}

function KindGlyph({ kind }: { kind: WorkdeskRefKind }) {
  const common = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "chat":
      return (
        <svg {...common}>
          <path d="M2.5 4a1.5 1.5 0 011.5-1.5h8A1.5 1.5 0 0113.5 4v5.5A1.5 1.5 0 0112 11H7l-3 2.5V11A1.5 1.5 0 012.5 9.5z" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5" />
        </svg>
      );
    case "page":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M2.5 8h11M8 2.5c1.6 1.6 1.6 9.4 0 11M8 2.5c-1.6 1.6-1.6 9.4 0 11" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M4 1.75h5l3 3v9.5H4z" />
          <path d="M9 1.75v3h3" />
        </svg>
      );
    case "task":
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
          <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
        </svg>
      );
  }
}

/** One row of a suggestion list: what it is, its name, where it is. */
export function RefRow({ item, active, onPick, onHover }: { item: WorkdeskRef; active: boolean; onPick: () => void; onHover?: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`tc-menu-option !items-center ${active ? "!bg-[var(--surface-hover)]" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        <KindGlyph kind={item.kind} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
      <span className="max-w-[42%] shrink-0 truncate text-[11px] text-[var(--text-muted)]">{item.detail}</span>
    </button>
  );
}

/** What typing @ or / offers, above the box. */
export function SuggestList({
  kind,
  refs,
  commands,
  active,
  onActive,
  onPickRef,
  onPickCommand,
}: {
  kind: "mention" | "command";
  refs: readonly WorkdeskRef[];
  commands: readonly SlashCommand[];
  active: number;
  onActive: (index: number) => void;
  onPickRef: (ref: WorkdeskRef) => void;
  onPickCommand: (command: SlashCommand) => void;
}) {
  const t = useT();
  const empty = kind === "mention" ? refs.length === 0 : commands.length === 0;
  return (
    <div role="listbox" aria-label={kind === "mention" ? t.chat_mention_title : t.chat_command_title} className="tc-menu-pop tc-suggest !absolute bottom-[calc(100%+8px)] left-0 z-30 w-[min(340px,100%)] !max-h-[280px]">
      <div className="tc-eyebrow flex px-2.5 pb-1 pt-0.5">
        <span className="flex-1">{kind === "mention" ? t.chat_mention_title : t.chat_command_title}</span>
        <span className="font-normal normal-case tracking-normal">↑↓ ⏎</span>
      </div>
      {empty && <div className="px-2.5 py-2 text-[12.5px] text-[var(--text-muted)]">{kind === "mention" ? t.chat_mention_none : t.chat_command_none}</div>}
      {kind === "mention"
        ? refs.map((item, i) => <RefRow key={item.key} item={item} active={i === active} onHover={() => onActive(i)} onPick={() => onPickRef(item)} />)
        : commands.map((c, i) => (
            <button
              key={c.command}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`tc-menu-option !items-center ${i === active ? "!bg-[var(--surface-hover)]" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActive(i)}
              onClick={() => onPickCommand(c)}
            >
              <span className="tc-mono shrink-0 text-[12.5px] text-[var(--text-primary)]">{c.command}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]">{c.description}</span>
            </button>
          ))}
    </div>
  );
}

/**
 * The box's +: files or folders (the open dialog), or something from the
 * workdesk (a chat, a page, a file on the canvas, a task), searchable.
 */
export function AddMenu({
  busy,
  onPickFiles,
  onPickRef,
  onScreenshot,
}: {
  busy: boolean;
  onPickFiles: () => void;
  onPickRef: (ref: WorkdeskRef) => void;
  onScreenshot: (rect: { x: number; y: number; width: number; height: number }) => void;
}) {
  const t = useT();
  const refs = useWorkdeskRefs();
  const [open, setOpen] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [page, setPage] = useState<"root" | "workdesk">("root");
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      setPage("root");
      setQuery("");
      return;
    }
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);
  const rect = open ? buttonRef.current?.getBoundingClientRect() : undefined;
  const shown = filterRefs(refs, query, 40);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="tc-sq-ctl -ml-1 flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.chat_add}
        title={t.chat_add}
      >
        {busy ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        )}
      </button>
      {shooting && (
        <ScreenshotPicker
          onDone={(area) => {
            setShooting(false);
            // Two frames: the picker has to be gone from the screen before the capture.
            if (area) requestAnimationFrame(() => requestAnimationFrame(() => onScreenshot(area)));
          }}
        />
      )}
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t.chat_add}
            className="tc-menu-pop !fixed z-[1000] w-[300px] !max-h-[min(420px,70vh)]"
            style={{ bottom: window.innerHeight - rect.top + 8, left: Math.max(8, Math.min(rect.left - 6, window.innerWidth - 308)) }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (page === "workdesk") setPage("root");
                else setOpen(false);
              }
            }}
          >
            {page === "root" ? (
              <>
                <div className="tc-eyebrow px-2.5 pb-1 pt-0.5">{t.chat_add}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="tc-menu-option !items-center"
                  onClick={() => {
                    setOpen(false);
                    onPickFiles();
                  }}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
                    <KindGlyph kind="file" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="text-[13px] text-[var(--text-primary)]">{t.chat_add_files}</span>
                    <span className="tc-menu-option-detail">{t.chat_add_files_hint}</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="tc-menu-option !items-center"
                  onClick={() => {
                    setOpen(false);
                    setShooting(true);
                  }}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                      <path d="M2.5 5.5V4a1.5 1.5 0 011.5-1.5h1.5M10.5 2.5H12A1.5 1.5 0 0113.5 4v1.5M13.5 10.5V12a1.5 1.5 0 01-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 012.5 12v-1.5" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="text-[13px] text-[var(--text-primary)]">{t.chat_add_screenshot}</span>
                    <span className="tc-menu-option-detail">{t.chat_add_screenshot_hint}</span>
                  </span>
                </button>
                <button type="button" role="menuitem" className="tc-menu-option !items-center" onClick={() => setPage("workdesk")}>
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                      <rect x="2" y="2" width="5" height="5" rx="1.2" />
                      <rect x="9" y="2" width="5" height="5" rx="1.2" />
                      <rect x="2" y="9" width="5" height="5" rx="1.2" />
                      <rect x="9" y="9" width="5" height="5" rx="1.2" />
                    </svg>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="text-[13px] text-[var(--text-primary)]">{t.chat_add_workdesk}</span>
                    <span className="tc-menu-option-detail">{t.chat_add_workdesk_hint}</span>
                  </span>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">
                    <path d="M6 3.5L10.5 8 6 12.5" />
                  </svg>
                </button>
                <div className="px-2.5 pb-1 pt-2 text-[11px] text-[var(--text-muted)]">{t.chat_add_keys}</div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 px-1.5 pb-1">
                  <button type="button" className="tc-sq-sm inline-flex h-7 w-7 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]" onClick={() => setPage("root")} aria-label={t.back}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M10 3.5L5.5 8l4.5 4.5" />
                    </svg>
                  </button>
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && shown[0]) {
                        e.preventDefault();
                        setOpen(false);
                        onPickRef(shown[0]);
                      } else if (e.key === "Escape") setPage("root");
                    }}
                    placeholder={t.chat_add_workdesk_search}
                    className="tc-sq-ctl h-8 min-w-0 flex-1 bg-transparent px-2 text-[12.5px] text-[var(--text-primary)] outline-none"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-hover)" }}
                  />
                </div>
                {shown.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-[var(--text-muted)]">{t.chat_mention_none}</div>}
                {shown.map((item) => (
                  <RefRow
                    key={item.key}
                    item={item}
                    active={false}
                    onPick={() => {
                      setOpen(false);
                      onPickRef(item);
                    }}
                  />
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Picking what to capture: hover a tile and click to take it whole, or drag
 * out any area. Esc cancels. It covers the window while it's open and is
 * gone before the capture is taken.
 */
function ScreenshotPicker({ onDone }: { onDone: (area: { x: number; y: number; width: number; height: number } | null) => void }) {
  const t = useT();
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDone(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);
  // The tile under the pointer, looking through the picker's own layer.
  const tileAt = (x: number, y: number): DOMRect | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (layer.current?.contains(el)) continue;
      const node = (el as HTMLElement).closest?.("[data-record-node], .react-flow__node");
      if (node) return node.getBoundingClientRect();
    }
    return null;
  };
  const box = drag
    ? { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }
    : hover
      ? { left: hover.left, top: hover.top, width: hover.width, height: hover.height }
      : null;
  return createPortal(
    <div
      ref={layer}
      className="fixed inset-0 z-[3000] cursor-crosshair"
      style={{ background: box ? "transparent" : "rgba(0,0,0,0.28)" }}
      onPointerMove={(e) => {
        if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY });
        else setHover(tileAt(e.clientX, e.clientY));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onPointerUp={(e) => {
        const d = drag;
        setDrag(null);
        if (d && Math.abs(d.x1 - d.x0) > 6 && Math.abs(d.y1 - d.y0) > 6) {
          onDone({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0) });
          return;
        }
        const tile = tileAt(e.clientX, e.clientY);
        onDone(tile ? { x: tile.left, y: tile.top, width: tile.width, height: tile.height } : null);
      }}
    >
      {box && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[10px]"
          style={{ ...box, boxShadow: "0 0 0 2px var(--accent), 0 0 0 9999px rgba(0,0,0,0.32)" }}
        />
      )}
      <div className="tc-float pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 px-4 py-2 text-[12.5px] text-[var(--text-secondary)]" style={{ borderRadius: 14 }}>
        {t.chat_screenshot_pick}
      </div>
    </div>,
    document.body,
  );
}
