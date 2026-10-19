import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/useT";
import { addBrowser, addNote, addTerminal } from "../actions/dockActions";
import { DOCK_ENTRIES, DockIcon, useDockAvailability, type DockEntry } from "../toolbar/dockEntries";
import { useIdentityStore } from "../stores/identityStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { createTask } from "../tasks/taskActions";
import type { OpenNode } from "../stores/workdeskViewStore";
import type { TerminalType } from "../types";
import { AGENT_ICON } from "../toolbar/agentIcons";

/**
 * The + at the start of the workdesk view's tabs: add an agent (which one),
 * a terminal, a browser (in which profile), a task or a note. What's added
 * opens in its tab.
 */

type Step = "root" | "agents" | "browsers";

function Row({ onClick, children, disabled, title, more }: { onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string; more?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="tc-rail-btn flex h-9 w-full items-center gap-2.5 px-2.5 text-left text-[12.5px] text-[var(--text-primary)] disabled:opacity-45"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
      {more && (
        <svg className="ml-auto text-[var(--text-faint)]" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3l5 5-5 5" />
        </svg>
      )}
    </button>
  );
}

/**
 * The Agents row's icon: OpenCode, Codex and Claude Code as tiles stacked
 * from one side, each partly in view, so it reads as a choice of agents
 * rather than one of them.
 */
function AgentsStackIcon() {
  const tile = 16;
  const step = 7;
  return (
    <span className="relative block shrink-0" style={{ width: tile + step * 2, height: tile }} aria-hidden="true">
      {[AGENT_ICON.opencode, AGENT_ICON.codex, AGENT_ICON.claude].map((icon, i) => (
        <span key={icon} className="tc-icon-shell absolute top-0" style={{ left: i * step, width: tile, height: tile }}>
          <img src={icon} alt="" className="h-3 w-3 object-contain" draggable={false} />
        </span>
      ))}
    </span>
  );
}

function AgentRow({ entry, onPick }: { entry: DockEntry; onPick: (type: TerminalType) => void }) {
  const t = useT();
  const { missing, title } = useDockAvailability(entry);
  return (
    <Row onClick={() => onPick(entry.terminalType!)} disabled={missing} title={missing ? (title ?? undefined) : undefined}>
      <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
        <DockIcon art={entry.art} scale={0.75} />
      </span>
      <span className="truncate">{entry.label(t)}</span>
      {missing && <span className="ml-auto text-[11px] text-[var(--text-faint)]">{t.workdesk_add_not_installed}</span>}
    </Row>
  );
}

export function AddNodeMenu({ onAdded }: { onAdded: (node: OpenNode) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("root");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const identities = useIdentityStore((s) => s.identities);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const done = (node: OpenNode | null) => {
    setOpen(false);
    if (node) onAdded(node);
    else useNotificationStore.getState().notify("warn", t.workdesk_add_no_project);
  };
  const terminal = (type: TerminalType) => {
    const id = addTerminal(type);
    done(id ? { kind: "terminal", id } : null);
  };
  const shell = DOCK_ENTRIES.find((e) => e.id === "shell")!;
  const browser = DOCK_ENTRIES.find((e) => e.id === "browser")!;
  const task = DOCK_ENTRIES.find((e) => e.id === "task")!;
  const note = DOCK_ENTRIES.find((e) => e.id === "note")!;
  const agents = DOCK_ENTRIES.filter((e) => e.group === "agents");
  const profiles = Object.values(identities);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        className="tc-rail-btn flex h-[30px] w-[30px] items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.workdesk_add}
        title={t.workdesk_add}
        onClick={() => {
          setStep("root");
          setOpen((v) => !v);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {/* On the page itself: inside the view's blurred panel a fixed menu
          would be placed against the panel, not the window. */}
      {open && createPortal(
        <div ref={menuRef} role="menu" aria-label={t.workdesk_add} className="tc-float pointer-events-auto fixed z-[1000] w-[240px] p-1.5" style={{ borderRadius: 11, ...menuPosition(ref.current) }}>
          {step !== "root" && (
            <button
              type="button"
              className="tc-rail-btn mb-1 flex h-7 w-full items-center gap-1.5 px-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-faint)] hover:text-[var(--text-primary)]"
              onClick={() => setStep("root")}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 3L5 8l5 5" />
              </svg>
              {step === "agents" ? t.workdesk_add_agent : t.workdesk_add_browser_profile}
            </button>
          )}
          {step === "root" && (
            <>
              <Row onClick={() => setStep("agents")} more>
                <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
                  <AgentsStackIcon />
                </span>
                {t.workdesk_add_agent}
              </Row>
              <Row onClick={() => terminal("shell")}>
                <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
                  <DockIcon art={shell.art} scale={0.7} />
                </span>
                {t.dock_terminal}
              </Row>
              <Row
                onClick={() => (profiles.length > 1 ? setStep("browsers") : done({ kind: "browser", id: addBrowser(profiles[0]?.id) }))}
                more={profiles.length > 1}
              >
                <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
                  <DockIcon art={browser.art} scale={0.75} />
                </span>
                {t.dock_browser}
              </Row>
              <Row
                onClick={() => {
                  const { focusedProjectId, projects } = useProjectStore.getState();
                  const project = projects.find((p) => p.id === focusedProjectId) ?? projects[0];
                  if (!project) return done(null);
                  setOpen(false);
                  void createTask(project.path).then((made) => made && onAdded({ kind: "task", id: made.id }));
                }}
              >
                <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
                  <DockIcon art={task.art} scale={0.7} />
                </span>
                {t.dock_task}
              </Row>
              <Row
                onClick={() => {
                  setOpen(false);
                  void addNote().then((id) => done(id ? { kind: "note", id } : null));
                }}
              >
                <span className="flex h-6 w-[30px] shrink-0 items-center justify-center">
                  <DockIcon art={note.art} scale={0.7} />
                </span>
                {t.dock_note}
              </Row>
            </>
          )}
          {step === "agents" && agents.map((entry) => <AgentRow key={entry.id} entry={entry} onPick={terminal} />)}
          {step === "browsers" &&
            profiles.map((profile) => (
              <Row key={profile.id} onClick={() => done({ kind: "browser", id: addBrowser(profile.id) })}>
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{ background: "var(--surface-hover)", color: "var(--text-primary)" }}
                  aria-hidden="true"
                >
                  {profile.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate">{profile.name}</span>
              </Row>
            ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Under the button, kept on screen; fixed, so the scrolling tab strip doesn't clip it. */
function menuPosition(anchor: HTMLElement | null): React.CSSProperties {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return {};
  return { top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)) };
}
