import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { useT } from "../i18n/useT";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import {
  useIdentityStore,
} from "../stores/identityStore";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { addConnectedBrowserCardToScene } from "../actions/sceneCardActions";
import type {
  ConnectedBrowserConnection,
  ConnectedTabBinding,
} from "../../shared/browser-connection";
import type { BrowserProfileImportResult, ImportableBrowserProfile } from "../../shared/browser-profile-import";

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

function ImportResultSummary({ result }: { result?: BrowserProfileImportResult }) {
  if (!result) return null;
  if (result.status === "failed") {
    return <div className="tc-timestamp mt-1" style={{ color: "var(--danger)" }}>{result.error} — retry available</div>;
  }
  const cookies = result.identity.provenance.categories.cookies;
  return (
    <div className="tc-timestamp mt-1" style={{ color: "var(--text-muted)" }}>
      Created “{result.identity.name}” · cookies {cookies.status} ({cookies.count}) · passwords unsupported
    </div>
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
  const registerImportedIdentity = useIdentityStore((s) => s.registerImportedIdentity);
  const renameIdentity = useIdentityStore((s) => s.renameIdentity);
  const deleteIdentity = useIdentityStore((s) => s.deleteIdentity);
  const setActiveIdentity = useIdentityStore((s) => s.setActiveIdentity);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pairingOffer, setPairingOffer] = useState<PairingOffer | null>(null);
  const [pairingNow, setPairingNow] = useState(() => Date.now());
  const [authorizedTabs, setAuthorizedTabs] = useState<AuthorizedBrowserTab[]>([]);
  const [browserStatus, setBrowserStatus] = useState<string | null>(null);
  const [loadingBrowsers, setLoadingBrowsers] = useState(false);
  const [importProfiles, setImportProfiles] = useState<ImportableBrowserProfile[]>([]);
  const [loadingImportProfiles, setLoadingImportProfiles] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [importResults, setImportResults] = useState<Record<string, BrowserProfileImportResult>>({});
  const [importing, setImporting] = useState(false);
  const importLockRef = useRef(false);
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

  const refreshImportProfiles = useCallback(async () => {
    setLoadingImportProfiles(true);
    try {
      const profiles = await window.termcanvas.browserIdentity.listImportProfiles();
      setImportProfiles(profiles);
      setSelectedProfileIds(profiles.map((profile) => profile.profileId));
    } catch (error) {
      setBrowserStatus(error instanceof Error ? error.message : "Could not find Chrome profiles");
    } finally {
      setLoadingImportProfiles(false);
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
    void refreshImportProfiles();
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
  }, [open, editingId, confirmDeleteId, closeManager, refreshAuthorizedTabs, refreshImportProfiles]);

  useEffect(() => {
    if (!open || !pairingOffer) return;
    setPairingNow(Date.now());
    const timer = window.setInterval(() => setPairingNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, pairingOffer]);

  const beginBrowserPairing = useCallback(async () => {
    setBrowserStatus("Creating a private connection…");
    try {
      const offer = await window.termcanvas.browserConnection.beginPairing();
      setPairingOffer(offer);
      setPairingNow(Date.now());
      setBrowserStatus("Fresh connection created. Copy it into the Tacit browser extension.");
    } catch (error) {
      setBrowserStatus(error instanceof Error ? error.message : "Could not start browser pairing");
    }
  }, []);

  const copyPairingOffer = useCallback(async () => {
    if (!pairingOffer) return;
    if (Date.parse(pairingOffer.expiresAt) <= Date.now()) {
      setBrowserStatus("This connection expired. Generate a new code before returning to the extension.");
      return;
    }
    await navigator.clipboard.writeText(`${pairingOffer.endpoint}#${pairingOffer.code}`);
    setBrowserStatus("Connection copied. Open the Tacit extension in your browser and paste it there.");
  }, [pairingOffer]);

  const addConnectedTab = useCallback((entry: AuthorizedBrowserTab) => {
    addConnectedBrowserCardToScene(entry.binding, entry.connection);
    setBrowserStatus(`Added “${entry.binding.tab.title || entry.binding.tab.url}” to the canvas.`);
  }, []);

  const importChromeProfiles = useCallback(async (profileIds: string[]) => {
    if (importLockRef.current || profileIds.length === 0) return;
    importLockRef.current = true;
    setImporting(true);
    setBrowserStatus(`Importing ${profileIds.length} Chrome profile${profileIds.length === 1 ? "" : "s"} into fresh identities…`);
    try {
      const batch = await window.termcanvas.browserIdentity.importChromeProfiles({
        profileIds,
        existingIdentityNames: identities.map((identity) => identity.name),
      });
      const nextResults: Record<string, BrowserProfileImportResult> = {};
      for (const result of batch.results) {
        nextResults[result.profileId] = result;
        if (result.status === "completed") registerImportedIdentity(result.identity);
      }
      setImportResults((current) => ({ ...current, ...nextResults }));
      const completed = batch.results.filter((result) => result.status === "completed").length;
      const failures = batch.results.filter((result) => result.status === "failed");
      const cleaned = failures.filter((result) => result.cleanup === "completed").length;
      const cleanupFailed = failures.length - cleaned;
      const failureSummary = failures.length === 0
        ? ""
        : `; ${failures.length} failed (${cleaned} incomplete ${cleaned === 1 ? "identity was" : "identities were"} removed${cleanupFailed > 0 ? `; cleanup failed for ${cleanupFailed}` : ""})`;
      setBrowserStatus(`Created ${completed} new browser ${completed === 1 ? "identity" : "identities"}${failureSummary}.`);
    } catch (error) {
      setBrowserStatus(error instanceof Error ? error.message : "Chrome import failed");
    } finally {
      importLockRef.current = false;
      setImporting(false);
    }
  }, [identities, registerImportedIdentity]);

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
      await window.termcanvas.browserIdentity.clearData(confirmDeleteId);
      deleteIdentity(confirmDeleteId);
      setConfirmDeleteId(null);
    } catch {
      setBrowserStatus("That identity could not be removed because its saved browser data could not be erased.");
    } finally {
      setDeleting(false);
    }
  }, [confirmDeleteId, deleteIdentity]);

  if (!open) return null;

  const deleteTarget = confirmDeleteId
    ? (identities.find((i) => i.id === confirmDeleteId) ?? null)
    : null;
  const pairingRemainingMs = pairingOffer
    ? Math.max(0, Date.parse(pairingOffer.expiresAt) - pairingNow)
    : 0;
  const pairingExpired = pairingOffer !== null && pairingRemainingMs === 0;
  const pairingRemainingMinutes = Math.floor(pairingRemainingMs / 60_000);
  const pairingRemainingSeconds = Math.floor((pairingRemainingMs % 60_000) / 1_000);

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
                <span className="tc-ui" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  Import from Chrome
                </span>
                <p className="tc-meta mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Each selected Chrome profile becomes its own persistent Tacit identity. Default and existing identities stay unchanged. Quit Chrome first; Tacit snapshots source data read-only.
                </p>
                <p className="tc-timestamp mt-1" style={{ color: "var(--text-faint)" }}>
                  Portable cookies are imported. Storage, history, bookmarks, and saved passwords are reported as unsupported in this version; passwords are never read.
                </p>

                {browserStatus && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="tc-meta sticky top-0 z-10 mt-2 rounded-md border border-[var(--border)] px-2.5 py-2"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--surface)",
                    }}
                  >
                    {browserStatus}
                  </div>
                )}

                <div className="mt-2 space-y-1.5">
                  {loadingImportProfiles ? (
                    <div className="tc-meta rounded-md border border-[var(--border)] px-2.5 py-2 text-[var(--text-muted)]">
                      Finding Chrome profiles…
                    </div>
                  ) : importProfiles.length === 0 ? (
                    <div className="tc-meta rounded-md border border-[var(--border)] px-2.5 py-2 text-[var(--text-muted)]">
                      No local Chrome profiles found.
                    </div>
                  ) : <>
                    <div className="flex items-center justify-end gap-2 pb-1">
                      <button type="button" disabled={importing || selectedProfileIds.length === 0} onClick={() => void importChromeProfiles(selectedProfileIds)} className="tc-ui rounded-md border border-[var(--border)] px-2.5 py-1 disabled:opacity-40">Import selected</button>
                      <button type="button" disabled={importing} onClick={() => void importChromeProfiles(importProfiles.map((profile) => profile.profileId))} className="tc-ui rounded-md bg-[var(--text-primary)] px-2.5 py-1 text-[var(--surface)] disabled:opacity-40">{importing ? "Importing…" : "Import all"}</button>
                    </div>
                    {importProfiles.map((profile) => (
                    <div
                      key={profile.profileId}
                      className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-2"
                      style={{ background: "var(--bg)" }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${profile.name}`}
                        checked={selectedProfileIds.includes(profile.profileId)}
                        disabled={importing}
                        onChange={(event) => setSelectedProfileIds((current) => event.target.checked ? [...current, profile.profileId] : current.filter((id) => id !== profile.profileId))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="tc-ui truncate" style={{ color: "var(--text-primary)" }}>
                          {profile.name}
                        </div>
                        <div className="tc-timestamp truncate" style={{ color: "var(--text-faint)" }}>
                          Chrome · {profile.profileId}{profile.accountHint ? ` · ${profile.accountHint}` : ""}
                        </div>
                        <ImportResultSummary result={importResults[profile.profileId]} />
                      </div>
                      <button
                        type="button"
                        disabled={importing}
                        onClick={() => void importChromeProfiles([profile.profileId])}
                        className="tc-ui shrink-0 rounded-md bg-[var(--text-primary)] px-2.5 py-1 text-[var(--surface)] disabled:opacity-40"
                      >
                        Import
                      </button>
                    </div>
                    ))}
                  </>}
                </div>

                <details className="mt-3 border-t border-[var(--border)] pt-2">
                  <summary className="tc-meta cursor-pointer select-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    Connect one live Chrome tab instead (optional)
                  </summary>
                  <div className="mt-2 pl-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="tc-timestamp leading-relaxed" style={{ color: "var(--text-muted)" }}>
                        The extension shares only a tab you explicitly approve. Use this for a live system-browser tab, not normal onboarding.
                      </p>
                      <button
                        type="button"
                        onClick={() => void refreshAuthorizedTabs()}
                        disabled={loadingBrowsers}
                        className="tc-meta shrink-0 rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                      >
                        {loadingBrowsers ? "Checking…" : "Refresh tabs"}
                      </button>
                    </div>
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
                      Install the optional Tacit browser extension
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
                      <div
                        className="mt-2 rounded-md border px-2 py-2"
                        style={{ borderColor: pairingExpired ? "var(--red)" : "color-mix(in srgb, var(--accent) 25%, transparent)" }}
                      >
                        <div className="flex items-center gap-2">
                          <code
                            className="min-w-0 flex-1 truncate text-[11px]"
                            style={{ color: pairingExpired ? "var(--text-faint)" : "var(--text-secondary)" }}
                          >
                            {pairingOffer.endpoint}#{pairingOffer.code}
                          </code>
                          {!pairingExpired && (
                            <button
                              type="button"
                              onClick={() => void copyPairingOffer()}
                              className="tc-ui shrink-0 rounded-md bg-[var(--text-primary)] px-2.5 py-1 text-[var(--surface)]"
                            >
                              Copy connection
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void beginBrowserPairing()}
                            className="tc-ui shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                          >
                            {pairingExpired ? "Generate new code" : "New code"}
                          </button>
                        </div>
                        <p
                          className="tc-timestamp mt-1"
                          style={{ color: pairingExpired ? "var(--red)" : "var(--text-faint)" }}
                        >
                          {pairingExpired
                            ? "Expired or already used? Generate a fresh one-time code."
                            : `One-time code · expires in ${pairingRemainingMinutes}:${String(pairingRemainingSeconds).padStart(2, "0")}`}
                        </p>
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
                  </div>
                </details>

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
