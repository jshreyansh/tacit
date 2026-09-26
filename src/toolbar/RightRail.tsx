import { useCallback, useRef, useState } from "react";
import {
  useCanvasStore,
  CHROME_INSET,
  RIGHT_RAIL_WIDTH,
} from "../stores/canvasStore";
import { fitAllProjects, stepZoomAtCenter } from "../canvas/zoomActions";
import { clampScale } from "../canvas/viewportZoom";
import {
  PILL_GLASS,
  useCloseOnOutsideClick,
  usePopoverKeyboardNav,
} from "./pillChrome";
import { useUpdaterStore } from "../stores/updaterStore";
import { UpdateModal } from "../components/UpdateModal";
import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";
import { addTerminal, addBrowser, addNote } from "../actions/dockActions";
import { useAgentDetection } from "../stores/agentAvailabilityStore";
import { useNotificationStore } from "../stores/notificationStore";
import type { TerminalType } from "../types";
import shellIcon from "../assets/dock-icons/terminal-shell.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";
import opencodeIcon from "../assets/dock-icons/opencode-mark.png";
import browserIcon from "../assets/dock-icons/browser.png";
import noteIcon from "../assets/dock-icons/note.png";
import { useT } from "../i18n/useT";

const platform = window.tacit?.app.platform ?? "darwin";
const isMac = platform === "darwin";

/**
 * The right rail — the code surfaces, the update indicator, and the Hub.
 *
 * Mirror of the left rail, on the edge these things actually open from. Files,
 * Diff, Git and Memory were tabs inside RightPanel plus a duplicate set in its
 * 32px collapsed strip; the rail absorbs both, the same way the left rail
 * absorbed LeftPanel's. The Hub was a button in the old top toolbar, which
 * pointed nowhere in particular — it slides in from this edge, so it belongs
 * on it.
 *
 * The update indicator sits directly above the Hub and renders only when there
 * is something to say. It cannot live in Settings: its whole job is to be
 * noticed without being looked for.
 */

const buttonCls =
  "tc-rail-btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center text-[var(--text-muted)] transition-[background-color,transform,color] duration-quick active:scale-[0.94] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] motion-reduce:transition-none";

const updateButtonClass = buttonCls;

const KEY_HINT = { fit: isMac ? "\u23180" : "Ctrl 0", zoom100: isMac ? "\u23181" : "Ctrl 1" };
const ZOOM_PRESETS = [
  { scale: 0.5, label: "50%" },
  { scale: 1, label: "100%", hint: KEY_HINT.zoom100 },
  { scale: 2, label: "200%" },
];

/** Corner brackets — the viewfinder metaphor, unchanged from the old pill. */
function FitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 15 15" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round">
      <path d="M1.5 5V2.5a1 1 0 0 1 1-1H5" />
      <path d="M10 1.5h2.5a1 1 0 0 1 1 1V5" />
      <path d="M13.5 10v2.5a1 1 0 0 1-1 1H10" />
      <path d="M5 13.5H2.5a1 1 0 0 1-1-1V10" />
    </svg>
  );
}

/**
 * Focus view: one node at a time, the rest set aside.
 *
 * The old glyph was a circle with a dot, sitting immediately beside the zoom
 * controls — where "reset" is exactly what you would guess it meant. This
 * draws the mode instead: one card at full strength between two dimmed ones.
 */
function FocusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round">
      <rect x="5.5" y="2.5" width="5" height="11" rx="1.4" />
      <path d="M2.6 5.4v5.2M13.4 5.4v5.2" opacity="0.42" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A dock mark, and whether it brings its own tile.
 *
 * These assets are not alike. Shell is drawn as a dark squircle and Note as a
 * card, so the artwork *is* the icon tile; OpenCode ships a white one baked
 * in. Claude, Codex, Gemini and Chrome are bare vendor logos on transparency,
 * which left them floating on the rail beside neighbours that had a solid
 * edge — a mix of tiles and loose glyphs rather than one set of icons.
 *
 * So the bare ones get a shell behind them and the tiled ones do not, which is
 * exactly what a macOS dock does: every icon occupies the same squircle, some
 * supplied by the app and some, here, by us.
 *
 * `inner` exists because the marks are cropped at different tightnesses —
 * Gemini's sparkle runs corner to corner where Codex's blob leaves a margin —
 * so one box size renders them at visibly different weights.
 */
interface RailArt {
  icon: string;
  /** Artwork already carries its own tile; render it without a shell. */
  tiled?: boolean;
  /** Size override — the footprint when tiled, the mark inside when shelled. */
  inner?: string;
}

interface RailEntry extends RailArt {
  id: TerminalType;
  label: string;
}

const AGENTS: readonly RailEntry[] = [
  { id: "shell", label: "Shell", icon: shellIcon, tiled: true },
  { id: "claude", label: "Claude", icon: claudeIcon, inner: "h-6 w-6" },
  { id: "codex", label: "Codex", icon: codexIcon, inner: "h-6 w-6" },
  // The sparkle runs corner to corner where the others leave a margin, so it
  // needs the only real correction in the set.
  { id: "gemini", label: "Gemini", icon: geminiIcon, inner: "h-[22px] w-[22px]" },
  // Ships as a dark mark baked onto a cream field, which made it the one
  // pale tile in a dark column. `opencode-mark.png` is that mark lifted off
  // its background with its tones flipped, so it sits on the same shell as
  // the rest — light glyph on a dark tile, exactly like Shell's own icon.
  { id: "opencode", label: "OpenCode", icon: opencodeIcon, inner: "h-[24px] w-[24px]" },
] as const;

/**
 * One agent in the dock. An agent whose CLI isn't installed stays visible
 * but dimmed, and a click says why instead of opening a terminal that fails
 * with "executable not found". It is aria-disabled rather than disabled so
 * the hover tooltip still shows the reason.
 */
function DockAgentButton({ entry }: { entry: RailEntry }) {
  const detection = useAgentDetection(entry.id);
  const missing = detection !== null && !detection.installed;
  const title = missing
    ? (detection.reason ?? `${entry.label} isn't installed`)
    : detection?.version
      ? `${entry.label} ${detection.version}`
      : entry.label;
  return (
    <button
      className={`${buttonCls}${missing ? " opacity-40" : ""}`}
      aria-disabled={missing || undefined}
      onClick={() => {
        if (missing) {
          useNotificationStore.getState().notify("warn", title);
          return;
        }
        addTerminal(entry.id);
      }}
      title={title}
      aria-label={title}
    >
      <RailIcon art={entry} />
    </button>
  );
}

const BROWSER_ART: RailArt = { icon: browserIcon, inner: "h-[23px] w-[23px]" };
const NOTE_ART: RailArt = { icon: noteIcon, tiled: true };

function RailIcon({ art }: { art: RailArt }) {
  if (art.tiled) {
    return (
      <img
        src={art.icon}
        alt=""
        className={`${art.inner ?? "h-[33px] w-[33px]"} object-contain`}
      />
    );
  }
  return (
    <span className="tc-icon-shell">
      <img
        src={art.icon}
        alt=""
        className={`${art.inner ?? "h-6 w-6"} object-contain`}
      />
    </span>
  );
}

const ICON_BUTTON_TRANSITION = {
  transition:
    "background-color var(--duration-quick) var(--ease-out-soft), color var(--duration-quick) var(--ease-out-soft), transform var(--duration-instant) var(--ease-out-soft)",
} as React.CSSProperties;

export function RightRail() {
  const t = useT();
  const updateStatus = useUpdaterStore((s) => s.status);
  const [showUpdate, setShowUpdate] = useState(false);

  const viewport = useCanvasStore((s) => s.viewport);
  const focusModeActive = useCanvasStore((s) => s.focusMode.active);
  const zoomPercent = `${Math.round(viewport.scale * 100)}%`;
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomWrapRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const zoomPopoverRef = useRef<HTMLDivElement>(null);
  const closeZoom = useCallback(() => setZoomOpen(false), []);
  useCloseOnOutsideClick(zoomOpen, zoomWrapRef, closeZoom);
  usePopoverKeyboardNav({
    open: zoomOpen,
    close: closeZoom,
    popoverRef: zoomPopoverRef,
    triggerRef: zoomTriggerRef,
    itemCount: ZOOM_PRESETS.length + 3,
  });
  const applyPreset = useCallback((scale: number) => {
    const state = useCanvasStore.getState();
    state.setViewport({ ...state.viewport, scale: clampScale(scale) });
  }, []);


  return (
    <>
      <div
        className="tc-float fixed z-50 flex flex-col items-center py-2"
        style={{
          right: CHROME_INSET,
          top: TITLE_STRIP_HEIGHT + CHROME_INSET,
          bottom: CHROME_INSET,
          width: RIGHT_RAIL_WIDTH,
        }}
      >
        {/* Update, and only when there is one. Nothing else belongs above
            the dock: this rail is what you add to the canvas, and an update
            notice is the one thing here that is not that. */}
        {updateStatus !== "idle" && (
          <div className="relative flex shrink-0 flex-col items-center gap-0.5 pb-2 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
            <UpdateStatusButton
              status={updateStatus}
              t={t}
              onClick={() => setShowUpdate(true)}
            />
          </div>
        )}

        {/* The creation dock is the only group that scrolls. Seven buttons do
            not fit a short window, and the ends — an update notice above, the
            view controls below — are exactly what must never be pushed out of
            reach, so they stay fixed and this takes what is left. */}
        <div className="tc-rail-scroll flex min-h-0 flex-col items-center gap-0.5 overflow-y-auto">
          {AGENTS.map((entry) => (
            <DockAgentButton key={entry.id} entry={entry} />
          ))}

          <div
            aria-hidden="true"
            className="my-1.5 h-px w-6 shrink-0 bg-[color-mix(in_srgb,var(--border)_70%,transparent)]"
          />

          <button
            className={buttonCls}
            onClick={addBrowser}
            title={t.dock_add_browser}
            aria-label={t.dock_add_browser}
          >
            <RailIcon art={BROWSER_ART} />
          </button>
          <button
            className={buttonCls}
            onClick={addNote}
            title={t.dock_add_note}
            aria-label={t.dock_add_note}
          >
            <RailIcon art={NOTE_ART} />
          </button>
        </div>

        {/* View: how you are looking at the canvas. The rail reads top to
            bottom as app, then inspect, then view — zoom, Fit and Focus are
            adjustments you make to what you are already looking at, so they
            belong at the end rather than in front of it. */}
        <div className="relative mt-auto flex shrink-0 flex-col items-center gap-0.5 pt-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--border)_70%,transparent)]">
          <div className="relative" ref={zoomWrapRef}>
            <button
              ref={zoomTriggerRef}
              className={`${buttonCls} text-[10px] font-medium tabular-nums`}
              style={{ fontFamily: '"Geist Mono", monospace' }}
              onClick={() => setZoomOpen((v) => !v)}
              title={t.canvas_zoom_to}
              aria-haspopup="menu"
              aria-expanded={zoomOpen}
              data-on={zoomOpen ? "" : undefined}
            >
              {zoomPercent}
            </button>
            {zoomOpen && (
              <div
                ref={zoomPopoverRef}
                role="menu"
                aria-label={t.canvas_zoom_to}
                // Rises from the trigger. The zoom control sits at the foot of
                // the rail now, so a menu anchored to its top ran off the
                // bottom of the window — the presets nearest the bottom were
                // the ones you could not reach.
                className={`absolute bottom-0 right-full mr-2 max-h-[min(22rem,60vh)] min-w-[170px] overflow-y-auto py-1.5 ${PILL_GLASS}`}
                style={{ borderRadius: 14, cornerShape: "squircle" } as React.CSSProperties}
              >
                {/* Step controls live here rather than as two more 40px targets
                    in the rail: they are the pair best covered by the keyboard
                    and by pinch, so they cost one click and save a permanent
                    slot on an edge that is already eleven buttons long. */}
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <button
                    data-popover-item
                    tabIndex={-1}
                    className="tc-rail-btn inline-flex h-7 w-7 items-center justify-center text-[15px] leading-none text-[var(--text-secondary)]"
                    onClick={() => stepZoomAtCenter("out")}
                    aria-label={t.zoom_out}
                  >
                    &minus;
                  </button>
                  <span
                    className="text-[12px] tabular-nums text-[var(--text-primary)]"
                    style={{ fontFamily: '"Geist Mono", monospace' }}
                  >
                    {zoomPercent}
                  </span>
                  <button
                    data-popover-item
                    tabIndex={-1}
                    className="tc-rail-btn inline-flex h-7 w-7 items-center justify-center text-[15px] leading-none text-[var(--text-secondary)]"
                    onClick={() => stepZoomAtCenter("in")}
                    aria-label={t.zoom_in}
                  >
                    +
                  </button>
                </div>
                <div className="mx-2 mb-1 h-px bg-[var(--border)] opacity-60" />
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.scale}
                    data-popover-item
                    role="menuitem"
                    tabIndex={-1}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:outline-none"
                    onClick={() => {
                      applyPreset(preset.scale);
                      setZoomOpen(false);
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">
                      {preset.hint ?? ""}
                    </span>
                  </button>
                ))}
                <div className="mx-2 my-1 h-px bg-[var(--border)] opacity-60" />
                <button
                  data-popover-item
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:outline-none"
                  onClick={() => {
                    useCanvasStore.getState().resetViewport();
                    setZoomOpen(false);
                  }}
                >
                  {t.reset}
                </button>
              </div>
            )}
          </div>

          <button
            className={buttonCls}
            onClick={fitAllProjects}
            title={`${t.fit} (${KEY_HINT.fit})`}
            aria-label={t.fit}
          >
            <FitIcon />
          </button>

          <button
            className={buttonCls}
            onClick={() => {
              const store = useCanvasStore.getState();
              if (store.focusMode.active) store.exitFocusMode();
              else store.enterFocusMode();
            }}
            title={focusModeActive ? t.exit_focus_view : t.focus_view}
            aria-label={focusModeActive ? t.exit_focus_view : t.focus_view}
            aria-pressed={focusModeActive}
            data-on={focusModeActive ? "" : undefined}
          >
            <FocusIcon />
          </button>
        </div>

      </div>
      {showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />}
    </>
  );
}

type UpdateStatus = ReturnType<typeof useUpdaterStore.getState>["status"];

function UpdateStatusButton({
  status,
  t,
  onClick,
}: {
  status: UpdateStatus;
  t: ReturnType<typeof useT>;
  onClick: () => void;
}) {
  const label =
    status === "downloading"
      ? t.update_downloading
      : status === "ready"
        ? t.update_ready
        : status === "error"
          ? t.update_error
          : t.update_checking;

  return (
    <button
      type="button"
      // Pop on every status transition so a state change reads as
      // an event, not a silent swap. Keyed on status to remount.
      key={status}
      className={`${updateButtonClass} tc-enter-pop relative motion-reduce:animate-none`}
      style={ICON_BUTTON_TRANSITION}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {status === "downloading" ? (
        <ArrowDownIcon className="motion-safe:animate-bounce" />
      ) : status === "ready" ? (
        <>
          <ArrowUpIcon />
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-[var(--green)] ring-2 ring-[var(--bg)]"
          />
        </>
      ) : status === "error" ? (
        <WarningIcon style={{ color: "var(--amber)" }} />
      ) : (
        <SpinnerIcon className="motion-safe:animate-spin" />
      )}
    </button>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M7 12V4M4 6.5L7 3.5 10 6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 2h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
    >
      <path
        d="M7 2v8M4 7.5L7 10.5 10 7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarningIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={style}>
      <path
        d="M7 2L1.5 12h11L7 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M7 6v3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
    >
      <path
        d="M7 1.5A5.5 5.5 0 1 1 1.5 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

