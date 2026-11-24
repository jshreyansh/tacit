import { SidebarGlyph } from "./ChatList";
import { CHROME_INSET, LEFT_RAIL_WIDTH } from "../stores/canvasStore";
import { TITLE_STRIP_CSS } from "./titleStripHeight";
import { useSettingsModalStore } from "../stores/settingsModalStore";
import { useHubStore } from "../stores/hubStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { useNeedsYouCount } from "./LiveSessions";
import { useNeedsYouOnOtherWorkdesks } from "../tasks/taskStore";
import { IconChat } from "../components/rightPanelTabs";
import { ViewControls } from "./ViewControls";
import { formatShortcut, useShortcutStore } from "../stores/shortcutStore";
import { useT } from "../i18n/useT";
import tacitMark from "../assets/tacit-mark.png";
import { useState } from "react";
import { useDockStore } from "../stores/dockStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { UpdateModal } from "../components/UpdateModal";
import { UpdateStatusButton } from "./UpdateStatusButton";
import { AllNodesIcon } from "./NodeTray";
import { DockIcon, createFromDock, dockEntry, startWorker, useDockAvailability, workerFolders, type DockEntry, type WorkerFolder } from "./dockEntries";
import { ContextMenu } from "../components/ContextMenu";

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
 * have lives here — the Hub, the chat, Sessions, Files, Diff, Git, Memory — and
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
  const isAgent = entry.group === "agents";
  // With more than one folder, an agent asks where to start as a worker.
  const [picker, setPicker] = useState<{ x: number; y: number; folders: WorkerFolder[] } | null>(null);
  const hint = missing ? (title ?? label) : isAgent ? t.dock_start_worker(entry.label(t)) : t.dock_add(label);
  return (
    <>
      <button
        className={`${buttonCls}${missing ? " opacity-40" : ""}`}
        aria-disabled={missing || undefined}
        aria-haspopup={isAgent ? "menu" : undefined}
        onClick={(e) => {
          const folders = isAgent && !missing ? workerFolders() : [];
          if (folders.length > 1) {
            const rect = e.currentTarget.getBoundingClientRect();
            setPicker({ x: rect.right + 8, y: rect.top, folders });
            return;
          }
          createFromDock(entry, title, missing);
        }}
        title={hint}
        aria-label={hint}
      >
        <DockIcon art={entry.art} />
      </button>
      {picker && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
          items={[
            { type: "label", label: t.worker_pick_folder(entry.label(t)) },
            ...picker.folders.map((folder) => ({ label: folder.label, onClick: () => startWorker(entry, folder) })),
          ]}
        />
      )}
    </>
  );
}

export function LeftRail() {
  const t = useT();
  const chatOpen = useChatDockStore((s) => s.open);
  const chatFace = useChatDockStore((s) => s.face);
  const setChatOpen = useChatDockStore((s) => s.setOpen);
  const showChatFace = useChatDockStore((s) => s.showFace);
  // The navigator first, then the manager's chat, which carries the
  // "something needs you" dot.
  const conversationOpen = chatOpen;
  const navShown = useChatDockStore((s) => s.listShown || s.listOverlay);
  const fullScreen = useChatDockStore((s) => s.open && s.placement === "full");
  const chatShortcut = useShortcutStore((s) => s.shortcuts.toggleManagerChat);
  const chatLabel = t.rail_chat(formatShortcut(chatShortcut, isMac));
  const needsYou = useNeedsYouCount();
  const waitingElsewhere = Object.values(useNeedsYouOnOtherWorkdesks()).reduce((sum, n) => sum + n, 0);


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
      // Full screen is the manager's chat alone: the rail steps aside (a short
      // fade and a few pixels left) and comes back when the chat docks.
      aria-hidden={fullScreen || undefined}
      style={{
        left: CHROME_INSET,
        top: `calc(${TITLE_STRIP_CSS} + ${CHROME_INSET}px)`,
        bottom: CHROME_INSET,
        width: LEFT_RAIL_WIDTH,
        opacity: fullScreen ? 0 : 1,
        transform: fullScreen ? "translateX(-8px)" : "none",
        pointerEvents: fullScreen ? "none" : undefined,
        transition: fullScreen
          ? "opacity 150ms cubic-bezier(0.3, 0, 0.8, 0.15), transform 150ms cubic-bezier(0.3, 0, 0.8, 0.15)"
          : "opacity 240ms cubic-bezier(0.05, 0.7, 0.1, 1), transform 240ms cubic-bezier(0.05, 0.7, 0.1, 1)",
      }}
    >
      {/* What you open beside the rail: the navigator (with each folder's
          files, changes, history and memory), the manager's chat, then the
          Hub, the command centre over all of it. Always in view, however
          short the window. */}
      <div className="relative flex shrink-0 flex-col items-center gap-0.5 pb-2 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
        {/* The navigator: chats, folders and tasks. Folded into the rail on
            a narrow window, where this opens it over the rest. */}
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          data-nav-toggle=""
          data-on={navShown ? "" : undefined}
          title={t.rail_navigator}
          aria-label={t.rail_navigator}
          aria-pressed={navShown}
          onClick={() => useChatDockStore.getState().toggleList()}
        >
          <SidebarGlyph />
        </button>
        {/* The workdesk manager's chat. */}
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          data-on={conversationOpen ? "" : undefined}
          title={needsYou > 0 ? `${chatLabel} · ${t.chat_sessions_needs_you(needsYou)}` : chatLabel}
          aria-label={needsYou > 0 ? `${chatLabel} · ${t.chat_sessions_needs_you(needsYou)}` : chatLabel}
          aria-pressed={conversationOpen}
          onClick={() => {
            if (conversationOpen) setChatOpen(false);
            else showChatFace(chatFace);
          }}
        >
          <IconChat size={18} />
          {needsYou > 0 && !conversationOpen && (
            <span aria-hidden="true" className="absolute right-[9px] top-[9px] h-[6px] w-[6px] rounded-full bg-[var(--amber)]" />
          )}
        </button>
        <button
          className={`${buttonCls} text-[var(--text-muted)]`}
          // The Hub's outside-click handler exempts this attribute so a click
          // on its own trigger toggles instead of closing-then-reopening.
          data-hub-trigger="true"
          data-on={hubOpen ? "" : undefined}
          onClick={() => toggleHub()}
          title={waitingElsewhere > 0 ? `${hubLabel} · ${t["hub.needsYouElsewhere"](waitingElsewhere)}` : hubLabel}
          aria-label={waitingElsewhere > 0 ? `${hubLabel} · ${t["hub.needsYouElsewhere"](waitingElsewhere)}` : hubLabel}
          aria-pressed={hubOpen}
        >
          <HubIcon />
          {/* Another workdesk has a task waiting on you; the Hub says which. */}
          {waitingElsewhere > 0 && !hubOpen && (
            <span aria-hidden="true" className="absolute right-[9px] top-[9px] h-[6px] w-[6px] rounded-full bg-[var(--amber)]" />
          )}
        </button>

      </div>

      {/* The dock: what you add to the canvas, the only part that scrolls when
          the window is short. All Nodes leads; what you pin from it follows. */}
      <div className="tc-rail-scroll flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto py-2">
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
        {pinned.map((id) => (
          <DockRailButton key={id} entry={dockEntry(id)} />
        ))}
      </div>

      {/* The foot, always in view: how you look at the canvas (zoom, Fit,
          Focus, Canvas or Grid), then Settings in the corner. */}
      <div className="relative flex shrink-0 flex-col items-center gap-0.5 pt-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
        <ViewControls />
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
