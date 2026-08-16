import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { useT } from "../i18n/useT";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import {
  useIdentityStore,
  partitionForIdentity,
} from "../stores/identityStore";
import { ConfirmDialog } from "./ui/ConfirmDialog";

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path
        d="M2 2L8 8M8 2L2 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 3l2 2-7.5 7.5H3.5V10z" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4h10" />
      <path d="M5 4V2.5h6V4" />
      <path d="M4.5 4l.5 8h6l.5-8" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ActiveDotGlyph() {
  return (
    <span
      aria-hidden
      className="status-pulse inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: "var(--accent)" }}
    />
  );
}

export function IdentityManagerModal() {
  const t = useT();
  const open = useIdentityManagerStore((s) => s.open);
  useBodyScrollLock(open);
  const renameTargetId = useIdentityManagerStore((s) => s.renameTargetId);
  const closeManager = useIdentityManagerStore((s) => s.close);

  const identitiesById = useIdentityStore((s) => s.identities);
  const identities = Object.values(identitiesById).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  const activeIdentityId = useIdentityStore((s) => s.activeIdentityId);
  const createIdentity = useIdentityStore((s) => s.createIdentity);
  const renameIdentity = useIdentityStore((s) => s.renameIdentity);
  const deleteIdentity = useIdentityStore((s) => s.deleteIdentity);
  const setActiveIdentity = useIdentityStore((s) => s.setActiveIdentity);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Open-from-keyboard/command-palette with a target id.
  useEffect(() => {
    if (open && renameTargetId) {
      const target = identities.find((i) => i.id === renameTargetId);
      if (target) {
        setEditingId(target.id);
        setDraftName(target.name);
      }
    }
  }, [open, renameTargetId, identities]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.select();
      editInputRef.current.focus();
    }
  }, [editingId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingId) {
          e.preventDefault();
          setEditingId(null);
          setDraftName("");
          return;
        }
        if (confirmDeleteId) return;
        e.preventDefault();
        closeManager();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, editingId, confirmDeleteId, closeManager]);

  const commitRename = useCallback(() => {
    if (!editingId) return;
    const trimmed = draftName.trim();
    if (trimmed.length > 0) {
      renameIdentity(editingId, trimmed);
    }
    setEditingId(null);
    setDraftName("");
  }, [editingId, draftName, renameIdentity]);

  const handleCreate = useCallback(() => {
    createIdentity();
  }, [createIdentity]);

  const handleSetActive = useCallback(
    (identityId: string) => {
      setActiveIdentity(identityId);
    },
    [setActiveIdentity],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDeleteId) return;
    setDeleting(true);
    try {
      await window.termcanvas.browserIdentity.clearData(
        partitionForIdentity(confirmDeleteId),
      );
    } catch (err) {
      console.error("[IdentityManagerModal] failed to clear session data", err);
    }
    deleteIdentity(confirmDeleteId);
    setDeleting(false);
    setConfirmDeleteId(null);
  }, [confirmDeleteId, deleteIdentity]);

  if (!open) return null;

  const deleteTarget = confirmDeleteId
    ? (identities.find((i) => i.id === confirmDeleteId) ?? null)
    : null;

  return createPortal(
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t["identity.manager.title"]}
        className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--scrim)] tc-enter-fade-up"
        onClick={() => {
          if (!editingId) closeManager();
        }}
      >
        <div
          className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between px-4 pt-3 pb-3 border-b border-[var(--border)]">
            <div className="flex items-baseline gap-2">
              <span
                className="tc-display"
                style={{
                  fontSize: "15px",
                  letterSpacing: "var(--tracking-title)",
                }}
              >
                {t["identity.manager.title"]}
              </span>
              <span className="tc-eyebrow">
                {t["identity.manager.subtitle"](identities.length)}
              </span>
            </div>
            <button
              type="button"
              onClick={closeManager}
              aria-label={t.cancel}
              className="tc-row-icon inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <CloseGlyph />
            </button>
          </header>

          <ul className="px-2 py-2 max-h-[320px] overflow-y-auto">
            {identities.map((identity) => {
              const isActive = identity.id === activeIdentityId;
              const isEditing = editingId === identity.id;
              const isOnlyIdentity = identities.length === 1;
              return (
                <li key={identity.id}>
                  <div className="tc-row-hover flex items-center gap-2 rounded-md px-2 py-1.5">
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center"
                      aria-hidden
                    >
                      {isActive ? (
                        <ActiveDotGlyph />
                      ) : (
                        <span
                          className="inline-block h-1 w-1 rounded-full"
                          style={{ background: "var(--text-faint)" }}
                        />
                      )}
                    </span>
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                            setDraftName("");
                          }
                        }}
                        onBlur={commitRename}
                        className="tc-ui flex-1 bg-transparent border-b border-[var(--accent)]/40 outline-none px-0.5"
                        style={{ color: "var(--text-primary)" }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSetActive(identity.id)}
                        onDoubleClick={() => {
                          setEditingId(identity.id);
                          setDraftName(identity.name);
                        }}
                        className="tc-ui flex-1 text-left truncate"
                        style={{
                          color: isActive
                            ? "var(--text-primary)"
                            : "var(--text-secondary)",
                        }}
                        title={t["identity.manager.setDefaultTooltip"]}
                      >
                        {identity.name}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(identity.id);
                        setDraftName(identity.name);
                      }}
                      aria-label={t["identity.manager.rename"]}
                      title={t["identity.manager.rename"]}
                      className="tc-row-icon h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
                    >
                      <PencilGlyph />
                    </button>
                    <button
                      type="button"
                      disabled={isOnlyIdentity}
                      onClick={() => setConfirmDeleteId(identity.id)}
                      aria-label={t["identity.manager.delete"]}
                      title={
                        isOnlyIdentity
                          ? t["identity.manager.deleteLastDisabled"]
                          : t["identity.manager.delete"]
                      }
                      className="tc-row-icon h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hover)] hover:text-[var(--red)] disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <TrashGlyph />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-[var(--border)] px-2 py-2">
            <button
              type="button"
              onClick={handleCreate}
              className="tc-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]"
                aria-hidden
              >
                <PlusGlyph />
              </span>
              <span
                className="tc-ui flex-1"
                style={{ color: "var(--text-primary)" }}
              >
                {t["identity.manager.newIdentity"]}
              </span>
              <span className="tc-meta" style={{ color: "var(--text-faint)" }}>
                {t["identity.manager.newIdentityHint"]}
              </span>
            </button>
          </div>

          <footer
            className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border)]"
            style={{ color: "var(--text-faint)" }}
          >
            <span
              className="tc-timestamp"
              style={{ color: "var(--text-faint)" }}
            >
              {t["identity.manager.setDefaultHint"]}
            </span>
            <span
              className="tc-timestamp ml-auto"
              style={{ color: "var(--text-faint)" }}
            >
              {t["hub.escCloses"]}
            </span>
          </footer>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t["identity.delete.title"]}
        body={deleteTarget ? t["identity.delete.body"](deleteTarget.name) : ""}
        confirmLabel={t["identity.delete.confirm"]}
        busyLabel={t["identity.delete.confirming"]}
        busy={deleting}
        confirmTone="danger"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </>,
    document.body,
  );
}
