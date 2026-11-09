/**
 * The name a new canvas is offered: "Canvas N", counting on from how many
 * there are and skipping a name already taken. With Default, Canvas 2, 3, 5
 * and 6 that's Canvas 7, where it used to be "Canvas 6 2".
 */
export function nextCanvasName(names: readonly string[]): string {
  const taken = new Set(names.map((name) => name.trim().toLowerCase()));
  for (let n = names.length + 1; ; n += 1) {
    const candidate = `Canvas ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
