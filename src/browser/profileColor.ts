/**
 * A stable colour per browser profile.
 *
 * The profile chip on a node is a ~100px label, which is unreadable at canvas
 * zoom — exactly the zoom level at which "which of my identities is this node
 * signed in as" matters most. Colour survives that: you cannot read a name at
 * 0.3x, but you can tell two dots apart. It is derived from the identity id
 * rather than stored, so it never has to be persisted, migrated, or kept in
 * sync with a rename.
 *
 * Guest is deliberately colourless. It holds nobody's session, and giving it a
 * hue of its own would make the signed-out profile look like one more identity
 * among the rest instead of the absence of one.
 */
import { GUEST_PROFILE_ID } from "../../shared/browser-agent-profiles";

export interface ProfileSwatch {
  /** Hue in degrees, or null for Guest. */
  hue: number | null;
  /** Dot / border colour. */
  color: string;
  /** A faint fill, for the chip behind the dot. */
  soft: string;
}

export function isGuestProfile(identityId: string): boolean {
  return identityId === GUEST_PROFILE_ID;
}

/** FNV-1a. Small, dependency-free, and well spread over short ASCII ids. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hue for a profile, or null for Guest. Stepping the hash by the golden angle
 * spreads ids that differ only in their last character — which is what the
 * generated `identity-<base36>-<n>` ids do — into visibly different colours
 * instead of neighbouring ones.
 */
export function profileHue(identityId: string): number | null {
  if (isGuestProfile(identityId)) return null;
  const stepped = hash32(identityId) * 137.508;
  return Math.round(stepped % 360);
}

export function profileSwatch(identityId: string): ProfileSwatch {
  const hue = profileHue(identityId);
  if (hue === null) {
    return {
      hue: null,
      color: "var(--text-faint)",
      soft: "transparent",
    };
  }
  return {
    hue,
    color: `hsl(${hue} 58% 58%)`,
    soft: `hsl(${hue} 58% 58% / 0.14)`,
  };
}
