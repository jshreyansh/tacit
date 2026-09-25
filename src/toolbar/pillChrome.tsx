import { useCallback, useEffect, useRef, useState } from "react";
import { usePreferencesStore } from "../stores/preferencesStore";

/**
 * Shared chrome for the floating pills.
 *
 * This was BottomToolbar.tsx, which owned the zoom controls as well. Those
 * moved into the right rail — a canvas app should not put its view controls in
 * a fourth place — and what is left is the glass, the popover hooks and the
 * composer offset, which the workspace manager pill still needs.
 */

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

const platform = window.tacit?.app.platform ?? "darwin";
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
 * Shared by every floating bottom-center pill (this toolbar, the workspace
 * manager) so they all sit consistently just above ComposerBar's measured height
 * (published as `--composer-height`) instead of each hard-coding its own
 * guess, or drifting out of sync if the composer's layout ever changes.
 */
export function useComposerBottomOffset(): string {
  const composerEnabled = usePreferencesStore((s) => s.composerEnabled);
  return composerEnabled
    ? `calc(${COMPOSER_BOTTOM_INSET}px + var(--composer-height, ${COMPOSER_FALLBACK_HEIGHT}px) + ${COMPOSER_GAP}px)`
    : `${BOTTOM_OFFSET_PLAIN}px`;
}
