/** An editor Tacit found on this Mac (T20). */
export interface EditorInfo {
  id: string;
  name: string;
}

/** What to open: a file or folder, and for a file optionally a line. */
export interface EditorTarget {
  path: string;
  line?: number;
}

export type EditorOpenResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unknown_editor" | "outside_projects" | "not_found" | "failed" };

/** The chosen default first. If it's been uninstalled, the first one found is the default. */
export function orderEditors(editors: EditorInfo[], defaultId: string | null): EditorInfo[] {
  return [...editors].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
}
