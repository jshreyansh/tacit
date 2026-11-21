import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryNote, MemoryScope, MemoryViewData } from "../../shared/memory";
import { useT } from "../i18n/useT";
import { openFolderTool } from "../actions/folderTools";
import { useProjectStore } from "../stores/projectStore";
import { confirmAsync } from "./ui/confirmAsync";

/**
 * Tacit's memory, as the person sees it: what every agent starts with.
 *
 * For a workdesk: what waits for your approval, the handover, the
 * workdesk's goals and decisions, what's known about you, and recent
 * activity. For a folder: its notes, each worktree's, and each CLI's own
 * memory for it (read-only: Tacit reads it, never writes it).
 *
 * Every note says who wrote it and when; you can approve, edit, mark
 * outdated, delete, or add your own (yours are trusted as written).
 */
export type MemoryViewTarget =
  | { mode: "workdesk"; workdeskId: string }
  | { mode: "folder"; folder: string; worktrees: string[] };

type T = ReturnType<typeof useT>;

function useMemoryData(target: MemoryViewTarget): { data: MemoryViewData | null; reload: () => void } {
  const [data, setData] = useState<MemoryViewData | null>(null);
  const key = target.mode === "workdesk" ? `w:${target.workdeskId}` : `f:${target.folder}|${target.worktrees.join("|")}`;
  const reload = useCallback(() => {
    const api = window.tacit?.memory;
    if (!api?.view) return;
    const request = target.mode === "workdesk" ? { workdeskId: target.workdeskId } : { folder: target.folder, worktrees: target.worktrees };
    void api.view(request).then((next) => setData(next)).catch(() => setData(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    reload();
    return window.tacit?.memory?.onStoreChanged?.(reload);
  }, [reload]);
  return { data, reload };
}

const live = (n: MemoryNote) => n.status === "active";
const newest = (a: MemoryNote, b: MemoryNote) => b.updated.localeCompare(a.updated);

function whoWrote(note: MemoryNote, t: T): string {
  if (note.author === "you") return t.mem_by_you;
  if (note.native) return t.mem_native(nativeName(note.native));
  return t.mem_by_agent(note.harness ? harnessName(note.harness) : null);
}

const harnessName = (h: string) => ({ claude: "Claude", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity" })[h] ?? h;
const nativeName = (n: string) => harnessName(n.replace(/-memory$/, ""));

function relative(iso: string, t: T): string {
  const ms = Date.now() - new Date(iso).getTime();
  return t["pin.relativeTime"](ms);
}

async function act(action: Parameters<NonNullable<typeof window.tacit>["memory"]["act"]>[0]): Promise<void> {
  await window.tacit?.memory?.act?.(action);
}

export function MemoryView({ target }: { target: MemoryViewTarget }) {
  const t = useT();
  const { data, reload } = useMemoryData(target);

  if (!data) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text-muted)]">{t.mem_empty}</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3">
      {target.mode === "workdesk" ? (
        <WorkdeskMemory data={data} workdeskId={target.workdeskId} t={t} reload={reload} />
      ) : (
        <FolderMemory data={data} folder={target.folder} t={t} reload={reload} />
      )}
    </div>
  );
}

function WorkdeskMemory({ data, workdeskId, t, reload }: { data: MemoryViewData; workdeskId: string; t: T; reload: () => void }) {
  const handover = data.workdesk.find((n) => n.kind === "handover" && live(n)) ?? null;
  const desk = data.workdesk.filter((n) => live(n) && n.kind !== "handover" && n.kind !== "event").sort(newest);
  const activity = data.workdesk.filter((n) => live(n) && n.kind === "event").sort(newest);
  const you = data.you.filter(live).sort(newest);
  const outdated = [...data.workdesk, ...data.you].filter((n) => n.status === "outdated").sort(newest);

  return (
    <>
      <p className="mb-3 text-[12.5px] leading-[1.5] text-[var(--text-muted)]">{t.mem_workdesk_hint}</p>
      {data.pending.length > 0 && (
        <Section title={t.mem_waiting} hint={t.mem_waiting_hint} tone="need">
          {data.pending.map((n) => (
            <NoteRow key={n.filePath} note={n} t={t} reload={reload} />
          ))}
        </Section>
      )}
      <Section title={t.mem_handover}>
        {handover ? (
          <NoteRow note={handover} t={t} reload={reload} open />
        ) : (
          <p className="px-1 text-[12.5px] leading-[1.5] text-[var(--text-muted)]">{t.mem_handover_empty}</p>
        )}
      </Section>
      <Section title={t.mem_workdesk} add={{ scope: "workdesk", workdeskId }} t={t} reload={reload}>
        {desk.length === 0 ? <Empty t={t} /> : desk.map((n) => <NoteRow key={n.filePath} note={n} t={t} reload={reload} />)}
      </Section>
      <Section title={t.mem_you} hint={t.mem_you_hint} add={{ scope: "you", workdeskId }} t={t} reload={reload}>
        {you.length === 0 ? <Empty t={t} /> : you.map((n) => <NoteRow key={n.filePath} note={n} t={t} reload={reload} />)}
      </Section>
      <WorkdeskFolders t={t} />
      {activity.length > 0 && (
        <Section title={t.mem_activity}>
          <ActivityList notes={activity} t={t} />
        </Section>
      )}
      <Outdated notes={outdated} t={t} reload={reload} />
    </>
  );
}

/**
 * The workdesk's folders, each with how many notes it holds: most of what
 * agents save is about a folder's code, kept with the folder, and this is
 * the way to it from the workdesk's memory.
 */
function WorkdeskFolders({ t }: { t: T }) {
  const key = useProjectStore((s) =>
    s.projects
      .map((p) => {
        const primary = p.worktrees.find((w) => w.isPrimary) ?? p.worktrees[0];
        return primary ? [p.name, primary.path, ...p.worktrees.map((w) => w.path)].join("\t") : "";
      })
      .filter(Boolean)
      .join("\n"),
  );
  const folders = useMemo(
    () =>
      key
        ? key.split("\n").map((line) => {
            const [name, path, ...worktrees] = line.split("\t");
            return { name, path, worktrees };
          })
        : [],
    [key],
  );
  const [counts, setCounts] = useState<Record<string, { notes: number; waiting: number }>>({});
  useEffect(() => {
    const api = window.tacit?.memory;
    if (!api?.view || folders.length === 0) return;
    let alive = true;
    const load = () =>
      void Promise.all(
        folders.map(async (f) => {
          const data = await api.view({ folder: f.path, worktrees: f.worktrees });
          const all = data ? [...data.folder, ...data.worktrees.flatMap((w) => w.notes)] : [];
          return [f.path, { notes: all.filter(live).length, waiting: all.filter((n) => n.status === "pending").length }] as const;
        }),
      )
        .then((rows) => alive && setCounts(Object.fromEntries(rows)))
        .catch((err: unknown) => console.error("[memory] folder counts", err));
    load();
    const off = api.onStoreChanged?.(load);
    return () => {
      alive = false;
      off?.();
    };
  }, [folders]);
  if (folders.length === 0) return null;
  return (
    <Section title={t.mem_folders} hint={t.mem_folders_hint}>
      {folders.map((f) => {
        const c = counts[f.path];
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => openFolderTool({ kind: "memory", path: f.path })}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            style={{ cornerShape: "round" } as React.CSSProperties}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">{f.name}</span>
            {c && c.waiting > 0 && <span className="shrink-0 text-[12px]" style={{ color: "var(--status-attention, var(--accent))" }}>{t.mem_folders_waiting(c.waiting)}</span>}
            <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{c ? t.mem_folders_count(c.notes) : ""}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        );
      })}
    </Section>
  );
}

function FolderMemory({ data, folder, t, reload }: { data: MemoryViewData; folder: string; t: T; reload: () => void }) {
  const notes = data.folder.filter(live).sort(newest);
  const outdated = [...data.folder, ...data.worktrees.flatMap((w) => w.notes)].filter((n) => n.status === "outdated").sort(newest);
  const pending = [...data.folder, ...data.worktrees.flatMap((w) => w.notes)].filter((n) => n.status === "pending");
  return (
    <>
      {pending.length > 0 && (
        <Section title={t.mem_waiting} hint={t.mem_waiting_hint} tone="need">
          {pending.map((n) => (
            <NoteRow key={n.filePath} note={n} t={t} reload={reload} />
          ))}
        </Section>
      )}
      <Section title={t.mem_folder} hint={t.mem_folder_hint} add={{ scope: "folder", folder }} t={t} reload={reload}>
        {notes.length === 0 ? <Empty t={t} /> : notes.map((n) => <NoteRow key={n.filePath} note={n} t={t} reload={reload} />)}
      </Section>
      {data.worktrees
        .filter((w) => w.notes.some(live))
        .map((w) => (
          <Section key={w.path} title={t.mem_worktree(w.path.split(/[\\/]/).pop() ?? w.path)} add={{ scope: "worktree", folder: w.path }} t={t} reload={reload}>
            {w.notes.filter(live).sort(newest).map((n) => (
              <NoteRow key={n.filePath} note={n} t={t} reload={reload} />
            ))}
          </Section>
        ))}
      {data.native
        .filter((n) => n.notes.length > 0)
        .map((n) => (
          <Section key={n.cli} title={t.mem_native(harnessName(n.cli))} hint={t.mem_native_hint(harnessName(n.cli))}>
            {n.notes.sort(newest).map((note) => (
              <NoteRow key={note.filePath} note={note} t={t} reload={reload} readOnly />
            ))}
          </Section>
        ))}
      <Outdated notes={outdated} t={t} reload={reload} />
    </>
  );
}

function Section({
  title,
  hint,
  tone,
  add,
  t,
  reload,
  children,
}: {
  title: string;
  hint?: string;
  tone?: "need";
  add?: { scope: MemoryScope; workdeskId?: string; folder?: string };
  t?: T;
  reload?: () => void;
  children: React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="mb-5">
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="tc-eyebrow flex-1" style={tone === "need" ? { color: "var(--status-attention, var(--accent))" } : undefined}>
          {title}
        </span>
        {add && t && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="tc-sq-sm inline-flex h-6 items-center gap-1 px-1.5 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t.mem_add}
          </button>
        )}
      </div>
      {hint && <p className="px-1 pb-2 text-[12px] leading-[1.45] text-[var(--text-muted)]">{hint}</p>}
      {add && t && adding && (
        <NoteEditor
          t={t}
          onCancel={() => setAdding(false)}
          onSave={async (description, body) => {
            await act({ action: "add", scope: add.scope, workdeskId: add.workdeskId ?? null, folder: add.folder ?? null, kind: add.scope === "you" ? "preference" : "fact", name: description, description, body });
            setAdding(false);
            reload?.();
          }}
        />
      )}
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

function Empty({ t }: { t: T }) {
  return <p className="px-1 text-[12.5px] text-[var(--text-muted)]">{t.mem_empty}</p>;
}

function NoteRow({ note, t, reload, readOnly, open: startOpen }: { note: MemoryNote; t: T; reload: () => void; readOnly?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(!!startOpen);
  const [editing, setEditing] = useState(false);
  const pending = note.status === "pending";
  const outdated = note.status === "outdated";
  const run = async (action: "approve" | "restore" | "forget" | "delete") => {
    if (!note.filePath) return;
    // Deleting removes the note's file for good, so it asks first.
    if (
      action === "delete" &&
      !(await confirmAsync({
        title: t.mem_delete_confirm_title,
        body: t.mem_delete_confirm_body(note.description),
        confirmLabel: pending ? t.mem_discard : t.mem_delete,
        confirmTone: "danger",
        focusCancel: true,
      }))
    ) {
      return;
    }
    await act({ action, filePath: note.filePath });
    reload();
  };

  if (editing && note.filePath) {
    return (
      <NoteEditor
        t={t}
        initial={{ description: note.description, body: note.body }}
        onCancel={() => setEditing(false)}
        onSave={async (description, body) => {
          await act({ action: "edit", filePath: note.filePath!, description, body });
          setEditing(false);
          reload();
        }}
      />
    );
  }

  return (
    <div
      className={`group rounded-[10px] px-2.5 py-2 transition-colors duration-instant ${pending ? "bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]" : "hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]"}`}
      style={pending ? { boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)" } : undefined}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 text-left" aria-expanded={open}>
        <span className={`min-w-0 flex-1 text-[13px] leading-[1.4] ${outdated ? "text-[var(--text-muted)] line-through" : "text-[var(--text-primary)]"}`}>{note.description}</span>
        <span className="shrink-0 pt-[1px] text-[11px] text-[var(--text-muted)]">{t.mem_kind(note.kind)}</span>
      </button>
      {open && <div className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-[1.55] text-[var(--text-secondary)]">{note.body}</div>}
      <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
        <span className="min-w-0 truncate">
          {whoWrote(note, t)} · {relative(note.updated, t)}
          {pending && ` · ${note.pendingReason === "web" ? t.mem_reason_web : t.mem_reason_you}`}
        </span>
        <span className="flex-1" />
        {!readOnly && (
          <span className={`flex items-center gap-0.5 ${pending ? "" : "opacity-0 transition-opacity duration-instant group-hover:opacity-100 group-focus-within:opacity-100"}`}>
            {pending && <RowAction label={t.mem_approve} strong onClick={() => void run("approve")} />}
            {pending && <RowAction label={t.mem_discard} onClick={() => void run("delete")} />}
            {!pending && !outdated && <RowAction label={t.mem_edit} onClick={() => setEditing(true)} />}
            {!pending && !outdated && <RowAction label={t.mem_forget} onClick={() => void run("forget")} />}
            {outdated && <RowAction label={t.mem_restore} onClick={() => void run("restore")} />}
            {outdated && <RowAction label={t.mem_delete} onClick={() => void run("delete")} />}
          </span>
        )}
      </div>
    </div>
  );
}

function RowAction({ label, onClick, strong }: { label: string; onClick: () => void; strong?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tc-sq-sm h-6 px-1.5 text-[11.5px] ${strong ? "font-semibold text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"}`}
    >
      {label}
    </button>
  );
}

function NoteEditor({
  t,
  initial,
  onSave,
  onCancel,
}: {
  t: T;
  initial?: { description: string; body: string };
  onSave: (description: string, body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [saving, setSaving] = useState(false);
  const can = description.trim().length > 0 && body.trim().length > 0 && !saving;
  return (
    <div className="mb-1 flex flex-col gap-1.5 rounded-[10px] p-2" style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}>
      <input
        autoFocus
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t.mem_add_title}
        className="h-8 rounded-[8px] bg-transparent px-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t.mem_add_body}
        rows={4}
        className="resize-y rounded-[8px] bg-transparent px-2 py-1.5 text-[12.5px] leading-[1.5] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && can) {
            setSaving(true);
            void onSave(description.trim(), body.trim()).finally(() => setSaving(false));
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <RowAction label={t.mem_cancel} onClick={onCancel} />
        <button
          type="button"
          disabled={!can}
          onClick={() => {
            setSaving(true);
            void onSave(description.trim(), body.trim()).finally(() => setSaving(false));
          }}
          className="tc-sq-sm h-6 px-2 text-[11.5px] font-semibold text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] disabled:opacity-40"
        >
          {t.mem_save}
        </button>
      </div>
    </div>
  );
}

function ActivityList({ notes, t }: { notes: MemoryNote[]; t: T }) {
  const [all, setAll] = useState(false);
  const shown = useMemo(() => (all ? notes : notes.slice(0, 6)), [all, notes]);
  return (
    <div className="flex flex-col">
      {shown.map((n) => (
        <div key={n.filePath} className="flex items-baseline gap-2 px-2.5 py-1 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{n.description}</span>
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{relative(n.updated, t)}</span>
        </div>
      ))}
      {!all && notes.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="px-2.5 py-1 text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          {t.mem_more(notes.length - shown.length)}
        </button>
      )}
    </div>
  );
}

function Outdated({ notes, t, reload }: { notes: MemoryNote[]; t: T; reload: () => void }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <section className="mb-5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="tc-eyebrow flex items-center gap-1.5 px-1 pb-1.5 hover:text-[var(--text-primary)]">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 transition-transform duration-quick ${open ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4" />
        </svg>
        {t.mem_outdated(notes.length)}
      </button>
      {open && (
        <div className="flex flex-col gap-1">
          {notes.map((n) => (
            <NoteRow key={n.filePath} note={n} t={t} reload={reload} />
          ))}
        </div>
      )}
    </section>
  );
}

/** How many notes wait for the person's approval, kept current. */
export function useMemoryPendingCount(workdeskId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const api = window.tacit?.memory;
    if (!workdeskId || !api?.view) return;
    let alive = true;
    const load = () =>
      void api
        .view({ workdeskId })
        .then((data) => alive && setCount(data?.pending.length ?? 0))
        .catch(() => {});
    load();
    const off = api.onStoreChanged?.(load);
    return () => {
      alive = false;
      off?.();
    };
  }, [workdeskId]);
  return count;
}
