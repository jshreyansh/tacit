import {
  useCanvasStore,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
  type RightPanelTab,
} from "../stores/canvasStore";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";
import { useSettingsModalStore } from "../stores/settingsModalStore";
import { useHubStore } from "../stores/hubStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useNeedsYouCount } from "./LiveSessions";
import { IconCode, isCodeTab, RIGHT_TAB_CONFIG } from "../components/rightPanelTabs";
import { formatShortcut, useShortcutStore } from "../stores/shortcutStore";
import { useT } from "../i18n/useT";
import tacitMark from "../assets/tacit-mark.png";
import { useRef, useState } from "react";
import { useDockStore } from "../stores/dockStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { UpdateModal } from "../components/UpdateModal";
import { UpdateStatusButton } from "./UpdateStatusButton";
import { AllNodesIcon } from "./NodeTray";
import { DockIcon, createFromDock, dockEntry, useDockAvailability, type DockEntry } from "./dockEntries";

/**
 * The left rail — everywhere you can look, plus Settings.
 *
 * Both edges used to mix verbs. The left rail held the two panel surfaces and
 * then every "add this to the canvas" button; the right rail held the Hub and
 * the four code surfaces, whose panel opened on that side. So "open Git" and
 * "start a Claude terminal" sat on opposite edges from their own siblings, and
 * the two panels could cover both margins at once.
 *
 * They are split by verb now. Everything that opens a view of work you already
 * have lives here — the Hub, Sessions, History, Files, Diff, Git, Memory — and
 * everything that creates something lives on the right rail. One panel opens
 * beside this rail, never two, because the surfaces that fill it are all
 * reached from the same column.
 */

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

const buttonCls =
  "tc-rail-btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center transition-[background-color,transform] duration-quick active:scale-[0.94] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] motion-reduce:transition-none";

/**
 * The app's own mark, for the one button that opens the whole app.
 *
 * It used to be three stacked bars — a generic "activity feed" glyph that sat
 * one slot above Sessions, whose mark is also a bordered rectangle with lines
 * in it. At 17px the two were very hard to tell apart.
 *
 * Drawn as a mask filled with `currentColor` rather than as an <img>, so it
 * behaves like the stroke glyphs beneath it: muted at rest, lifting on hover
 * and again when the Hub is open, all from `.tc-rail-btn`'s colour rules. The
 * full app icon — the mark on its own white tile — was the obvious thing to
 * use and the wrong one: a filled tile outweighed every line glyph in the
 * column and lit up like a button that was always on.
 */
function HubIcon() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[18px] w-[18px]"
      style={{
        backgroundColor: "currentColor",
        maskImage: `url(${tacitMark})`,
        WebkitMaskImage: `url(${tacitMark})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

/**
 * One pinned node in the dock. An agent whose CLI isn't installed stays
 * visible but dimmed, and a click says why. It is aria-disabled rather than
 * disabled so the hover tooltip still shows the reason.
 */
function DockRailButton({ entry }: { entry: DockEntry }) {
  const t = useT();
  const { missing, title } = useDockAvailability(entry);
  const label = title ? `${entry.label(t)} ${missing ? "" : title}`.trim() : entry.label(t);
  return (
    <button
      className={`${buttonCls}${missing ? " opacity-40" : ""}`}
      aria-disabled={missing || undefined}
      onClick={() => createFromDock(entry, title, missing)}
      title={missing ? (title ?? label) : t.dock_add(label)}
      aria-label={missing ? (title ?? label) : t.dock_add(label)}
    >
      <DockIcon art={entry.art} />
    </button>
  );
}

export function LeftRail() {
  const t = useT();
  const chatOpen = useChatDockStore((s) => s.open);
  const toggleChat = useChatDockStore((s) => s.toggle);
  const chatShortcut = useShortcutStore((s) => s.shortcuts.toggleManagerChat);
  const chatLabel = t.rail_chat(formatShortcut(chatShortcut, isMac));
  const needsYou = useNeedsYouCount();

  const codeCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const setCodeCollapsed = useCanvasStore((s) => s.setRightPanelCollapsed);
  const codeTab = useCanvasStore((s) => s.rightPanelActiveTab);
  const setCodeTab = useCanvasStore((s) => s.setRightPanelActiveTab);
  const codeOpen = !codeCollapsed && isCodeTab(codeTab);
  const lastCodeTab = useRef<RightPanelTab>(isCodeTab(codeTab) ? codeTab : "files");
  if (isCodeTab(codeTab)) lastCodeTab.current = codeTab;

  const openSettings = useSettingsModalStore((s) => s.openSettings);
  const hubOpen = useHubStore((s) => s.open);
  const toggleHub = useHubStore((s) => s.toggleHub);
  const hubShortcut = useShortcutStore((s) => s.shortcuts.toggleHub);
  const hubLabel = t["hub.toolbarLabel"](formatShortcut(hubShortcut, isMac));
  const pinned = useDockStore((s) => s.pinned);
  const trayOpen = useDockStore((s) => s.trayOpen);
  const toggleTray = useDockStore((s) => s.toggleTray);
  const updateStatus = useUpdaterStore((s) => s.status);
  const [showUpdate, setShowUpdate] = useState(false);

  return (
    <>
    <div
      // Floats over the canvas rather than being welded to the window edge.
      // A welded rail cannot start below the title strip without leaving a
      // corner nothing paints — which on a transparent window is the desktop.
      className="tc-float fixed z-50 flex flex-col items-center py-2"
      style={{
        left: CHROME_INSET,
        top: TITLE_STRIP_HEIGHT + CHROME_INSET,
        bottom: CHROME_INSET,
        width: LEFT_RAIL_WIDTH,
      }}
    >
      {/* The Hub takes the top: it is the one button here that opens the whole
          app rather than one surface of it, and the one you reach for without
          first looking at the canvas. */}
      <div className="relative flex shrink-0 flex-col items-center gap-0.5 pb-2 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          // The Hub's outside-click handler exempts this attribute so a click
          // on its own trigger toggles instead of closing-then-reopening.
          data-hub-trigger="true"
          data-on={hubOpen ? "" : undefined}
          onClick={() => {
            // The other half of the exclusivity canvasStore enforces: opening
            // a panel closes the Hub, so opening the Hub closes the panels.
            // Without this the Hub simply paints over whichever was open.
            if (!hubOpen) setCodeCollapsed(true);
            toggleHub();
          }}
          title={hubLabel}
          aria-label={hubLabel}
          aria-pressed={hubOpen}
        >
          <HubIcon />
        </button>
      </div>

      {/* The six panel surfaces, in one scrolling column because they all open
          the same panel and only one can win it. Sessions and History are
          where you have been; Files, Diff, Git and Memory are what the work
          produced — a divider between them and no further explanation. */}
      <div className="tc-rail-scroll flex min-h-0 flex-col items-center gap-0.5 overflow-y-auto">
        {/* The workdesk manager's chat. Sessions and History moved into it
            (its Sessions view), along with Pins. */}
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          data-on={chatOpen ? "" : undefined}
          title={chatLabel}
          aria-label={chatLabel}
          aria-pressed={chatOpen}
          onClick={toggleChat}
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
          </svg>
          {needsYou > 0 && !chatOpen && (
            <span aria-hidden="true" className="absolute right-[9px] top-[9px] h-[6px] w-[6px] rounded-full bg-[var(--amber)]" />
          )}
        </button>

        <div
          aria-hidden="true"
          className="my-1.5 h-px w-6 shrink-0 bg-[color-mix(in_srgb,var(--border)_70%,transparent)]"
        />

        {/* Files, Diff and Git are one button; the panel's tabs switch
            between them, and it opens on the one you were last on. */}
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          data-on={codeOpen ? "" : undefined}
          title={t.left_panel_code}
          aria-label={t.left_panel_code}
          aria-pressed={codeOpen}
          onClick={() => {
            if (codeOpen) {
              setCodeCollapsed(true);
              return;
            }
            setCodeTab(lastCodeTab.current);
            setCodeCollapsed(false);
          }}
        >
          <IconCode size={18} />
        </button>
        {RIGHT_TAB_CONFIG.filter(({ id }) => !isCodeTab(id)).map(({ id, icon: Icon, labelKey }) => {
          const open = !codeCollapsed && codeTab === id;
          return (
            <button
              key={id}
              className={`${buttonCls} text-[var(--text-muted)]`}
              data-on={open ? "" : undefined}
              title={t[labelKey]}
              aria-label={t[labelKey]}
              aria-pressed={open}
              onClick={() => {
                if (open) {
                  setCodeCollapsed(true);
                  return;
                }
                setCodeTab(id);
                setCodeCollapsed(false);
              }}
            >
              <Icon size={17} />
            </button>
          );
        })}

        {/* The dock: what you add to the canvas. Only pinned nodes sit here;
            the All Nodes tray holds every kind and is where you pin. */}
        <div
          aria-hidden="true"
          className="my-1.5 h-px w-6 shrink-0 bg-[color-mix(in_srgb,var(--border)_70%,transparent)]"
        />
        {pinned.map((id) => (
          <DockRailButton key={id} entry={dockEntry(id)} />
        ))}
        <button
          className={buttonCls}
          data-on={trayOpen ? "" : undefined}
          onClick={toggleTray}
          title={t.dock_all_nodes}
          aria-label={t.dock_all_nodes}
          aria-pressed={trayOpen}
          aria-haspopup="dialog"
        >
          <AllNodesIcon size={30} />
        </button>
      </div>

      {/* Settings, alone at the far end. It is the one control here that opens
          nothing on the canvas and belongs to no panel, so it keeps the corner
          furthest from everything you reach for while working. */}
      <div className="relative mt-auto flex shrink-0 flex-col items-center gap-0.5 pt-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
        {/* Update, and only when there is one. */}
        {updateStatus !== "idle" && (
          <UpdateStatusButton status={updateStatus} t={t} onClick={() => setShowUpdate(true)} />
        )}
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          onClick={() => openSettings()}
          title={t.rail_settings}
          aria-label={t.rail_settings}
        >
          <svg
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3.1" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.8 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.1a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </div>
    {/* Outside the rail: its backdrop blur would trap a fixed modal inside it. */}
    {showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />}
    </>
  );
}
