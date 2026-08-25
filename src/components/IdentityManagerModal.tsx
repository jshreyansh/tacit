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
import { addConnectedBrowserCardToScene } from "../actions/sceneCardActions";
import type {
  ConnectedBrowserConnection,
  ConnectedTabBinding,
} from "../../shared/browser-connection";

interface PairingOffer {
  endpoint: string;
  code: string;
  expiresAt: string;
}

interface AuthorizedBrowserTab {
  binding: ConnectedTabBinding;
  connection: ConnectedBrowserConnection;
}

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

function BrowserLinkGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.75" y="2.25" width="12.5" height="10.5" rx="2" />
      <path d="M2 5.25h12M4 3.8h.01M6 3.8h.01" />
      <path d="M6.1 9.1h3.8M8 7.2v3.8" />
    </svg>
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
  const [pairingOffer, setPairingOffer] = useState<PairingOffer | null>(null);
  const [authorizedTabs, setAuthorizedTabs] = useState<AuthorizedBrowserTab[]>([]);
  const [browserStatus, setBrowserStatus] = useState<string | null>(null);
  const [loadingBrowsers, setLoadingBrowsers] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  const refreshAuthorizedTabs = useCallback(async () => {
    setLoadingBrowsers(true);
    try {
      setAuthorizedTabs(await window.termcanvas.browserConnection.listTabs());
      setBrowserStatus(null);
    } catch (error) {
      setBrowserStatus(error instanceof Error ? error.message : "Could not read connected tabs");
    } finally {
      setLoadingBrowsers(false);
    }
  }, []);

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
    void refreshAuthorizedTabs();
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
  }, [open, editingId, confirmDeleteId, closeManager, refreshAuthorizedTabs]);

  const beginBrowserPairing = useCallback(async () => {
    setBrowserStatus("Creating a private connection…");
    try {
      const offer = await window.termcanvas.browserConnection.beginPairing();
      setPairingOffer(offer);
      setBrowserStatus("Paste this connection into the Tacit browser extension.");
    } catch (error) {
      setBrowserStatus(error instanceof Error ? error.message : "Could not start browser pairing");
    }
  }, []);

  const copyPairingOffer = useCallback(async () => {
    if (!pairingOffer) return;
    await navigator.clipboard.writeText(`${pairingOffer.endpoint}#${pairingOffer.code}`);
    setBrowserStatus("Connection copied. Open the Tacit extension in your browser and paste it there.");
  }, [pairingOffer]);

  const addConnectedTab = useCallback((entry: AuthorizedBrowserTab) => {
    addConnectedBrowserCardToScene(entry.binding, entry.connection);
    setBrowserStatus(`Added “${entry.binding.tab.title || entry.binding.tab.url}” to the canvas.`);
  }, []);

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
          className="w-[540px] max-w-[92vw] max-h-[86vh] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl"
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

          <div className="overflow-y-auto max-h-[calc(86vh-94px)]">
          <ul className="px-2 py-2 max-h-[250px] overflow-y-auto">
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

          <section className="border-t border-[var(--border)] px-4 py-3">
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)]"
                style={{ background: "var(--bg)" }}
              >
                <BrowserLinkGlyph />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tc-ui" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    Use your signed-in browser
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshAuthorizedTabs()}
                    disabled={loadingBrowsers}
                    className="tc-meta rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                  >
                    {loadingBrowsers ? "Checking…" : "Refresh"}
                  </button>
                </div>
                <p className="tc-meta mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Connect one tab from Chrome, Edge, or Brave. Tacit controls only tabs you explicitly share; it never copies your profile or cookies.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const folder = await window.termcanvas.browserConnection.openExtensionFolder();
                      await navigator.clipboard.writeText(folder);
                      setBrowserStatus("Extension folder opened and its path copied. In your browser’s Extensions page, choose “Load unpacked” and select it.");
                    } catch (error) {
                      setBrowserStatus(error instanceof Error ? error.message : "Could not open the extension folder");
                    }
                  }}
                  className="tc-meta mt-1 underline decoration-[var(--border-hover)] underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Install the Tacit browser extension
                </button>

                {authorizedTabs.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {authorizedTabs.map((entry) => (
                      <div
                        key={entry.binding.id}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5"
                        style={{ background: "var(--bg)" }}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--green)" }} />
                        <div className="min-w-0 flex-1">
                          <div className="tc-ui truncate" style={{ color: "var(--text-primary)" }}>
                            {entry.binding.tab.title || "Untitled tab"}
                          </div>
                          <div className="tc-timestamp truncate" style={{ color: "var(--text-faint)" }}>
                            {entry.connection.identity.browser} · {entry.connection.identity.profileLabel} · {entry.binding.tab.url}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => addConnectedTab(entry)}
                          className="tc-ui shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                        >
                          Add to canvas
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {pairingOffer ? (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-[var(--accent)]/25 px-2 py-2">
                    <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
                      {pairingOffer.endpoint}#{pairingOffer.code}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyPairingOffer()}
                      className="tc-ui shrink-0 rounded-md bg-[var(--text-primary)] px-2.5 py-1 text-[var(--surface)]"
                    >
                      Copy connection
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void beginBrowserPairing()}
                    className="tc-ui mt-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    Pair a system browser
                  </button>
                )}

                {browserStatus && (
                  <p role="status" className="tc-timestamp mt-2" style={{ color: "var(--text-muted)" }}>
                    {browserStatus}
                  </p>
                )}
              </div>
            </div>
          </section>
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
