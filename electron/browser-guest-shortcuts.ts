/**
 * The four chords a browser node has to answer even when the page owns focus.
 *
 * A `<webview>` guest is a separate frame tree: once the user clicks into the
 * page, its keystrokes go to the guest's own webContents and never reach the
 * renderer's window listener. So the app's ordinary shortcut path (see
 * src/hooks/useKeyboardShortcuts.ts) is structurally unable to see ⌘F pressed
 * while reading a page — which is the only moment anyone actually presses it.
 * Main sees it, and forwards it back.
 *
 * The filter is deliberately narrow. Everything a user types inside a page is a
 * keystroke in a page they are logged into, and this handler is not a place to
 * be relaxed about that: only these chords are ever recognised, only the
 * resolved name is forwarded, and no key, character or target ever leaves here.
 *
 * These are the fixed platform chords rather than the user's remappable app
 * shortcuts, for two reasons: main has no access to the renderer's shortcut map
 * (it lives in localStorage), and inside a page ⌘F / ⌘+ / ⌘- / ⌘0 are the
 * page's own conventions — every browser answers them regardless of what the
 * surrounding app has bound. The host-side path stays remappable.
 */

export type GuestShortcut = "find" | "zoom-in" | "zoom-out" | "zoom-reset";

/** The shape of Electron's `before-input-event` input, narrowed to what matters. */
export interface GuestKeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function resolveGuestShortcut(
  input: GuestKeyInput,
  platform: NodeJS.Platform | string,
): GuestShortcut | null {
  if (input.type !== "keyDown") return null;
  if (input.alt) return null;

  // Same rule as the renderer's hasPrimaryModifier: Cmd on macOS, Ctrl
  // elsewhere. Requiring the *other* one to be absent stops Ctrl+⌘+F
  // (macOS fullscreen) from being read as find.
  const primary = platform === "darwin" ? input.meta : input.control;
  const secondary = platform === "darwin" ? input.control : input.meta;
  if (!primary || secondary) return null;

  switch (input.key) {
    case "f":
    case "F":
      // Shift+⌘F is the app's own "star focused" chord and several sites'
      // own; not ours to take.
      return input.shift ? null : "find";
    // Chromium reports the unshifted key for "=" and the shifted one for "+",
    // and users press both to mean zoom in.
    case "=":
    case "+":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "zoom-reset";
    default:
      return null;
  }
}
