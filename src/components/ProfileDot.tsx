import { isGuestProfile, profileSwatch } from "../browser/profileColor";

/**
 * The colour a browser profile is known by, everywhere it appears.
 *
 * Guest is drawn hollow rather than in a colour of its own: it holds nobody's
 * session, and an empty ring is what "signed out" looks like next to a row of
 * filled ones.
 */
export function ProfileDot({
  identityId,
  size = 7,
}: {
  identityId: string;
  size?: number;
}) {
  const swatch = profileSwatch(identityId);
  const guest = isGuestProfile(identityId);
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: guest ? "transparent" : swatch.color,
        border: guest ? "1px dashed var(--text-faint)" : "none",
      }}
    />
  );
}
