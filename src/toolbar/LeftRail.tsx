import {
  useCanvasStore,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
} from "../stores/canvasStore";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";
import { useSettingsModalStore } from "../stores/settingsModalStore";
import { useHubStore } from "../stores/hubStore";
import { LEFT_TAB_CONFIG } from "../components/leftPanelTabs";
import { RIGHT_TAB_CONFIG } from "../components/rightPanelTabs";
import { formatShortcut, useShortcutStore } from "../stores/shortcutStore";
import { useT } from "../i18n/useT";
import tacitMark from "../assets/tacit-mark.png";

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

export function LeftRail() {
  const t = useT();
  const sessionsCollapsed = useCanvasStore((s) => s.leftPanelCollapsed);
  const setSessionsCollapsed = useCanvasStore((s) => s.setLeftPanelCollapsed);
  const sessionsTab = useCanvasStore((s) => s.leftPanelActiveTab);
  const setSessionsTab = useCanvasStore((s) => s.setLeftPanelActiveTab);

  const codeCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const setCodeCollapsed = useCanvasStore((s) => s.setRightPanelCollapsed);
  const codeTab = useCanvasStore((s) => s.rightPanelActiveTab);
  const setCodeTab = useCanvasStore((s) => s.setRightPanelActiveTab);

  const openSettings = useSettingsModalStore((s) => s.openSettings);
  const hubOpen = useHubStore((s) => s.open);
  const toggleHub = useHubStore((s) => s.toggleHub);
  const hubShortcut = useShortcutStore((s) => s.shortcuts.toggleHub);
  const hubLabel = t["hub.toolbarLabel"](formatShortcut(hubShortcut, isMac));

  return (
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
            if (!hubOpen) {
              setSessionsCollapsed(true);
              setCodeCollapsed(true);
            }
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
        {LEFT_TAB_CONFIG.map(({ id, icon: Icon, labelKey }) => {
          const open = !sessionsCollapsed && sessionsTab === id;
          return (
            <button
              key={id}
              className={`${buttonCls} text-[var(--text-muted)]`}
              data-on={open ? "" : undefined}
              title={t[labelKey]}
              aria-label={t[labelKey]}
              aria-pressed={open}
              onClick={() => {
                // Pressing the lit one closes the panel; pressing any other
                // switches to it without closing. Opening this panel closes
                // the code panel — they share an edge (see canvasStore).
                if (open) {
                  setSessionsCollapsed(true);
                  return;
                }
                setSessionsTab(id);
                setSessionsCollapsed(false);
              }}
            >
              <Icon size={17} />
            </button>
          );
        })}

        <div
          aria-hidden="true"
          className="my-1.5 h-px w-6 shrink-0 bg-[color-mix(in_srgb,var(--border)_70%,transparent)]"
        />

        {RIGHT_TAB_CONFIG.map(({ id, icon: Icon, labelKey }) => {
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
      </div>

      {/* Settings, alone at the far end. It is the one control here that opens
          nothing on the canvas and belongs to no panel, so it keeps the corner
          furthest from everything you reach for while working. */}
      <div className="relative mt-auto flex shrink-0 flex-col items-center gap-0.5 pt-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
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
  );
}
