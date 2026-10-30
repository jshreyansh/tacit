import { wallpaperLayers, type WallpaperLook } from "./wallpaper";

/**
 * The wallpaper, its dim and its bottom fade, filling the nearest
 * positioned box behind everything else in it (see wallpaper.ts).
 */
export function WallpaperLayers({
  image,
  look,
  scale = 1,
  id,
}: {
  image: string;
  look: WallpaperLook;
  /** For a small preview: the blur shrinks with it. */
  scale?: number;
  id?: string;
}) {
  const layers = wallpaperLayers(image, look, scale);
  return (
    <div id={id} className="pointer-events-none absolute inset-0 z-[-1] overflow-hidden" aria-hidden="true">
      <div className="absolute" style={layers.image} />
      {layers.dim && <div className="absolute" style={layers.dim} />}
      {layers.fade && <div className="absolute" style={layers.fade} />}
    </div>
  );
}
