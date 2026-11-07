import { useEffect, useMemo } from "react";

import { orderEditors, type EditorInfo, type EditorTarget } from "../../shared/editors";
import { useT } from "../i18n/useT";
import { useEditorStore, watchEditors } from "../stores/editorStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";

async function open(editor: EditorInfo, target: EditorTarget, t: ReturnType<typeof useT>): Promise<void> {
  const result = await window.tacit.editor.open(editor.id, target);
  if (result.ok) return;
  const message =
    result.reason === "not_found"
      ? t["editor.notFound"]
      : result.reason === "outside_projects"
        ? t["editor.outsideProjects"]
        : t["editor.failed"](editor.name);
  useNotificationStore.getState().notify("error", message);
}

/** "Open in …" menu items for a file or folder, the default editor first (T20). */
export function useEditorItems(): (target: EditorTarget) => Array<{ label: string; onClick: () => void }> {
  const t = useT();
  const editors = useEditorStore((s) => s.editors);
  const defaultId = usePreferencesStore((s) => s.defaultEditor);
  useEffect(() => watchEditors(), []);
  return useMemo(() => {
    const ordered = orderEditors(editors, defaultId);
    return (target) =>
      ordered.map((editor) => ({
        label: t["editor.openIn"](editor.name),
        onClick: () => void open(editor, target, t),
      }));
  }, [editors, defaultId, t]);
}
