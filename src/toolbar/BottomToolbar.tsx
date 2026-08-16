import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasStore } from "../stores/canvasStore";
import { usePinStore } from "../stores/pinStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import {
  fitAllProjects,
  setZoomToHundred,
  stepZoomAtCenter,
} from "../canvas/zoomActions";
import {
  clampScale,
  getViewportCenterClientPoint,
  zoomAtClientPoint,
} from "../canvas/viewportZoom";
import { TOOLBAR_HEIGHT } from "./toolbarHeight";
import { useT } from "../i18n/useT";

// ComposerBar sits at `bottom-4` (16 px). Its height varies — single
// line vs multi-line vs with image attachments vs rename mode — so a
// hard-coded estimate gets the toolbar covered the moment composer
// content grows. ComposerBar publishes its measured height to
// `--composer-height` and we read it here, falling back to a safe
// default for the brief moment before measurement, and to a smaller
// constant when composer is disabled entirely.
const COMPOSER_GAP = 8;
const COMPOSER_BOTTOM_INSET = 16;
const COMPOSER_FALLBACK_HEIGHT = 120;
const BOTTOM_OFFSET_PLAIN = 20;

// Liquid-glass recipe: a low-opacity theme-aware tint (so the app's own
// palette shows through, not a generic gray) behind a heavy blur+saturate
// boost — saturate is what actually sells "glass" over a plain frosted
// panel, since it makes whatever's behind visibly richer, not just soft.
// The inset highlight is intentionally a fixed light rgba rather than a
// theme token: real glass/metal catches a light highlight along its top
// edge in both light and dark rooms, so this doesn't flip with the theme
// the way a color token would.
export const PILL_GLASS =
  "bg-[color-mix(in_srgb,var(--surface)_58%,transparent)] " +
  "[backdrop-filter:blur(28px)_saturate(1.7)] [-webkit-backdrop-filter:blur(28px)_saturate(1.7)] " +
  "border border-[color-mix(in_srgb,var(--border)_45%,transparent)] " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_0_0_1px_rgba(255,255,255,0.04)," +
  "0_12px_36px_-10px_color-mix(in_srgb,var(--shadow-color)_45%,transparent)," +
  "0_2px_8px_-2px_color-mix(in_srgb,var(--shadow-color)_30%,transparent)]";

const groupBase = "flex items-center";
export const dividerCls =
  "h-4 w-px bg-[color-mix(in_srgb,var(--border)_72%,transparent)] mx-0.5";
export const buttonBase =
  "inline-flex h-8 items-center justify-center rounded-md text-[12px] font-medium text-[var(--text-muted)] transition-[color,background-color,transform] duration-quick hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] active:scale-[0.97] focus-visible:outline-none motion-reduce:transition-none";
export const iconButton = `${buttonBase} w-8`;
const zoomReadout =
  "min-w-[3.25rem] h-8 inline-flex items-center justify-center text-[11px] text-[var(--text-muted)] tabular-nums rounded-md hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] transition-colors";

const platform = window.termcanvas?.app.platform ?? "darwin";
const isMac = platform === "darwin";

// One source of truth for the shortcut text shown in this toolbar's
// menus. Keep aligned with the bindings registered in
// useKeyboardShortcuts.ts (Cmd+0 fits, Cmd+1 = 100%, etc.).
const KEY_HINT = {
  fit: isMac ? "⌘0" : "Ctrl 0",
  zoom100: isMac ? "⌘1" : "Ctrl 1",
};

type ZoomPreset = {
  scale: number;
  label: string;
  hint?: string;
};

const ZOOM_PRESETS: ZoomPreset[] = [
  { scale: 0.5, label: "50%" },
  { scale: 1, label: "100%", hint: KEY_HINT.zoom100 },
  { scale: 2, label: "200%" },
];

export // Corner-bracket "fit to screen" glyph — the same viewfinder metaphor
// October's own zoom pill uses for its expand icon, in place of a text
// label.
function FitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <path d="M1.5 5V2.5a1 1 0 0 1 1-1H5" />
      <path d="M10 1.5h2.5a1 1 0 0 1 1 1V5" />
      <path d="M13.5 10v2.5a1 1 0 0 1-1 1H10" />
      <path d="M5 13.5H2.5a1 1 0 0 1-1-1V10" />
    </svg>
  );
}

// Target/crosshair glyph for Focus view — "bring one thing into focus" is
// a camera-focus metaphor, reads clearly at icon size unlike a text label.
function FocusIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="7.5" cy="7.5" r="5.25" />
      <circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function useCloseOnOutsideClick(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close();
        // Don't restore focus to the trigger on mouse outside-click.
        // Doing so would leave a toolbar button as e.target for the next
        // keydown, causing isActivationTarget to block Space-to-pan.
        // Keyboard close (Escape) is handled by usePopoverKeyboardNav
        // which does return focus to the trigger there.
      }
    };
    window.addEventListener("mousedown", handle, true);
    return () => window.removeEventListener("mousedown", handle, true);
  }, [open, ref, close]);
}

// Roving-focus keyboard nav for popover menus. Caller passes a ref to
// the popover container, the trigger button (so we can return focus
// when Esc closes the menu), and an item count for arrow-key wrap.
export function usePopoverKeyboardNav({
  open,
  popoverRef,
  triggerRef,
  itemCount,
  initialIndex = 0,
  close,
}: {
  open: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  itemCount: number;
  initialIndex?: number;
  close: () => void;
}): void {
  useEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    if (!popover) return;

    const items = () =>
      Array.from(popover.querySelectorAll<HTMLElement>("[data-popover-item]"));

    // Focus the requested item once mounted (rAF lets the popover
    // paint first, otherwise focus flashes briefly to the trigger).
    const raf = requestAnimationFrame(() => {
      const list = items();
      list[Math.min(initialIndex, Math.max(0, list.length - 1))]?.focus();
    });

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const list = items();
      if (list.length === 0) return;
      const current = list.findIndex((el) => el === document.activeElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const fallback = e.key === "ArrowDown" ? 0 : list.length - 1;
      const next =
        current < 0 ? fallback : (current + delta + list.length) % list.length;
      list[next].focus();
    };

    window.addEventListener("keydown", handler);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", handler);
    };
  }, [open, popoverRef, triggerRef, itemCount, initialIndex, close]);
}

/**
 * Shared by every floating bottom-center pill (this toolbar, AddNodeDock)
 * so they all sit consistently just above ComposerBar's measured height
 * (published as `--composer-height`) instead of each hard-coding its own
 * guess, or drifting out of sync if the composer's layout ever changes.
 */
export function useComposerBottomOffset(): string {
  const composerEnabled = usePreferencesStore((s) => s.composerEnabled);
  return composerEnabled
    ? `calc(${COMPOSER_BOTTOM_INSET}px + var(--composer-height, ${COMPOSER_FALLBACK_HEIGHT}px) + ${COMPOSER_GAP}px)`
    : `${BOTTOM_OFFSET_PLAIN}px`;
}

export function BottomToolbar() {
  const t = useT();
  const viewport = useCanvasStore((s) => s.viewport);
  const focusModeActive = useCanvasStore((s) => s.focusMode.active);

  const [presetOpen, setPresetOpen] = useState(false);
  const presetWrapperRef = useRef<HTMLDivElement>(null);
  const presetPopoverRef = useRef<HTMLDivElement>(null);
  const presetTriggerRef = useRef<HTMLButtonElement>(null);

  const closePresetMenu = useCallback(() => setPresetOpen(false), []);
  const togglePresetMenu = useCallback(
    () => setPresetOpen((prev) => !prev),
    [],
  );

  useCloseOnOutsideClick(presetOpen, presetWrapperRef, closePresetMenu);

  usePopoverKeyboardNav({
    open: presetOpen,
    popoverRef: presetPopoverRef,
    triggerRef: presetTriggerRef,
    // +1 for the Reset row appended after the presets.
    itemCount: ZOOM_PRESETS.length + 1,
    close: closePresetMenu,
  });

  const applyPreset = useCallback((nextScale: number) => {
    if (nextScale === 1) {
      setZoomToHundred();
      return;
    }
    const {
      leftPanelCollapsed,
      leftPanelWidth,
      rightPanelCollapsed,
      rightPanelWidth,
      viewport: current,
    } = useCanvasStore.getState();
    const taskDrawerOpen = usePinStore.getState().openProjectPath !== null;
    const center = getViewportCenterClientPoint({
      leftPanelCollapsed,
      leftPanelWidth,
      rightPanelCollapsed,
      rightPanelWidth,
      taskDrawerOpen,
      topInset: TOOLBAR_HEIGHT,
    });
    useCanvasStore.getState().setViewport(
      zoomAtClientPoint({
        clientX: center.x,
        clientY: center.y,
        leftPanelCollapsed,
        leftPanelWidth,
        taskDrawerOpen,
        nextScale: clampScale(nextScale),
        viewport: current,
      }),
    );
  }, []);

  const zoomPercent = Math.round(viewport.scale * 100);
  const bottomOffset = useComposerBottomOffset();

  return (
    <div
      className="fixed right-4 z-[95] pointer-events-none"
      style={{ bottom: bottomOffset }}
    >
      <div
        className={`pointer-events-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 ${PILL_GLASS}`}
      >
        <div className={groupBase}>
          <button
            className={iconButton}
            onClick={() => stepZoomAtCenter("out")}
            title={t.zoom_out}
            aria-label={t.zoom_out}
          >
            <span className="text-[14px] leading-none">−</span>
          </button>

          <div className="relative" ref={presetWrapperRef}>
            <button
              ref={presetTriggerRef}
              className={zoomReadout}
              onClick={togglePresetMenu}
              title={t.canvas_zoom_to}
              aria-haspopup="menu"
              aria-expanded={presetOpen}
              style={{ fontFamily: '"Geist Mono", monospace' }}
            >
              {zoomPercent}%
            </button>
            {presetOpen && (
              <div
                ref={presetPopoverRef}
                role="menu"
                aria-label={t.canvas_zoom_to}
                className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 min-w-[140px] rounded-md py-1 ${PILL_GLASS}`}
              >
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.scale}
                    data-popover-item
                    role="menuitem"
                    tabIndex={-1}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                    onClick={() => {
                      applyPreset(preset.scale);
                      closePresetMenu();
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">
                      {preset.hint ?? ""}
                    </span>
                  </button>
                ))}
                <div className="my-1 h-px bg-[var(--border)] opacity-60" />
                <button
                  data-popover-item
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] focus:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:text-[var(--text-primary)] focus:outline-none"
                  onClick={() => {
                    useCanvasStore.getState().resetViewport();
                    closePresetMenu();
                  }}
                >
                  <span>{t.reset}</span>
                </button>
              </div>
            )}
          </div>

          <button
            className={iconButton}
            onClick={() => stepZoomAtCenter("in")}
            title={t.zoom_in}
            aria-label={t.zoom_in}
          >
            <span className="text-[14px] leading-none">+</span>
          </button>
        </div>

        <div aria-hidden="true" className={dividerCls} />

        <button
          className={iconButton}
          onClick={fitAllProjects}
          title={`${t.fit} (${KEY_HINT.fit})`}
          aria-label={t.fit}
        >
          <FitIcon />
        </button>

        <button
          className={`${iconButton} ${
            focusModeActive
              ? "bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] text-[var(--text-primary)]"
              : ""
          }`}
          onClick={() => {
            const store = useCanvasStore.getState();
            if (store.focusMode.active) {
              store.exitFocusMode();
            } else {
              store.enterFocusMode();
            }
          }}
          title={focusModeActive ? t.exit_focus_view : t.focus_view}
          aria-label={focusModeActive ? t.exit_focus_view : t.focus_view}
          aria-pressed={focusModeActive}
        >
          <FocusIcon />
        </button>
      </div>
    </div>
  );
}
