import { memo, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import { usePinStore } from "../stores/pinStore";
import { usePinDragStore } from "../stores/pinDragStore";
import { useProjectStore } from "../stores/projectStore";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import type { Pin } from "../types";
import { splitPinsByStatus } from "./pinsViewModel";

/**
 * A project's pins, in the docked chat (it took over from the drawer that
 * slid out of the left bar's Sessions panel). Open or done; each one opens
 * in the pin view beside the chat, drags onto the canvas or onto a
 * terminal, and can be handed to the manager.
 */

type Dict = ReturnType<typeof useT>;

function StatusRing({ status, t }: { status: Pin["status"]; t: Dict }) {
  if (status === "done") {
    return <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--green)]" title={t["pin.statusDone"]} />;
  }
  if (status === "dropped") {
    return <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--text-faint)]" title={t["pin.statusDropped"]} />;
  }
  return <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[var(--text-muted)]" title={t["pin.statusOpen"]} />;
}

const actionButton =
  "tc-rail-btn inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50";

const PinRow = memo(function PinRow({ pin, onHand, t }: { pin: Pin; onHand: ((pin: Pin) => void) | null; t: Dict }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const openDetail = usePinStore((s) => s.openDetail);
  const upsertPin = usePinStore((s) => s.upsertPin);
  const removePin = usePinStore((s) => s.removePin);
  const firstLine = pin.body.split("\n").find((line) => line.trim()) ?? "";
  const onCanvas = typeof pin.x === "number" && typeof pin.y === "number";

  const setStatus = async (status: Pin["status"]) => {
    if (busy) return;
    setBusy(true);
    try {
      upsertPin(pin.repo, await window.tacit.pins.update(pin.repo, pin.id, { status }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.tacit.pins.remove(pin.repo, pin.id);
      removePin(pin.repo, pin.id);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-tacit-pin", JSON.stringify({ repo: pin.repo, id: pin.id }));
          e.dataTransfer.effectAllowed = "copy";
          usePinDragStore.getState().setActive(true);
          window.dispatchEvent(new CustomEvent("tacit:pin-drag-active"));
        }}
        onDragEnd={() => {
          usePinDragStore.getState().setActive(false);
          window.dispatchEvent(new CustomEvent("tacit:pin-drag-end"));
        }}
        onClick={() => openDetail(pin.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(pin.id);
          }
        }}
        className="group flex cursor-grab flex-col gap-1.5 rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] px-3 py-2.5 text-left hover:border-[var(--border-hover)] active:cursor-grabbing"
      >
        <div className="flex items-start gap-2.5">
          <StatusRing status={pin.status} t={t} />
          <span
            className={`min-w-0 flex-1 text-[13px] font-medium leading-snug ${
              pin.status === "dropped" ? "text-[var(--text-faint)] line-through" : "text-[var(--text-primary)]"
            }`}
          >
            {pin.title || t["pin.untitled"]}
          </span>
          {onCanvas && (
            <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--green)_40%,transparent)] px-1.5 text-[10px] text-[var(--green)]">
              {t.chat_pins_on_canvas}
            </span>
          )}
        </div>
        {firstLine && <div className="truncate pl-[18px] text-[12px] text-[var(--text-muted)]">{firstLine}</div>}
        <div className="flex min-h-7 items-center gap-1 pl-[18px]">
          <span className="tc-mono truncate text-[10.5px] text-[var(--text-faint)]">
            {[pin.links.length > 0 ? t["pin.linkCount"](pin.links.length) : null, t["pin.meta.updated"](t["pin.relativeTime"](Date.now() - Date.parse(pin.updated)))]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {onHand && pin.status === "open" && (
              <button
                type="button"
                className="tc-rail-btn inline-flex h-7 shrink-0 items-center gap-1.5 border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title={t.chat_pins_hand_hint}
                onClick={(e) => {
                  e.stopPropagation();
                  onHand(pin);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 2.5v11M4 9.5l4 4 4-4" />
                </svg>
                {t.chat_pins_hand}
              </button>
            )}
            <button
              type="button"
              className={actionButton}
              disabled={busy}
              title={pin.status === "open" ? t["pin.action.markDone"] : t["pin.action.reopen"]}
              aria-label={pin.status === "open" ? t["pin.action.markDone"] : t["pin.action.reopen"]}
              onClick={(e) => {
                e.stopPropagation();
                void setStatus(pin.status === "open" ? "done" : "open");
              }}
            >
              {pin.status === "open" ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5.5 4L2.5 7l3 3" />
                  <path d="M2.5 7h7a3.5 3.5 0 0 1 0 7H7" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`${actionButton} hover:text-[var(--red)]`}
              disabled={busy}
              title={t["pin.action.delete"]}
              aria-label={t["pin.action.delete"]}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 3h8M5 3V2h2v1M4 3v6.5a.5.5 0 00.5.5h3a.5.5 0 00.5-.5V3" />
              </svg>
            </button>
          </span>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t["pin.deleteConfirm.title"]}
        body={t["pin.deleteConfirm.body"]}
        confirmLabel={t["pin.deleteConfirm.action"]}
        confirmTone="danger"
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
});

export function PinsView({ onHand }: { onHand: ((pin: Pin) => void) | null }) {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const openProjectPath = usePinStore((s) => s.openProjectPath);
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const openDrawer = usePinStore((s) => s.openDrawer);
  const startCompose = usePinStore((s) => s.startCompose);
  const [filter, setFilter] = useState<"open" | "done">("open");

  // Opened from the header icon rather than a project's badge: the first project.
  useEffect(() => {
    if (!openProjectPath && projects[0]) openDrawer(projects[0].path);
  }, [openProjectPath, projects, openDrawer]);

  const pins = openProjectPath ? (pinsByProject[openProjectPath] ?? null) : null;
  const split = useMemo(() => splitPinsByStatus(pins ?? []), [pins]);
  const shown = filter === "open" ? split.open : split.done;

  if (projects.length === 0) {
    return <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">{t.chat_pins_no_project}</div>;
  }

  const segment = (value: "open" | "done", label: string, count: number) => (
    <button
      type="button"
      className="tc-rail-btn h-6 px-2 text-[11.5px] text-[var(--text-muted)] data-[on]:bg-[var(--surface-hover)] data-[on]:text-[var(--text-primary)]"
      data-on={filter === value ? "" : undefined}
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {label} <span className="tc-mono tabular-nums">{count}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-2 pt-2.5">
        {projects.length > 1 ? (
          <label className="flex h-[30px] min-w-0 items-center rounded-[8px] border border-[var(--border)] px-2 text-[12.5px] text-[var(--text-primary)]">
            <span className="sr-only">{t.chat_pins_project}</span>
            <select
              value={openProjectPath ?? ""}
              onChange={(e) => openDrawer(e.target.value)}
              className="min-w-0 max-w-[150px] bg-transparent text-[12.5px] outline-none"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="truncate px-1 text-[12.5px] font-medium text-[var(--text-primary)]">{projects[0].name}</span>
        )}
        <div className="flex gap-0.5 rounded-[8px] border border-[var(--border)] p-0.5" role="group" aria-label={t.chat_pins}>
          {segment("open", t.chat_pins_filter_open, split.open.length)}
          {segment("done", t.chat_pins_filter_done, split.done.length)}
        </div>
        <button
          type="button"
          className="tc-rail-btn ml-auto inline-flex h-[30px] items-center gap-1.5 border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          disabled={!openProjectPath}
          onClick={() => openProjectPath && startCompose(openProjectPath)}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 2V10M2 6H10" />
          </svg>
          {t["pin.newPin"]}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {pins === null ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">{t["pin.loading"]}</div>
        ) : pins.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">{t["pin.emptyState"]}</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">{filter === "open" ? t.chat_pins_none_open : t.chat_pins_none_done}</div>
        ) : (
          shown.map((pin) => <PinRow key={pin.id} pin={pin} onHand={onHand} t={t} />)
        )}
        {pins !== null && pins.length > 0 && (
          <div className="mt-1 rounded-[10px] border border-dashed border-[var(--border)] px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
            {t.chat_pins_drag_hint}
          </div>
        )}
      </div>
    </div>
  );
}
