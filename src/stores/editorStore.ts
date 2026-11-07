import { create } from "zustand";

import type { EditorInfo } from "../../shared/editors";

/** The editors main found on this Mac (T20). */
export const useEditorStore = create<{ editors: EditorInfo[] }>(() => ({ editors: [] }));

let watching = false;

/** Looks now, and again whenever Tacit comes forward, in case one was just installed. */
export function watchEditors(): void {
  if (watching) return;
  watching = true;
  const load = () => {
    window.tacit.editor
      .list()
      .then((editors) => {
        const current = useEditorStore.getState().editors;
        if (JSON.stringify(editors) !== JSON.stringify(current)) useEditorStore.setState({ editors });
      })
      .catch((error: unknown) => console.warn("[Tacit] Couldn't look for editors", error));
  };
  load();
  window.addEventListener("focus", load);
}
