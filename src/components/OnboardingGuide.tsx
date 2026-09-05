import { useCallback, useMemo } from "react";
import {
  ONBOARDING_STEP_COUNT,
  isAgentTerminalType,
  onboardingStepIndex,
  resolveOnboardingStep,
} from "../../shared/onboarding";
import { useProjectStore } from "../stores/projectStore";
import { useIdentityStore } from "../stores/identityStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { addTerminal } from "../toolbar/AddNodeDock";
import { useT } from "../i18n/useT";

/**
 * The two getting-started steps that have somewhere to happen.
 *
 * Step one is the empty canvas itself — it already fills the screen and says
 * what to do, so repeating it in a strip underneath would be the app telling
 * you the same thing twice. This picks up once there is a space to work in,
 * and covers the two things nobody finds on their own: that agents go on the
 * canvas, and that they can use your real browser sessions.
 *
 * Deliberately not a modal. Someone who wants to explore should never have to
 * dismiss the app to do it, and someone who already knows the product should
 * be able to ignore this entirely — which is what `Skip` is for.
 */
export function OnboardingGuide() {
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const identities = useIdentityStore((s) => s.identities);
  const dismissed = usePreferencesStore((s) => s.onboardingDismissed);
  const setDismissed = usePreferencesStore((s) => s.setOnboardingDismissed);

  const step = useMemo(() => {
    const agentTerminals = projects.reduce(
      (total, project) =>
        total +
        project.worktrees.reduce(
          (n, worktree) =>
            n + worktree.terminals.filter((term) => isAgentTerminalType(term.type)).length,
          0,
        ),
      0,
    );
    // Only a profile carrying provenance counts: the default one ships with
    // every workspace and is signed into nothing.
    const importedProfiles = Object.values(identities).filter(
      (identity) => identity.provenance !== undefined,
    ).length;
    return resolveOnboardingStep({
      projects: projects.length,
      agentTerminals,
      importedProfiles,
    });
  }, [projects, identities]);

  const handleImport = useCallback(() => {
    // The browser feature ships off, so the step that needs it turns it on.
    // Asking someone to find a settings toggle first would make this the one
    // instruction in the sequence that does not work when followed.
    usePreferencesStore.getState().setBrowserEnabled(true);
    useIdentityManagerStore.getState().openManager();
  }, []);

  if (dismissed || step === "space" || step === "done") return null;
  const index = onboardingStepIndex(step);
  if (index === null) return null;

  const isAgentStep = step === "agent";

  return (
    <div
      className="absolute inset-x-0 flex justify-center pointer-events-none"
      style={{ bottom: 112, zIndex: 20 }}
      role="status"
      aria-live="polite"
    >
      <div
        className="tc-enter-fade-up pointer-events-auto flex items-center gap-5 rounded-xl border px-4 py-3 shadow-lg"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface)",
          maxWidth: "min(560px, 92vw)",
        }}
      >
        <div className="flex flex-col gap-1.5 min-w-0">
          <div
            className="flex items-center gap-1.5"
            aria-label={t.onboarding_progress(String(index + 1), String(ONBOARDING_STEP_COUNT))}
          >
            {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, dot) => (
              <span
                key={dot}
                aria-hidden
                className="rounded-full transition-colors duration-quick"
                style={{
                  width: 5,
                  height: 5,
                  background:
                    dot === index
                      ? "var(--accent)"
                      : dot < index
                        ? "var(--text-faint)"
                        : "var(--border)",
                }}
              />
            ))}
          </div>
          <span
            className="tc-body-sm truncate"
            style={{ color: "var(--text-primary)", fontWeight: 600 }}
          >
            {isAgentStep ? t.onboarding_agent_title : t.onboarding_browser_title}
          </span>
          <span className="tc-meta" style={{ color: "var(--text-muted)" }}>
            {isAgentStep ? t.onboarding_agent_body : t.onboarding_browser_body}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isAgentStep ? (
            <>
              <GuideAction label={t.onboarding_agent_claude} onClick={() => addTerminal("claude")} primary />
              <GuideAction label={t.onboarding_agent_codex} onClick={() => addTerminal("codex")} />
            </>
          ) : (
            <GuideAction label={t.onboarding_browser_action} onClick={handleImport} primary />
          )}
          <button
            type="button"
            className="tc-meta px-2 py-1 rounded transition-colors duration-quick hover:bg-[var(--border)]"
            style={{ color: "var(--text-faint)" }}
            onClick={() => setDismissed(true)}
          >
            {t.onboarding_skip}
          </button>
        </div>
      </div>
    </div>
  );
}

function GuideAction({
  label,
  onClick,
  primary = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] px-3 py-1.5 rounded-lg border transition-colors duration-quick whitespace-nowrap"
      style={
        primary
          ? {
              borderColor: "var(--accent)",
              background: "var(--accent)",
              color: "var(--surface)",
              fontWeight: 600,
            }
          : { borderColor: "var(--border)", color: "var(--text-secondary)" }
      }
    >
      {label}
    </button>
  );
}
