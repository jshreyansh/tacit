import { useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { addBrowser, addNote, addTask, addTerminal } from "../actions/dockActions";
import { NewAgentTiles, PickerHeading, PickerPopover } from "../agents/AgentPicker";
import { DockIcon, dockEntry } from "../toolbar/dockEntries";
import { useIdentityStore } from "../stores/identityStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import type { OpenNode } from "../stores/workdeskViewStore";
import type { TerminalType } from "../types";

/**
 * The + at the start of the workdesk view's tabs: add an agent (which one),
 * a terminal, a browser (in which profile), a task or a note. What's added
 * opens in its tab.
 */

type Step = "root" | "browsers";

function Row({ onClick, children, more }: { onClick: () => void; children: React.ReactNode; more?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-pick=""
      className="tc-ap-row"
      onClick={onClick}
    >
      {children}
      {more && (
        <svg className="ml-auto text-[var(--text-muted)]" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3l5 5-5 5" />
        </svg>
      )}
    </button>
  );
}

export function AddNodeMenu({ onAdded }: { onAdded: (node: OpenNode) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("root");
  const ref = useRef<HTMLDivElement>(null);
  const identities = useIdentityStore((s) => s.identities);
  const done = (node: OpenNode | null) => {
    setOpen(false);
    if (node) onAdded(node);
    else useNotificationStore.getState().notify("warn", t.workdesk_add_no_project);
  };
  const terminal = (type: TerminalType) => {
    const id = addTerminal(type);
    done(id ? { kind: "terminal", id } : null);
  };
  const shell = dockEntry("shell");
  const browser = dockEntry("browser");
  const task = dockEntry("task");
  const note = dockEntry("note");
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
      {open && ref.current && (
        <PickerPopover
          anchor={ref.current}
          role="menu"
          label={t.workdesk_add}
          width={336}
          onClose={() => setOpen(false)}
          onEscape={() => {
            if (step !== "root") setStep("root");
            return step !== "root";
          }}
        >
          {step !== "root" && (
            <button
              type="button"
              className="tc-eyebrow tc-rail-btn mb-1 flex h-7 w-full items-center gap-1.5 px-2 hover:text-[var(--text-primary)]"
              onClick={() => setStep("root")}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 3L5 8l5 5" />
              </svg>
              {t.workdesk_add_browser_profile}
            </button>
          )}
          {step === "root" && (
            <>
              <PickerHeading>{t.workdesk_add_agent}</PickerHeading>
              <NewAgentTiles role="menuitem" actionLabel={t.nav_new_chat_with} onPick={(entry) => entry.terminalType && terminal(entry.terminalType)} />
              <div className="tc-ap-rule" />
              <Row onClick={() => terminal("shell")}>
                <span className="tc-ap-mark">
                  <DockIcon art={shell.art} scale={0.7} />
                </span>
                {t.dock_terminal}
              </Row>
              <Row
                onClick={() => (profiles.length > 1 ? setStep("browsers") : done({ kind: "browser", id: addBrowser(profiles[0]?.id) }))}
                more={profiles.length > 1}
              >
                <span className="tc-ap-mark">
                  <DockIcon art={browser.art} scale={0.75} />
                </span>
                {t.dock_browser}
              </Row>
              <Row
                onClick={() => {
                  setOpen(false);
                  addTask();
                }}
              >
                <span className="tc-ap-mark">
                  <DockIcon art={task.art} scale={0.7} />
                </span>
                {t.dock_task}
              </Row>
              <Row
                onClick={() => {
                  setOpen(false);
                  done({ kind: "note", id: addNote() });
                }}
              >
                <span className="tc-ap-mark">
                  <DockIcon art={note.art} scale={0.7} />
                </span>
                {t.dock_note}
              </Row>
            </>
          )}
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
        </PickerPopover>
      )}
    </div>
  );
}
