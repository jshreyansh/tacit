import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { addProjectFromDirectoryPath } from "../canvas/sceneCommands";
import { useProjectStore } from "../stores/projectStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { addTerminal } from "../toolbar/AddNodeDock";
import { useT } from "../i18n/useT";
import type { TerminalType } from "../types";
import folderIcon from "../assets/dock-icons/folder.png";
import chromeIcon from "../assets/dock-icons/browser.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";

/**
 * First run, as a sequence you finish rather than a hint you ignore.
 *
 * This began as a strip floating above the dock. It collided with the node dock
 * and with the terminals it had just created, and it advanced off app state —
 * so clicking "Claude" spawned an agent and immediately showed the next step on
 * top of the trust prompt that agent was still waiting on.
 *
 * So the panels no longer read the app. Three questions are answered up front,
 * the takeover closes, and only then does anything happen on the canvas.
 * Nothing can overlap something it created, because it creates nothing until it
 * is gone.
 *
 * It is a dialog on a scrim, in the family Settings belongs to. Blocking is
 * about focus rather than about covering every pixel: a full-bleed version made
 * three questions feel like an installer. Modal is right for the first sixty
 * seconds and wrong almost everywhere after, so `Skip setup` is visible
 * throughout, Escape works, and it never shows again.
 */

/** Space, agent, browser. */
const PANEL_COUNT = 3;

type Panel = 0 | 1 | 2 | 3;
type AgentChoice = Extract<TerminalType, "claude" | "codex">;
type SlotState = "pending" | "done" | "skipped";

interface Slot {
  icons: string[];
  label: string;
  hint?: string;
  state: SlotState;
}

const AGENT_ICON: Record<AgentChoice, string> = {
  claude: claudeIcon,
  codex: codexIcon,
};

export function OnboardingModal() {
  const t = useT();
  const dismissed = usePreferencesStore((s) => s.onboardingDismissed);
  const setDismissed = usePreferencesStore((s) => s.setOnboardingDismissed);
  const notify = useNotificationStore((s) => s.notify);

  // Latched on mount. Panel one adds a project, which would otherwise flip the
  // condition that opened this and tear the takeover down mid-sequence.
  const [open] = useState(
    () => !dismissed && useProjectStore.getState().projects.length === 0,
  );
  const [panel, setPanel] = useState<Panel>(0);
  const [spaceName, setSpaceName] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentChoice | null>(null);
  const [wantsBrowser, setWantsBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justLit, setJustLit] = useState<string | null>(null);
  const closed = useRef(false);

  useBodyScrollLock(open);

  const space: Slot = spaceName
    ? { icons: [folderIcon], label: spaceName, state: "done" }
    : { icons: [folderIcon], label: t.onboarding_rail_space, state: "pending" };

  const agentSlot: Slot = agent
    ? { icons: [AGENT_ICON[agent]], label: agent === "claude" ? "Claude" : "Codex", state: "done" }
    : panel > 1
      ? { icons: [claudeIcon], label: t.onboarding_rail_agent_none, state: "skipped" }
      : {
          icons: [claudeIcon, codexIcon],
          label: t.onboarding_rail_agent,
          hint: t.onboarding_rail_agent_hint,
          state: "pending",
        };

  const browserSlot: Slot = wantsBrowser
    ? { icons: [chromeIcon], label: t.onboarding_rail_browser, state: "done" }
    : panel > 2
      ? { icons: [chromeIcon], label: t.onboarding_rail_browser_none, state: "skipped" }
      : { icons: [chromeIcon], label: t.onboarding_rail_browser, state: "pending" };

  /**
   * Close, then act — in order, one thing at a time.
   *
   * Both actions used to fire in the same tick as the takeover unmounted. The
   * profile manager closes on any click on its own scrim, so opening it inside
   * the click that asked for it meant it shut again immediately; and a terminal
   * spawning underneath it made that impossible to see. The agent now waits for
   * the manager to close, and the manager waits for this to be off screen.
   */
  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDismissed(true);

    const spawnAgent = () => {
      if (agent) addTerminal(agent);
    };

    window.setTimeout(() => {
      if (!wantsBrowser) {
        spawnAgent();
        return;
      }
      usePreferencesStore.getState().setBrowserEnabled(true);
      useIdentityManagerStore.getState().openManager();
      const unsubscribe = useIdentityManagerStore.subscribe((state, previous) => {
        if (previous.open && !state.open) {
          unsubscribe();
          spawnAgent();
        }
      });
    }, 140);
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
        setJustLit("space");
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

  if (!open || closed.current) return null;

  const ready = panel === 3;
  const actions: Array<{ icon: string; text: string }> = [];
  if (wantsBrowser) actions.push({ icon: chromeIcon, text: t.onboarding_ready_import });
  if (agent) {
    actions.push({
      icon: AGENT_ICON[agent],
      text: t.onboarding_ready_agent(agent === "claude" ? "Claude" : "Codex", spaceName ?? ""),
    });
  }
  if (actions.length === 0) actions.push({ icon: folderIcon, text: t.onboarding_ready_empty });

  return (
    <div
      className="tc-onboarding fixed inset-0 z-[300] grid place-items-center p-8"
      role="dialog"
      aria-modal="true"
      aria-label={t.onboarding_space_title}
    >
      <div className="tc-onboarding-scrim" />
      <div className="tc-onboarding-card">
      <div className="grid items-start tc-onboarding-stage">
        <div>
          <h2 className="tc-onboarding-title">
            {panel === 0 && t.onboarding_space_title}
            {panel === 1 && t.onboarding_agent_title}
            {panel === 2 && t.onboarding_browser_title}
            {ready && t.onboarding_ready_title}
          </h2>
          <p className="tc-onboarding-body">
            {panel === 0 && t.onboarding_space_body}
            {panel === 1 && t.onboarding_agent_body}
            {panel === 2 && t.onboarding_browser_body}
            {ready && (actions.length > 1 ? t.onboarding_ready_two : t.onboarding_ready_one)}
          </p>

          {panel === 0 && (
            <div className="tc-onboarding-choices two">
              <Choice
                icon={folderIcon}
                plus
                primary
                title={t.onboarding_space_create}
                detail={t.onboarding_space_create_desc}
                disabled={busy}
                onClick={() => void chooseSpace("create")}
              />
              <Choice
                icon={folderIcon}
                title={t.onboarding_space_open}
                detail={t.onboarding_space_open_desc}
                disabled={busy}
                onClick={() => void chooseSpace("open")}
              />
            </div>
          )}

          {panel === 1 && (
            <>
              <div className="tc-onboarding-choices two">
                <Choice
                  icon={claudeIcon}
                  primary
                  title={t.onboarding_agent_claude}
                  detail={t.onboarding_agent_claude_desc}
                  onClick={() => { setAgent("claude"); setJustLit("agent"); setPanel(2); }}
                />
                <Choice
                  icon={codexIcon}
                  title={t.onboarding_agent_codex}
                  detail={t.onboarding_agent_codex_desc}
                  onClick={() => { setAgent("codex"); setJustLit("agent"); setPanel(2); }}
                />
              </div>
              <QuietButton onClick={() => { setAgent(null); setPanel(2); }}>
                {t.onboarding_not_now}
              </QuietButton>
            </>
          )}

          {panel === 2 && (
            <>
              <div className="tc-onboarding-choices">
                <Choice
                  icon={chromeIcon}
                  primary
                  title={t.onboarding_browser_action}
                  detail={t.onboarding_browser_action_desc}
                  onClick={() => { setWantsBrowser(true); setJustLit("browser"); setPanel(3); }}
                />
              </div>
              <QuietButton onClick={() => { setWantsBrowser(false); setPanel(3); }}>
                {t.onboarding_not_now}
              </QuietButton>
            </>
          )}

          {ready && (
            <>
              <ol className="tc-onboarding-handoff">
                {actions.map((action) => (
                  <li key={action.text}>
                    <img src={action.icon} alt="" />
                    <span>{action.text}</span>
                  </li>
                ))}
              </ol>
              <button type="button" className="tc-onboarding-start" onClick={finish}>
                {t.onboarding_start}
              </button>
            </>
          )}
        </div>

        <aside className="tc-onboarding-rail">
          <h3>{t.onboarding_rail_title}</h3>
          <ol>
            <SlotRow slot={space} lit={justLit === "space"} />
            <SlotRow slot={agentSlot} lit={justLit === "agent"} />
            <SlotRow slot={browserSlot} lit={justLit === "browser"} />
          </ol>
        </aside>
      </div>

      <div className="tc-onboarding-foot">
        <div className="tc-onboarding-rule">
          <span style={{ width: `${((panel + 1) / (PANEL_COUNT + 1)) * 100}%` }} />
        </div>
        <span className="tc-onboarding-step">
          {ready ? t.onboarding_done : t.onboarding_progress(String(panel + 1), String(PANEL_COUNT))}
        </span>
        <div className="flex-1" />
        {panel > 0 && !ready && (
          <button
            type="button"
            onClick={() => {
              const next = (panel - 1) as Panel;
              if (next === 0) setSpaceName(null);
              if (next === 1) setAgent(null);
              if (next === 2) setWantsBrowser(false);
              setJustLit(null);
              setPanel(next);
            }}
          >
            {t.onboarding_back}
          </button>
        )}
        {!ready && (
          <button type="button" onClick={finish}>
            {t.onboarding_skip}
          </button>
        )}
      </div>
      </div>
    </div>
  );
}

function SlotRow({ slot, lit }: { slot: Slot; lit: boolean }) {
  return (
    <li className="tc-onboarding-slot" data-state={slot.state} data-lit={lit ? "" : undefined}>
      <span className="marks">
        {slot.icons.map((icon) => (
          <img key={icon} src={icon} alt="" />
        ))}
      </span>
      <span className="text">
        <span className="label">{slot.label}</span>
        {slot.hint && <span className="hint">{slot.hint}</span>}
      </span>
    </li>
  );
}

function Choice({
  icon,
  title,
  detail,
  onClick,
  primary = false,
  plus = false,
  disabled = false,
}: {
  icon: string;
  title: string;
  detail: string;
  onClick: () => void;
  primary?: boolean;
  plus?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="tc-onboarding-choice"
      data-primary={primary ? "" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="mark">
        <img src={icon} alt="" />
        {plus && (
          <span className="plus">
            {/* Drawn, not typed: a "+" glyph at this size lands wherever the
                font's metrics put it, which reads as a misaligned badge. */}
            <svg viewBox="0 0 8 8" aria-hidden="true">
              <rect x="3.25" y="0.5" width="1.5" height="7" rx="0.75" />
              <rect x="0.5" y="3.25" width="7" height="1.5" rx="0.75" />
            </svg>
          </span>
        )}
      </span>
      <span className="txt">
        <span className="t">{title}</span>
        <span className="d">{detail}</span>
      </span>
    </button>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="tc-onboarding-quiet" onClick={onClick}>
      {children}
    </button>
  );
}
