import { useCallback, useEffect, useRef, useState } from "react";
import { addProjectFromDirectoryPath } from "../canvas/sceneCommands";
import { useProjectStore } from "../stores/projectStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { addTerminal } from "../actions/dockActions";
import { useT } from "../i18n/useT";
import type { TerminalType } from "../types";
import folderIcon from "../assets/dock-icons/folder.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";
import opencodeIcon from "../assets/dock-icons/opencode-logo.png";

/**
 * First run, as a sequence you finish rather than a hint you ignore.
 *
 * Two questions, both plural.
 *
 * It used to ask three, all singular: one space, one agent, one browser. Someone
 * who finished it had one folder and one agent open — which is a worse terminal.
 * What Tacit does that a terminal cannot is run several agents at once where you
 * can see all of them, so both remaining steps ask for several, and the last
 * thing you press opens the canvas with everything on it. There is no summary
 * screen: the payoff is the view, not a list of what was configured.
 *
 * The singular framing was also a real bug. Choosing a folder, going Back, and
 * choosing again left two projects on the canvas and one in the summary, because
 * "choose" was written as though there could only be one. Adding is now all the
 * button does, and any row can be dropped again.
 *
 * The browser step is gone. Importing Chrome profiles is a real feature with a
 * dialog of its own, and putting it third meant first run ended inside someone
 * else's modal instead of on the canvas. Settings → Browser is where it lives.
 *
 * It is a dialog on a scrim, in the family Settings belongs to. Blocking is
 * about focus rather than about covering every pixel: a full-bleed version made
 * setup feel like an installer. Modal is right for the first sixty seconds and
 * wrong almost everywhere after, so `Skip setup` is visible throughout, Escape
 * works, and it never shows again.
 */

const STEP_COUNT = 2;

type Step = 0 | 1;
type AgentChoice = Extract<
  TerminalType,
  "claude" | "codex" | "gemini" | "opencode"
>;

interface AgentEntry {
  id: AgentChoice;
  name: string;
  /** The maker, not a sentence. In a tile a full description wraps to three
   *  lines and turns the grid into mush; the logo already says which agent this
   *  is, so the second line only has to disambiguate. */
  vendor: string;
  icon: string;
  /** OpenCode ships an opaque mark carrying its own ground, where the rest
   *  are transparent — it needs a radius so the edge does not read as an
   *  unstyled rectangle. */
  opaque?: boolean;
}

export function OnboardingModal() {
  const t = useT();
  const dismissed = usePreferencesStore((s) => s.onboardingDismissed);
  const setDismissed = usePreferencesStore((s) => s.setOnboardingDismissed);
  const notify = useNotificationStore((s) => s.notify);

  // Latched on mount. Step one adds projects, which would otherwise flip the
  // condition that opened this and tear the takeover down mid-sequence.
  const [open] = useState(
    () => !dismissed && useProjectStore.getState().projects.length === 0,
  );
  const [step, setStep] = useState<Step>(0);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [picked, setPicked] = useState<AgentChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const closed = useRef(false);

  useBodyScrollLock(open);

  const agents: readonly AgentEntry[] = [
    { id: "claude", name: "Claude", vendor: "Anthropic", icon: claudeIcon },
    { id: "codex", name: "Codex", vendor: "OpenAI", icon: codexIcon },
    { id: "gemini", name: "Gemini", vendor: "Google", icon: geminiIcon },
    {
      id: "opencode",
      name: "OpenCode",
      vendor: t.onboarding_agent_open_source,
      icon: opencodeIcon,
      opaque: true,
    },
  ];

  /**
   * Close, then act. The agents used to spawn in the same tick this unmounted,
   * which put a terminal's trust prompt underneath a dialog that was still on
   * screen. Nothing happens on the canvas until this is gone.
   */
  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDismissed(true);
    if (picked.length === 0) return;
    window.setTimeout(() => {
      for (const agent of picked) addTerminal(agent);
    }, 140);
  }, [picked, setDismissed]);

  const addFolders = useCallback(
    async (mode: "create" | "open") => {
      const api = window.tacit?.project;
      if (!api) return;
      setBusy(true);
      try {
        const dirPaths =
          mode === "create"
            ? [await api.createDirectory()].filter(
                (path): path is string => path !== null,
              )
            : await api.selectDirectories();
        // Backed out of the sheet; stay on this step with what is already here.
        if (dirPaths.length === 0) return;
        let lastAdded: string | null = null;
        for (const dirPath of dirPaths) {
          const project = await addProjectFromDirectoryPath(dirPath, t);
          if (!project) continue;
          lastAdded = project.id;
          setFolders((current) =>
            current.some((folder) => folder.id === project.id)
              ? current
              : [...current, { id: project.id, name: project.name }],
          );
        }
        setJustAdded(lastAdded);
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [notify, t],
  );

  // Dropping a row un-adds the project too. Leaving it registered was the old
  // bug in the other direction: a folder gone from the list but still on canvas.
  const dropFolder = useCallback((id: string) => {
    setFolders((current) => current.filter((folder) => folder.id !== id));
    useProjectStore.getState().removeProject(id);
  }, []);

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

  return (
    <div
      className="tc-onboarding fixed inset-0 z-[300] grid place-items-center p-8"
      role="dialog"
      aria-modal="true"
      aria-label={t.onboarding_folders_title}
    >
      <div className="tc-onboarding-scrim" />
      <div className="tc-onboarding-card">
        <div className="tc-onboarding-stage">
          <h2 className="tc-onboarding-title">
            {step === 0 ? t.onboarding_folders_title : t.onboarding_agents_title}
          </h2>
          <p className="tc-onboarding-body">
            {step === 0 ? t.onboarding_folders_body : t.onboarding_agents_body}
          </p>

          {step === 0 && (
            <>
              <div className="tc-onboarding-choices">
                <Choice
                  icon={folderIcon}
                  primary
                  title={
                    folders.length
                      ? t.onboarding_folders_add_more
                      : t.onboarding_folders_add
                  }
                  detail={t.onboarding_folders_add_desc}
                  disabled={busy}
                  onClick={() => void addFolders("open")}
                />
                <Choice
                  icon={folderIcon}
                  plus
                  title={t.onboarding_space_create}
                  detail={t.onboarding_space_create_desc}
                  disabled={busy}
                  onClick={() => void addFolders("create")}
                />
              </div>

              {/* Under the buttons that added them, and only once there is
                  something to show. A standing side panel spent a third of the
                  card saying "None yet" twice before you had done anything. */}
              {folders.length > 0 && (
                <ul className="tc-onboarding-picked">
                  {folders.map((folder) => (
                    <li
                      key={folder.id}
                      className="tc-onboarding-row"
                      data-just={justAdded === folder.id ? "" : undefined}
                    >
                      <img src={folderIcon} alt="" />
                      <span className="label">{folder.name}</span>
                      <button
                        type="button"
                        className="drop"
                        aria-label={t.onboarding_folder_remove(folder.name)}
                        onClick={() => dropFolder(folder.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 1 && (
            <div className="tc-onboarding-agents">
              {agents.map((agent) => {
                const on = picked.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className="tc-onboarding-agent"
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((current) =>
                        on
                          ? current.filter((id) => id !== agent.id)
                          : [...current, agent.id],
                      )
                    }
                  >
                    <img
                      src={agent.icon}
                      alt=""
                      className={agent.opaque ? "tile" : undefined}
                    />
                    <span className="info">
                      <span className="t">{agent.name}</span>
                      <span className="d">{agent.vendor}</span>
                    </span>
                    <span className="check">
                      {/* Drawn, not typed: a tick glyph at this size lands
                          wherever the font's metrics put it. */}
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.5 6.4 L4.8 8.7 L9.5 3.6" />
                      </svg>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="tc-onboarding-foot">
          <div className="tc-onboarding-rule">
            <span style={{ width: `${((step + 1) / STEP_COUNT) * 100}%` }} />
          </div>
          <span className="tc-onboarding-step">
            {t.onboarding_progress(String(step + 1), String(STEP_COUNT))}
          </span>
          <div className="flex-1" />
          {step > 0 && (
            <button type="button" onClick={() => setStep(0)}>
              {t.onboarding_back}
            </button>
          )}
          <button type="button" onClick={finish}>
            {t.onboarding_skip}
          </button>
          <button
            type="button"
            className="go"
            onClick={() => (step === 0 ? setStep(1) : finish())}
          >
            {step === 0 ? t.onboarding_next : t.onboarding_open}
          </button>
        </div>
      </div>
    </div>
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
