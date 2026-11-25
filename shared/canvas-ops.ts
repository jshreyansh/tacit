/** What an agent may ask of the canvas, checked in the main process before it reaches the window. */

export interface CanvasRead {
  /** One drawing, section or tile; null for all of it. */
  id: string | null;
  picture: boolean;
}

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export function parseCanvasRead(body: unknown): CanvasRead | { error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => k !== "id" && k !== "picture");
  if (unknown.length) return { error: `Unknown: ${unknown.join(", ").slice(0, 100)}` };
  if (b.id !== undefined && b.id !== null && (typeof b.id !== "string" || !ID.test(b.id))) return { error: "id must be the id of a drawing, section or tile" };
  if (b.picture !== undefined && typeof b.picture !== "boolean") return { error: "picture must be true or false" };
  return { id: (b.id as string | undefined) ?? null, picture: b.picture === true };
}
