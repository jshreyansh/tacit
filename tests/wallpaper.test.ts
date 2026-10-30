import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_WALLPAPER_LOOK, sanitizeWallpaperLook, wallpaperLayers } from "../src/canvas/wallpaper";

// The wallpaper behind the canvas: a dim over it, a fade from the bottom, blur, the grid's dots.

test("a saved look is checked field by field; what's missing or out of range is the default or the limit", () => {
  assert.deepEqual(sanitizeWallpaperLook(undefined), DEFAULT_WALLPAPER_LOOK);
  assert.deepEqual(sanitizeWallpaperLook({ dim: 200, blur: -3, fadeStrength: "60", fadeHeight: 5, showGrid: false }), {
    dim: 90,
    blur: 0,
    fadeStrength: DEFAULT_WALLPAPER_LOOK.fadeStrength,
    fadeHeight: 10,
    showGrid: false,
  });
  assert.equal(sanitizeWallpaperLook({ dim: Number.NaN }).dim, DEFAULT_WALLPAPER_LOOK.dim);
  assert.equal(sanitizeWallpaperLook({ dim: 33.6 }).dim, 34);
});

test("the dim and the fade go toward the theme's background; at 0 there is no layer", () => {
  const layers = wallpaperLayers("tc-attachment://a.png", { ...DEFAULT_WALLPAPER_LOOK, dim: 40, fadeStrength: 80, fadeHeight: 50 });
  assert.equal(layers.image.backgroundImage, 'url("tc-attachment://a.png")');
  assert.equal(layers.dim?.background, "color-mix(in srgb, var(--bg) 40%, transparent)");
  assert.equal(layers.fade?.height, "50%");
  assert.match(String(layers.fade?.background), /^linear-gradient\(to top, color-mix\(in srgb, var\(--bg\) 80%, transparent\) 0%,.* transparent 100%\)$/);
  const bare = wallpaperLayers("x", { ...DEFAULT_WALLPAPER_LOOK, dim: 0, fadeStrength: 0 });
  assert.equal(bare.dim, null);
  assert.equal(bare.fade, null);
});

test("a blurred image reaches past the edges so they don't fade; a preview's blur shrinks with it", () => {
  const sharp = wallpaperLayers("x", { ...DEFAULT_WALLPAPER_LOOK, blur: 0 });
  assert.equal(sharp.image.filter, undefined);
  assert.equal(sharp.image.inset, 0);
  const blurred = wallpaperLayers("x", { ...DEFAULT_WALLPAPER_LOOK, blur: 10 });
  assert.equal(blurred.image.filter, "blur(10px)");
  assert.equal(blurred.image.inset, "-20px");
  assert.equal(wallpaperLayers("x", { ...DEFAULT_WALLPAPER_LOOK, blur: 10 }, 0.2).image.filter, "blur(2px)");
});
