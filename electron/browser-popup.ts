/**
 * Where a window opened by a page in a browser node should go.
 *
 * Kept apart from main.ts because this is the decision that determines whether
 * work stays somewhere Tacit can see it. Every `target="_blank"` used to be
 * handed to the user's real browser, which ended the session as far as the
 * record was concerned and made the app stop feeling like the place work
 * happens. The rules are small, but getting one wrong either loses the work or
 * strands a sign-in that can only complete outside — so they are stated here
 * and tested, rather than inlined into an Electron callback that cannot be.
 */

export type PopupDisposition =
  /** Open as a new tile on the canvas, inheriting the opener's profile. */
  | { action: "canvas-node"; url: string; profileId: string }
  /** Hand to the real browser: the only place this can actually complete. */
  | { action: "system-browser"; url: string; reason: "auth" | "no-profile" }
  /** Neither. Refused rather than guessed at. */
  | { action: "ignore" };

export interface PopupDispositionInput {
  url: string;
  /** The opener's profile, absent when the guest is not one of ours. */
  profileId: string | undefined;
  /** Hosts whose sign-in refuses to complete in an embedded browser. */
  isAuthBlocked: (url: string) => boolean;
  /** Schemes and shapes we are willing to hand anywhere at all. */
  isSafeExternal: (url: string) => boolean;
}

export function resolvePopupDisposition(input: PopupDispositionInput): PopupDisposition {
  const { url, profileId, isAuthBlocked, isSafeExternal } = input;

  // Sign-in first, and regardless of profile. These providers reject embedded
  // browsers on purpose, so keeping such a popup on the canvas would produce a
  // dead-end page rather than a login. The round trip back is re-adoption.
  if (isAuthBlocked(url)) {
    return isSafeExternal(url)
      ? { action: "system-browser", url, reason: "auth" }
      : { action: "ignore" };
  }

  // Anything unsafe to open is opened nowhere. A canvas tile is not a safer
  // home for a hostile scheme than the system browser is.
  if (!isSafeExternal(url)) return { action: "ignore" };

  // A guest with no profile of ours — a connected tab, or a window Electron
  // opened for its own reasons — has no partition to inherit, so there is no
  // such thing as opening it "as the same person". Old behavior stands.
  if (!profileId) return { action: "system-browser", url, reason: "no-profile" };

  return { action: "canvas-node", url, profileId };
}
