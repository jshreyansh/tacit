import { TITLE_STRIP_HEIGHT } from "./titleStripHeight";

const platform = window.tacit?.app.platform ?? "darwin";
const isMac = platform === "darwin";

/**
 * The window's title strip — a drag region and nothing else.
 *
 * This was a 44px toolbar carrying the workspace name, a theme toggle, a
 * second door to Settings, and the update indicator. All of it moved: the
 * name is the OS title bar's job, theme became a setting, Settings kept its
 * one door on the left rail, and the update indicator went to the right rail
 * where it sits above the Hub.
 *
 * What is left cannot be deleted. macOS runs this window as
 * `titleBarStyle: "hiddenInset"` with `trafficLightPosition: {x:14, y:14}`,
 * so there is no OS title bar: the lights are drawn straight onto the web
 * content, and this strip is the only `WebkitAppRegion: "drag"` in the app.
 * Remove it and the window cannot be moved and the lights land on the canvas.
 * Windows draws its own min/max/close over the same band via
 * `titleBarOverlay.height`, which reads the same constant.
 *
 * So it stays, at the height the lights need and no more: transparent, no
 * border, nothing in it. Frame rather than chrome.
 */
export function TitleStrip() {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50"
      style={
        {
          height: TITLE_STRIP_HEIGHT,
          // Only the drag behaviour — no fill, so the canvas shows through
          // and the strip reads as part of the window, not a bar on top of it.
          WebkitAppRegion: "drag",
          // The traffic lights sit at x=14 and span roughly 54px. Nothing is
          // drawn here, but the region has to clear them so a drag that starts
          // on a light is the light's, not the window's.
          paddingLeft: isMac ? 72 : 0,
        } as React.CSSProperties
      }
    />
  );
}
