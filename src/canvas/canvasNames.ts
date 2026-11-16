/**
 * The name a new workdesk is offered: "Workdesk N" (or the label passed, in
 * the user's language), counting on from how many there are and skipping a
 * name already taken. With Default, Workdesk 2, 3, 5 and 6 that's
 * Workdesk 7, not "Workdesk 6 2".
 */
export function nextCanvasName(names: readonly string[], label = "Workdesk"): string {
  const taken = new Set(names.map((name) => name.trim().toLowerCase()));
  for (let n = names.length + 1; ; n += 1) {
    const candidate = `${label} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
