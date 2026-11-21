import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LaunchBrief } from "../../shared/memory";
import { NATIVE_LABEL } from "../../shared/memory";
import { useT } from "../i18n/useT";
import { findTerminal } from "../actions/terminalLookup";
import { openFolderTool, workdeskMemoryTool } from "../actions/folderTools";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";

/**
 * "Started with memory": what an agent was told from Tacit's memory when it
 * started, as a chip on its chat and its tile. Click it to see the notes,
 * grouped by where they came from; if an agent does something odd, this is
 * where you check whether memory caused it.
 */

export function useLaunchBrief(terminalId: string): LaunchBrief | null {
  const [brief, setBrief] = useState<LaunchBrief | null>(null);
  useEffect(() => {
    const api = window.tacit?.memory;
    if (!api?.launchBrief) return;
    let alive = true;
    const load = () =>
      void api
        .launchBrief(terminalId)
        .then((b) => alive && setBrief(b))
        .catch((err: unknown) => console.error("[memory] launch brief", err));
    load();
    const off = api.onLaunchBrief?.((id) => {
      if (id === terminalId) load();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [terminalId]);
  return brief;
}

const SCOPE_ORDER = ["you", "workdesk", "folder", "worktree"] as const;

type Since = "removed" | "outdated";

/**
 * What became of each note the agent was given, by "scope/name": still
 * there (absent from the map), marked outdated, or removed. The agent was
 * told it either way; this is so the list doesn't read as current.
 */
function useSinceStart(terminalId: string, brief: LaunchBrief): Map<string, Since> | null {
  const [since, setSince] = useState<Map<string, Since> | null>(null);
  useEffect(() => {
    const api = window.tacit?.memory;
    if (!api?.view) return;
    let alive = true;
    const load = () => {
      const found = findTerminal(terminalId);
      const workdeskId = useCanvasRegistryStore.getState().activeCanvasId;
      void api
        .view({ workdeskId, folder: found?.project.path ?? null, worktrees: found?.project.worktrees.map((w) => w.path) ?? [] })
        .then((data) => {
          if (!alive || !data) return;
          const status = new Map<string, string>();
          const add = (scope: string, notes: Array<{ name: string; status: string }>) => {
            for (const n of notes) status.set(`${scope}/${n.name}`, n.status);
          };
          // Only scopes that were looked at can say a note is gone.
          const looked = new Set<string>();
          if (workdeskId) {
            add("you", data.you);
            add("workdesk", data.workdesk);
            for (const n of data.pending) status.set(`${n.scope}/${n.name}`, n.status);
            looked.add("you").add("workdesk");
          }
          if (found) {
            add("folder", data.folder);
            add("worktree", data.worktrees.flatMap((w) => w.notes));
            looked.add("folder").add("worktree");
          }
          const next = new Map<string, Since>();
          for (const item of brief.items) {
            if (item.native || !looked.has(item.scope)) continue;
            const key = `${item.scope}/${item.name}`;
            const now = status.get(key);
            if (now === undefined) next.set(key, "removed");
            else if (now === "outdated") next.set(key, "outdated");
          }
          setSince(next);
        })
        .catch((err: unknown) => console.error("[memory] notes since start", err));
    };
    load();
    const off = api.onStoreChanged?.(load);
    return () => {
      alive = false;
      off?.();
    };
  }, [terminalId, brief]);
  return since;
}

export function StartedWithMemory({ terminalId, variant }: { terminalId: string; variant: "chat" | "tile" }) {
  const t = useT();
  const brief = useLaunchBrief(terminalId);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!brief || brief.items.length === 0) return null;
  const count = brief.items.length;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t.mem_started_title(count)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={
          variant === "chat"
            ? "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            : "nodrag inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
        }
        style={{ boxShadow: variant === "chat" ? "inset 0 0 0 1px var(--border)" : undefined, cornerShape: "round" } as React.CSSProperties}
      >
        <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" />
        </svg>
        {t.mem_started_chip(count)}
      </button>
      {open && <BriefPopover brief={brief} anchor={button.current} terminalId={terminalId} onClose={() => setOpen(false)} />}
    </>
  );
}

function BriefPopover({ brief, anchor, terminalId, onClose }: { brief: LaunchBrief; anchor: HTMLElement | null; terminalId: string; onClose: () => void }) {
  const t = useT();
  const since = useSinceStart(terminalId, brief);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = 340;
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: Math.min(r.bottom + 6, window.innerHeight - 120) });
  }, [anchor]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [anchor, onClose]);
  const groups: Array<{ title: string; items: LaunchBrief["items"] }> = [];
  for (const scope of SCOPE_ORDER) {
    const items = brief.items.filter((i) => i.scope === scope && !i.native);
    if (items.length > 0) groups.push({ title: t.mem_started_scope(scope), items });
  }
  const natives = [...new Set(brief.items.filter((i) => i.native).map((i) => i.native!))];
  for (const native of natives) groups.push({ title: t.mem_native(NATIVE_LABEL[native] ?? native), items: brief.items.filter((i) => i.native === native) });
  const openMemory = () => {
    const found = findTerminal(terminalId);
    const workdesk = useCanvasRegistryStore.getState().activeCanvasId;
    if (found) openFolderTool({ kind: "memory", path: found.worktree.path });
    else if (workdesk) openFolderTool(workdeskMemoryTool(workdesk));
    onClose();
  };
  if (!at) return null;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={t.mem_started_heading}
      className="fixed z-[200] flex max-h-[min(520px,70vh)] w-[340px] flex-col overflow-hidden tc-sq-card border border-[var(--border)] bg-[var(--surface)]"
      style={{ left: at.left, top: at.top, boxShadow: "var(--shadow-elev-2)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 pb-1 pt-3 text-[13px] font-semibold text-[var(--text-primary)]">{t.mem_started_heading}</div>
      <div className="px-3.5 pb-2 text-[11.5px] leading-snug text-[var(--text-muted)]">{t.mem_started_sub(brief.words)}</div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {groups.map((g) => (
          <div key={g.title} className="pb-1.5">
            <div className="tc-eyebrow px-3.5 pb-0.5 pt-1.5">
              {g.title} <span className="text-[var(--text-faint,var(--text-muted))]">{g.items.length}</span>
            </div>
            {g.items.map((i) => {
              const gone = i.native ? undefined : since?.get(`${i.scope}/${i.name}`);
              return (
                <div key={`${i.scope}/${i.name}/${i.native ?? ""}`} className="flex items-baseline gap-1.5 px-3.5 py-0.5 text-[12.5px]" title={i.description}>
                  <span className={`min-w-0 truncate ${gone ? "text-[var(--text-muted)] line-through" : i.listed ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}`}>{i.description}</span>
                  {i.listed && !gone && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">· {t.mem_started_title_only}</span>}
                  {gone && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">· {gone === "removed" ? t.mem_started_removed : t.mem_started_outdated}</span>}
                </div>
              );
            })}
          </div>
        ))}
        {brief.omitted > 0 && <div className="px-3.5 pb-1 text-[11.5px] text-[var(--text-muted)]">{t.mem_started_omitted(brief.omitted)}</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] px-3.5 py-2 text-[11.5px] text-[var(--text-muted)]">
        <span className="min-w-0 flex-1">{t.mem_started_never_pending}</span>
        <button type="button" className="shrink-0 font-medium text-[var(--text-primary)] hover:underline" onClick={openMemory}>
          {t.mem_started_open}
        </button>
      </div>
    </div>,
    document.body,
  );
}
