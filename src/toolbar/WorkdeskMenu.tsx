import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { useCanvasManagerStore } from "../stores/canvasManagerStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useProjectStore } from "../stores/projectStore";
import { useWaitingByWorkdesk } from "../attention/waiting";

/**
 * The workdesk's name at the top of the list, and its menu: every workdesk
 * with what it holds and what needs you there, New workdesk (named in
 * place, then it opens empty with its first step in the list), and Manage
 * workdesks… for renaming, reordering and deleting. The same workdesks and
 * order as the Hub; ⌘⇧[ ⌘⇧] still cycle.
 */
const MENU_WIDTH = 268;
const MENU_MIN_WIDTH = 180;

export function WorkdeskMenu({ name }: { name: string }) {
  const t = useT();
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeId = useCanvasRegistryStore((s) => s.activeCanvasId);
  const liveProjects = useProjectStore((s) => s.projects);
  const waiting = useWaitingByWorkdesk();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    if (!open) setNaming(false);
  }, [open]);
  // The menu stays inside the panel that holds it: a narrow list shrinks it
  // rather than cutting it off at the panel's edge.
  const [popWidth, setPopWidth] = useState(MENU_WIDTH);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const own = ref.current.getBoundingClientRect();
    let edge = window.innerWidth;
    for (let el = ref.current.parentElement; el; el = el.parentElement) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "visible") {
        edge = el.getBoundingClientRect().right;
        break;
      }
    }
    setPopWidth(Math.max(MENU_MIN_WIDTH, Math.min(MENU_WIDTH, edge - own.left - 8)));
  }, [open]);
  useEffect(() => {
    if (naming) inputRef.current?.select();
  }, [naming]);

  const startNaming = () => {
    setDraft(`${t["canvas.new.defaultName"]} ${canvases.length + 1}`);
    setNaming(true);
  };
  const create = () => {
    useCanvasRegistryStore.getState().createCanvas(draft);
    setOpen(false);
  };
  const summary = (canvasId: string, projects: readonly { name?: string; path?: string }[]) => {
    const names = (canvasId === activeId ? liveProjects : projects).map((p) => p.name || (p.path ?? "").split(/[\\/]/).filter(Boolean).pop() || "");
    return names.length ? names.filter(Boolean).join(", ") : t.nav_workdesk_summary_empty;
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t.nav_workdesk_switch}
        onClick={() => setOpen((v) => !v)}
        className={`tc-sq-ctl flex h-8 min-w-0 max-w-full items-center gap-1.5 px-2 text-[14px] font-semibold text-[var(--text-primary)] ${open ? "bg-[var(--surface-hover)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"}`}
      >
        <span className="min-w-0 truncate">{name}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={`shrink-0 text-[var(--text-muted)] transition-transform duration-quick ${open ? "rotate-180" : ""}`}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div
          role={naming ? "dialog" : "menu"}
          aria-label={naming ? t["canvas.new.title"] : t.nav_workdesks}
          className="tc-menu-pop !absolute left-0 top-10 z-30 !max-h-[min(460px,70vh)]"
          style={{ width: popWidth }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              if (naming) setNaming(false);
              else setOpen(false);
            }
          }}
        >
          {naming ? (
            <div className="flex flex-col gap-2 p-1.5">
              <button type="button" className="tc-eyebrow flex items-center gap-1.5 px-1 pt-0.5 text-left hover:text-[var(--text-primary)]" onClick={() => setNaming(false)}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M10 3.5L5.5 8l4.5 4.5" />
                </svg>
                {t["canvas.new.title"]}
              </button>
              <label className="flex flex-col gap-1.5 px-1">
                <span className="text-[11.5px] text-[var(--text-muted)]">{t.nav_new_workdesk_name}</span>
                <input
                  ref={inputRef}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      create();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setNaming(false);
                    }
                  }}
                  className="tc-sq-ctl h-9 bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 text-[13.5px] text-[var(--text-primary)] outline-none"
                  style={{ boxShadow: "inset 0 0 0 1px var(--border-hover), 0 0 0 4px color-mix(in srgb, var(--text-primary) 3%, transparent)" }}
                />
              </label>
              <p className="px-1 text-[11.5px] leading-snug text-[var(--text-muted)]">{t.nav_new_workdesk_next}</p>
              <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-1">
                <button type="button" className="tc-sq-ctl h-8 px-2.5 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setNaming(false)}>
                  {t.cancel}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  className="tc-sq-ctl inline-flex h-8 items-center gap-1.5 px-3 text-[12.5px] font-medium"
                  style={{ background: "var(--text-primary)", color: "var(--bg)" }}
                  onClick={create}
                >
                  {t["canvas.new.create"]}
                  <span className="tc-mono text-[10px] opacity-60">⏎</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="tc-eyebrow flex px-2.5 pb-1 pt-0.5">
                <span className="flex-1">{t.nav_workdesks}</span>
                <span className="font-medium normal-case tracking-normal">{canvases.length}</span>
              </div>
              {canvases.map((canvas) => {
                const active = canvas.id === activeId;
                const waitingThere = waiting[canvas.id] ?? 0;
                return (
                  <button
                    key={canvas.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className="tc-menu-option !items-center"
                    onClick={() => {
                      setOpen(false);
                      if (!active) useCanvasRegistryStore.getState().switchCanvas(canvas.id);
                    }}
                  >
                    <span
                      className="tc-sq-sm flex h-[26px] w-[26px] shrink-0 items-center justify-center text-[11px] font-semibold"
                      style={{ background: active ? "var(--accent-soft)" : "color-mix(in srgb, var(--text-primary) 6%, transparent)", color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                    >
                      {(canvas.name.trim()[0] ?? "?").toUpperCase()}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="max-w-full truncate text-[13px] text-[var(--text-primary)]">{canvas.name}</span>
                      <span className="tc-menu-option-detail max-w-full truncate">{summary(canvas.id, canvas.scene?.projects ?? [])}</span>
                    </span>
                    {waitingThere > 0 && (
                      <span className="shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold leading-[17px]" style={{ background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }} title={t["hub.canvases.needsYou"](waitingThere)}>
                        {waitingThere}
                      </span>
                    )}
                    {active && (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-primary)]">
                        <path d="M3.5 8.5l3 3 6-7" />
                      </svg>
                    )}
                  </button>
                );
              })}
              <div className="mx-1.5 my-1 h-px bg-[var(--border)]" />
              <button type="button" role="menuitem" className="tc-menu-option !items-center" onClick={startNaming}>
                <span className="tc-sq-sm flex h-[26px] w-[26px] shrink-0 items-center justify-center text-[var(--text-secondary)]" style={{ boxShadow: "inset 0 0 0 1px var(--border-hover)" }}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="text-[13px] text-[var(--text-primary)]">{t["canvas.manager.newCanvas"]}</span>
                  <span className="tc-menu-option-detail">{t.nav_new_workdesk_hint}</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="tc-menu-option !items-center"
                onClick={() => {
                  setOpen(false);
                  useCanvasManagerStore.getState().openManager();
                }}
              >
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center text-[var(--text-muted)]">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                    <circle cx="8" cy="8" r="2" />
                    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="text-[13px] text-[var(--text-primary)]">{t["canvas.command.manage"]}</span>
                  <span className="tc-menu-option-detail">{t.nav_manage_hint}</span>
                </span>
              </button>
              <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-[var(--text-muted)]">{t["canvas.manager.cycleHint"]}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
