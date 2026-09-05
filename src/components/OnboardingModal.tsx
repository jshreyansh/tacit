import { useCallback, useEffect, useRef, useState } from "react";
import { addProjectFromDirectoryPath } from "../canvas/sceneCommands";
import { useProjectStore } from "../stores/projectStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { addTerminal } from "../toolbar/AddNodeDock";
import { useT } from "../i18n/useT";
import type { TerminalType } from "../types";

/**
 * First run, as a sequence you finish rather than a hint you ignore.
 *
 * This was a strip floating above the dock. It collided with the node dock and
 * with the terminals it had just created, and it advanced off app state — so
 * clicking "Claude" spawned an agent and immediately showed the next step over
 * the top of the trust prompt that agent was still waiting on. Two steps racing
 * each other, neither finished.
 *
 * So the panels no longer react to the app at all. The user answers three
 * questions, the modal closes, and only then does anything happen on the
 * canvas. Nothing can overlap something it created, because it creates nothing
 * until it is gone.
 *
 * Modal is right here and wrong almost everywhere else. This is the first sixty
 * seconds, once, with `Skip setup` visible the whole way through and no second
 * showing after that.
 */

/** Space, agent, browser. */
const PANEL_COUNT = 3;

type Panel = 0 | 1 | 2;
type AgentChoice = Extract<TerminalType, "claude" | "codex">;

export function OnboardingModal() {
  const t = useT();
  const dismissed = usePreferencesStore((s) => s.onboardingDismissed);
  const setDismissed = usePreferencesStore((s) => s.setOnboardingDismissed);
  const notify = useNotificationStore((s) => s.notify);

  // Latched on mount. Panel one adds a project, which would otherwise flip the
  // condition that opened this and tear the modal down mid-sequence.
  const [open] = useState(
    () => !dismissed && useProjectStore.getState().projects.length === 0,
  );
  const [panel, setPanel] = useState<Panel>(0);
  const [spaceName, setSpaceName] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentChoice | null>(null);
  const [wantsBrowser, setWantsBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const finished = useRef(false);

  useBodyScrollLock(open);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    setDismissed(true);
    // Deferred so the modal is off screen before anything appears behind it.
    // Spawning while it is still up is what produced a step sitting on top of
    // the terminal it had just made.
    setTimeout(() => {
      if (agent) addTerminal(agent);
      if (wantsBrowser) {
        usePreferencesStore.getState().setBrowserEnabled(true);
        useIdentityManagerStore.getState().openManager();
      }
    }, 0);
  }, [agent, wantsBrowser, setDismissed]);

  const chooseSpace = useCallback(
    async (mode: "create" | "open") => {
      const api = window.tacit?.project;
      if (!api) return;
      setBusy(true);
      try {
        const dirPath =
          mode === "create" ? await api.createDirectory() : await api.selectDirectory();
        if (!dirPath) return; // Backed out of the sheet; stay on this panel.
        const project = await addProjectFromDirectoryPath(dirPath, t);
        if (!project) return;
        setSpaceName(project.name);
        setPanel(1);
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [notify, t],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish]);

  if (!open || finished.current) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
      role="dialog"
      aria-modal="true"
      aria-label={t.onboarding_space_title}
    >
      <div
        className="tc-enter-fade-up relative rounded-2xl border shadow-2xl"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface)",
          width: "min(460px, 92vw)",
          padding: "28px 28px 20px",
        }}
      >
        <button
          type="button"
          onClick={finish}
          className="absolute right-4 top-4 text-[11px] px-2 py-1 rounded transition-colors duration-quick hover:bg-[var(--border)]"
          style={{ color: "var(--text-faint)" }}
        >
          {t.onboarding_skip}
        </button>

        <div className="flex items-center gap-1.5 mb-6" aria-hidden>
          {Array.from({ length: PANEL_COUNT }, (_, dot) => (
            <span
              key={dot}
              className="rounded-full transition-colors duration-quick"
              style={{
                width: 5,
                height: 5,
                background:
                  dot === panel
                    ? "var(--accent)"
                    : dot < panel
                      ? "var(--text-faint)"
                      : "var(--border)",
              }}
            />
          ))}
        </div>

        {panel === 0 && (
          <Panel title={t.onboarding_space_title} body={t.onboarding_space_body}>
            <Choice label={t.onboarding_space_create} onClick={() => void chooseSpace("create")} disabled={busy} primary />
            <Choice label={t.onboarding_space_open} onClick={() => void chooseSpace("open")} disabled={busy} />
          </Panel>
        )}

        {panel === 1 && (
          <Panel
            title={t.onboarding_agent_title}
            body={t.onboarding_agent_body}
            note={spaceName ? t.onboarding_space_chosen(spaceName) : undefined}
          >
            <Choice label={t.onboarding_agent_claude} onClick={() => { setAgent("claude"); setPanel(2); }} primary />
            <Choice label={t.onboarding_agent_codex} onClick={() => { setAgent("codex"); setPanel(2); }} />
            <Choice label={t.onboarding_not_now} onClick={() => { setAgent(null); setPanel(2); }} quiet />
          </Panel>
        )}

        {panel === 2 && (
          <Panel
            title={t.onboarding_browser_title}
            body={t.onboarding_browser_body}
            note={wantsBrowser ? t.onboarding_browser_handoff : undefined}
          >
            <Choice label={t.onboarding_browser_action} onClick={() => { setWantsBrowser(true); finish(); }} primary />
            <Choice label={t.onboarding_not_now} onClick={finish} quiet />
          </Panel>
        )}

        {panel > 0 && (
          <div className="mt-5 flex justify-start">
            <button
              type="button"
              onClick={() => setPanel((p) => (p - 1) as Panel)}
              className="text-[11px] px-2 py-1 rounded transition-colors duration-quick hover:bg-[var(--border)]"
              style={{ color: "var(--text-faint)" }}
            >
              {t.onboarding_back}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({
  title,
  body,
  note,
  children,
}: {
  title: string;
  body: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <h2 className="tc-display" style={{ color: "var(--text-primary)", marginBottom: 6 }}>
        {title}
      </h2>
      <p className="tc-meta" style={{ color: "var(--text-muted)", marginBottom: 20 }}>
        {body}
      </p>
      <div className="flex flex-col gap-2">{children}</div>
      {note && (
        <p className="tc-meta mt-4" style={{ color: "var(--text-faint)" }}>
          {note}
        </p>
      )}
    </>
  );
}

function Choice({
  label,
  onClick,
  primary = false,
  quiet = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  quiet?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left text-[13px] px-4 py-3 rounded-lg border transition-colors duration-quick disabled:opacity-50"
      style={
        primary
          ? { borderColor: "var(--accent)", background: "var(--accent)", color: "var(--surface)", fontWeight: 600 }
          : quiet
            ? { borderColor: "transparent", color: "var(--text-faint)" }
            : { borderColor: "var(--border)", color: "var(--text-secondary)" }
      }
    >
      {label}
    </button>
  );
}
