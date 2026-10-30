import type { CSSProperties } from "react";

/**
 * How a wallpaper behind the canvas is shown. Layers, back to front: the
 * image (blurred), a dim over all of it, a fade rising from the bottom
 * (where the pill and chat sit), then the grid dots if they're on. The dim
 * and the fade go toward the theme's background, so a light theme washes
 * the picture out rather than muddying it.
 *
 * It replaced the canvas opacity slider (29 Oct), which faded the empty
 * canvas to show the desktop through a transparent window: it did nothing
 * in full screen or once a wallpaper was set.
 */
export interface WallpaperLook {
  /** 0–90: how much of the theme's background lies over the whole picture. */
  dim: number;
  /** 0–24 px. */
  blur: number;
  /** 0–100: how strong the fade is at the bottom edge. 0 is none. */
  fadeStrength: number;
  /** 10–100: how far up the fade reaches, as a share of the window's height. */
  fadeHeight: number;
  /** The canvas grid's dots over the picture. */
  showGrid: boolean;
}

export const WALLPAPER_LIMITS = {
  dim: { min: 0, max: 90 },
  blur: { min: 0, max: 24 },
  fadeStrength: { min: 0, max: 100 },
  fadeHeight: { min: 10, max: 100 },
} as const;

export const DEFAULT_WALLPAPER_LOOK: WallpaperLook = {
  dim: 30,
  blur: 0,
  fadeStrength: 60,
  fadeHeight: 35,
  showGrid: true,
};

type NumberField = keyof typeof WALLPAPER_LIMITS;

function inRange(field: NumberField, value: unknown): number {
  const { min, max } = WALLPAPER_LIMITS[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WALLPAPER_LOOK[field];
  return Math.round(Math.max(min, Math.min(max, value)));
}

/** A saved look, each field checked; what's missing or wrong is the default. */
export function sanitizeWallpaperLook(raw: unknown): WallpaperLook {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    dim: inRange("dim", r.dim),
    blur: inRange("blur", r.blur),
    fadeStrength: inRange("fadeStrength", r.fadeStrength),
    fadeHeight: inRange("fadeHeight", r.fadeHeight),
    showGrid: typeof r.showGrid === "boolean" ? r.showGrid : DEFAULT_WALLPAPER_LOOK.showGrid,
  };
}

const BG = (percent: number) => `color-mix(in srgb, var(--bg) ${percent}%, transparent)`;

/**
 * The styles of each layer. `scale` shrinks the blur for a small preview
 * of the same look (the preview's width over the window's).
 */
export function wallpaperLayers(
  image: string,
  look: WallpaperLook,
  scale = 1,
): { image: CSSProperties; dim: CSSProperties | null; fade: CSSProperties | null } {
  const blur = look.blur * scale;
  return {
    image: {
      backgroundImage: `url("${image}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      // A blurred edge fades to nothing; reaching past the window keeps it full.
      ...(blur > 0 ? { filter: `blur(${blur}px)`, inset: `-${Math.ceil(blur * 2)}px` } : { inset: 0 }),
    },
    dim: look.dim > 0 ? { inset: 0, background: BG(look.dim) } : null,
    fade:
      look.fadeStrength > 0
        ? {
            left: 0,
            right: 0,
            bottom: 0,
            height: `${look.fadeHeight}%`,
            // Holds most of its strength through the lower half, then eases
            // out, so the height set is the height seen and there's no line at the top.
            background: `linear-gradient(to top, ${BG(look.fadeStrength)} 0%, ${BG(Math.round(look.fadeStrength * 0.8))} 45%, ${BG(Math.round(look.fadeStrength * 0.4))} 75%, ${BG(Math.round(look.fadeStrength * 0.12))} 92%, transparent 100%)`,
          }
        : null,
  };
}
