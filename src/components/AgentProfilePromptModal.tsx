import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { useT } from "../i18n/useT";
import { useAgentProfilePromptStore } from "../stores/agentProfilePromptStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useIdentityStore } from "../stores/identityStore";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { isAgentAllowed } from "../types/workspace";
import { isGuestProfile } from "../browser/profileColor";
import { ProfileDot } from "./ProfileDot";

/**
 * Asked once per canvas: which profile do agents work as here?
 *
 * Only the profiles the user allows agents to use are offered — the global
 * toggle in the profile manager is the permission, and this is only the
 * default among what is already permitted. Dismissing is an answer too: it
 * stores `null`, so the canvas records that the question was put and declined
 * rather than pretending it was never asked.
 */
export function AgentProfilePromptModal() {
  const t = useT();
  const canvasId = useAgentProfilePromptStore((s) => s.canvasId);
  const choose = useAgentProfilePromptStore((s) => s.choose);
  const dismiss = useAgentProfilePromptStore((s) => s.dismiss);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const identitiesById = useIdentityStore((s) => s.identities);

  const open = canvasId !== null;
  useBodyScrollLock(open);

  const handleDismiss = useCallback(() => dismiss(), [dismiss]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDismiss();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, handleDismiss]);

  if (!open) return null;

  const canvas = canvases.find((c) => c.id === canvasId);
  const allowed = Object.values(identitiesById)
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter(isAgentAllowed);
  const currentDefault = canvas?.agentDefaultIdentityId ?? null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t["agentProfile.prompt.title"]}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--scrim)] tc-enter-fade-up"
      onClick={handleDismiss}
    >
      <div
        className="w-[420px] max-w-[92vw] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 pt-3 pb-2 border-b border-[var(--border)]">
          <div
            className="tc-display"
            style={{ fontSize: "15px", letterSpacing: "var(--tracking-title)" }}
          >
            {t["agentProfile.prompt.title"]}
          </div>
          <p
            className="tc-meta mt-1 leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {t["agentProfile.prompt.body"](canvas?.name ?? "")}
          </p>
        </header>

        {allowed.length === 0 ? (
          <div className="px-4 py-3">
            <p className="tc-meta" style={{ color: "var(--text-muted)" }}>
              {t["agentProfile.prompt.none"]}
            </p>
            <button
              type="button"
              onClick={() => {
                handleDismiss();
                useIdentityManagerStore.getState().openManager();
              }}
              className="tc-ui mt-2 rounded-md border border-[var(--border)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              {t["identity.command.manage"]}
            </button>
          </div>
        ) : (
          <ul className="max-h-[280px] overflow-y-auto px-2 py-2">
            {allowed.map((identity) => (
              <li key={identity.id}>
                <button
                  type="button"
                  onClick={() => choose(identity.id)}
                  className="tc-row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                >
                  <ProfileDot identityId={identity.id} />
                  <span
                    className="tc-ui flex-1 truncate"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {identity.name}
                  </span>
                  {isGuestProfile(identity.id) && (
                    <span
                      className="tc-timestamp shrink-0"
                      style={{ color: "var(--text-faint)" }}
                    >
                      {t.browser_identity_guest_hint}
                    </span>
                  )}
                  {currentDefault === identity.id && (
                    <span
                      className="tc-timestamp shrink-0"
                      style={{ color: "var(--accent)" }}
                    >
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-2">
          <span className="tc-timestamp" style={{ color: "var(--text-faint)" }}>
            {t["agentProfile.prompt.dismissHint"]}
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            className="tc-ui ml-auto rounded-md border border-[var(--border)] px-2.5 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            {t["agentProfile.prompt.dismiss"]}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
