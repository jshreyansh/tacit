import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentAvailabilityStore } from "../stores/agentAvailabilityStore";
import { addProjectFromDirectoryPath } from "../canvas/sceneCommands";
import { useProjectStore } from "../stores/projectStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { addTerminal } from "../actions/dockActions";
import { skipManager, startManager } from "../actions/managerSeat";
import { MANAGER_AGENTS } from "../toolbar/AssignMenu";
import { useT } from "../i18n/useT";
import { displayFolderPath } from "./RightPanel/panelProject";
import "../board/board.css";
import type { TerminalType } from "../types";
import folderIcon from "../assets/dock-icons/folder.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import antigravityIcon from "../assets/dock-icons/antigravity.png";
import opencodeIcon from "../assets/dock-icons/opencode.png";

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
 * You choose on the left; on the right is the workdesk you're about to open,
 * filling in as you do. It's the payoff shown early, so it's never an empty
 * summary: before the first folder it's the canvas itself.
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
  "claude" | "codex" | "antigravity" | "opencode"
>;

interface PickedFolder {
  id: string;
  name: string;
  path: string;
}

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
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const [picked, setPicked] = useState<AgentChoice[]>([]);
  const [manager, setManager] = useState<AgentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const closed = useRef(false);

  useBodyScrollLock(open);
  // Agents whose CLI isn't on this Mac can't be picked: opening one would
  // start a terminal that fails with "command not found".
  const availability = useAgentAvailabilityStore((s) => s.byId);

  const agents: readonly AgentEntry[] = [
    { id: "claude", name: "Claude", vendor: "Anthropic", icon: claudeIcon },
    { id: "codex", name: "Codex", vendor: "OpenAI", icon: codexIcon },
    { id: "antigravity", name: "Antigravity", vendor: "Google", icon: antigravityIcon },
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
    // Who runs it was asked here: the card that asks on a later workdesk doesn't follow.
    skipManager();
    if (picked.length === 0) return;
    window.setTimeout(() => {
      const project = useProjectStore.getState().projects.find((p) => p.id === target) ?? useProjectStore.getState().projects[0];
      const worktree = project?.worktrees[0];
      const where = project && worktree ? { projectId: project.id, worktreeId: worktree.id } : undefined;
      for (const agent of picked) if (agent !== manager) addTerminal(agent, where);
      // Last: its panel opens ready to type.
      if (manager && picked.includes(manager)) startManager(manager, where);
    }, 140);
  }, [picked, setDismissed, target, manager]);

  const addPaths = useCallback(
    async (dirPaths: readonly string[]) => {
      let lastAdded: string | null = null;
      for (const dirPath of dirPaths) {
        // Chosen twice: the one that's there.
        const there = useProjectStore.getState().projects.find((p) => p.path === dirPath);
        const project = there ?? (await addProjectFromDirectoryPath(dirPath, t));
        if (!project) continue;
        lastAdded = project.id;
        setFolders((current) =>
          current.some((folder) => folder.id === project.id)
            ? current
            : [...current, { id: project.id, name: project.name, path: project.path }],
        );
      }
      if (lastAdded) setJustAdded(lastAdded);
    },
    [t],
  );

  const addFolders = useCallback(
    async (mode: "create" | "open") => {
      const api = window.tacit?.project;
      if (!api) return;
      setBusy(true);
      try {
        // Backing out of the sheet leaves what's already here.
        const made = mode === "create" ? await api.createDirectory() : null;
        await addPaths(mode === "create" ? (made === null ? [] : [made]) : await api.selectDirectories());
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [addPaths, notify],
  );

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      // Read now: after the first await the drop's items are gone.
      const paths = [...event.dataTransfer.items].flatMap((item) => {
        const file = item.kind === "file" && item.webkitGetAsEntry()?.isDirectory ? item.getAsFile() : null;
        const path = file && window.tacit.fs.getFilePath(file);
        return path ? [path] : [];
      });
      if (paths.length === 0) {
        notify("info", t.onboarding_drop_folders_only);
        return;
      }
      setBusy(true);
      try {
        await addPaths(paths);
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [addPaths, notify, t],
  );

  // The newest folder is in sight however many there are.
  useEffect(() => {
    if (justAdded) listRef.current?.querySelector(`[data-just]`)?.scrollIntoView({ block: "nearest" });
  }, [justAdded, folders.length]);

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

  const home = window.tacit?.app.homePath ?? "";
  const into = folders.find((f) => f.id === target) ?? folders[0] ?? null;
  const runs = manager && picked.includes(manager) ? manager : null;
  const noneInstalled = agents.every((a) => availability[a.id]?.installed === false);

  return (
    <div
      className="tc-onboarding fixed inset-0 z-[300] grid place-items-center p-8"
      role="dialog"
      aria-modal="true"
      aria-label={step === 0 ? t.onboarding_folders_title : t.onboarding_agents_title}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (step === 0) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => (step === 0 ? void onDrop(e) : e.preventDefault())}
    >
      <div className="tc-onboarding-scrim" />
      <div className="tc-onboarding-card">
        <div className="tc-onboarding-split">
          <div className="tc-onboarding-stage">
            <h2 className="tc-onboarding-title">
              {step === 0 ? t.onboarding_folders_title : t.onboarding_agents_title}
            </h2>
            <p className="tc-onboarding-body">
              {step === 0 ? t.onboarding_folders_body : t.onboarding_agents_body}
            </p>

            {step === 0 && folders.length === 0 && (
              <div className="tc-onboarding-drop" data-over={over || undefined}>
                <img src={folderIcon} alt="" />
                <span className="t">{over ? t.onboarding_drop_now : t.onboarding_drop}</span>
                <span className="acts">
                  <button type="button" className="tc-onboarding-btn" data-primary="" disabled={busy} onClick={() => void addFolders("open")}>
                    {t.onboarding_folders_add}
                  </button>
                  <button type="button" className="tc-onboarding-btn" disabled={busy} onClick={() => void addFolders("create")}>
                    {t.onboarding_space_create}
                  </button>
                </span>
              </div>
            )}

            {step === 0 && folders.length > 0 && (
              <>
                <ul className="tc-onboarding-picked" ref={listRef} data-over={over || undefined}>
                  {folders.map((folder) => (
                    <li key={folder.id} className="tc-onboarding-row" data-just={justAdded === folder.id ? "" : undefined}>
                      <img src={folderIcon} alt="" />
                      <span className="info">
                        <span className="label">{folder.name}</span>
                        <span className="path" title={folder.path}>{displayFolderPath(folder.path, home)}</span>
                      </span>
                      <button type="button" className="drop" aria-label={t.onboarding_folder_remove(folder.name)} title={t.onboarding_folder_remove(folder.name)} onClick={() => dropFolder(folder.id)}>
                        <svg viewBox="0 0 10 10" aria-hidden="true">
                          <path d="M2 2l6 6M8 2L2 8" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="tc-onboarding-more">
                  <button type="button" className="tc-onboarding-btn" disabled={busy} title={t.onboarding_folders_add_desc} onClick={() => void addFolders("open")}>
                    <PlusIcon />
                    {t.onboarding_folders_add_more}
                  </button>
                  <button type="button" className="tc-onboarding-btn" disabled={busy} title={t.onboarding_space_create_desc} onClick={() => void addFolders("create")}>
                    {t.onboarding_space_create}
                  </button>
                  <span className="hint">{over ? t.onboarding_drop_now : t.canvas_empty_drag_hint}</span>
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="tc-onboarding-agents">
                  {agents.map((agent) => {
                    const on = picked.includes(agent.id);
                    const missing = availability[agent.id]?.installed === false;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className="tc-onboarding-agent"
                        aria-pressed={on}
                        disabled={missing}
                        title={missing ? availability[agent.id]?.reason ?? t.workdesk_add_not_installed : undefined}
                        onClick={() => setPicked((current) => (on ? current.filter((id) => id !== agent.id) : [...current, agent.id]))}
                      >
                        <img src={agent.icon} alt="" className={agent.opaque ? "tile" : undefined} />
                        <span className="info">
                          <span className="t">{agent.name}</span>
                          <span className="d">{missing ? t.workdesk_add_not_installed : agent.vendor}</span>
                        </span>
                        {!missing && (
                          <span className="check">
                            {/* Drawn, not typed: a tick glyph at this size lands
                                wherever the font's metrics put it. */}
                            <svg viewBox="0 0 12 12" aria-hidden="true">
                              <path d="M2.5 6.4 L4.8 8.7 L9.5 3.6" />
                            </svg>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {picked.length > 0 && (
                  <div className="tc-onboarding-into" role="radiogroup" aria-label={t.setup_who_title}>
                    <span className="lead" title={t.setup_who_body}>{t.onboarding_manager}</span>
                    <button type="button" role="radio" aria-checked={!runs} onClick={() => setManager(null)}>
                      {t.onboarding_manager_none}
                    </button>
                    {agents.filter((a) => picked.includes(a.id) && MANAGER_AGENTS.some((m) => m.id === a.id)).map((a) => (
                      <button key={a.id} type="button" role="radio" aria-checked={runs === a.id} title={t.setup_who_body} onClick={() => setManager(a.id)}>
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
                {noneInstalled && <p className="tc-onboarding-note">{t.onboarding_agents_none}</p>}
                {folders.length > 1 && picked.length > 0 && into && (
                  <div className="tc-onboarding-into" role="radiogroup" aria-label={t.onboarding_open_in}>
                    <span className="lead">{t.onboarding_open_in}</span>
                    {folders.map((f) => (
                      <button key={f.id} type="button" role="radio" aria-checked={f.id === into.id} onClick={() => setTarget(f.id)}>
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <WorkdeskPreview folders={folders} into={into?.id ?? null} agents={agents.filter((a) => picked.includes(a.id))} manager={runs} over={over && step === 0} />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const PREVIEW_MAX = 6;
const PREVIEW_COLORS = ["blue", "amber", "green", "violet", "clay", "pink"];

/** The workdesk you're about to open, small: your folders on the canvas, and the agents in the one they open in. */
function WorkdeskPreview({ folders, into, agents, manager, over }: { folders: readonly PickedFolder[]; into: string | null; agents: readonly AgentEntry[]; manager: AgentChoice | null; over: boolean }) {
  const t = useT();
  // All of them, or all but the last place, which says how many more.
  const shown = folders.length > PREVIEW_MAX ? folders.slice(0, PREVIEW_MAX - 1) : folders;
  const more = folders.length - shown.length;
  const cells = shown.length + (more ? 1 : 0);
  return (
    <div className="tc-onboarding-view" aria-hidden="true">
      <div className="tc-onboarding-desk" data-cells={Math.max(1, cells)}>
        {folders.length === 0 && <div className="ghost" data-over={over || undefined} />}
        {shown.map((f, i) => (
          <div key={f.id} className="place" style={{ "--c": `var(--board-${PREVIEW_COLORS[i % PREVIEW_COLORS.length]})` } as React.CSSProperties}>
            <span className="name">{f.name}</span>
            {f.id === into && agents.length > 0 && (
              <div className="agents" data-n={agents.length}>
                {agents.map((a) => (
                  <div key={a.id} className="term">
                    <span className="bar">
                      <img src={a.icon} alt="" className={a.opaque ? "tile" : undefined} />
                      <span>{a.name}</span>
                      {a.id === manager && <span className="runs">{t.onboarding_manager}</span>}
                    </span>
                    <span className="line" />
                    <span className="line short" />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {more > 0 && <div className="more">{t.onboarding_preview_more(more)}</div>}
      </div>
      <span className="cap">{folders.length === 0 ? t.onboarding_preview_empty : t.onboarding_preview(folders.length, agents.length)}</span>
    </div>
  );
}
