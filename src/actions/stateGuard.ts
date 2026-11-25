/**
 * Your saved workdesks couldn't be opened. Main saves nothing over them
 * (electron/state-persistence.ts) until you choose: a snapshot from History,
 * or starting empty. Either way what was saved is kept beside it.
 */
import { getTranslations } from "../i18n/useT";
import { useNotificationStore } from "../stores/notificationStore";
import { useSnapshotHistoryStore } from "../stores/snapshotHistoryStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

let noticeId: string | null = null;

/** What's open now is what to save, from here on. */
export async function saveWhatIsOpen(): Promise<void> {
  await window.tacit.state.replace();
  if (noticeId) useNotificationStore.getState().dismiss(noticeId);
  noticeId = null;
  useWorkspaceStore.getState().markDirty();
}

/** A save was refused because of it. */
export const refusedUnopened = (error: unknown): boolean => String(error).includes("haven't been opened");

export function noteNotOpened(): void {
  // Put away with its ×, it comes back when a save is refused.
  if (useNotificationStore.getState().notifications.some((n) => n.id === noticeId)) return;
  const t = getTranslations();
  noticeId = useNotificationStore.getState().notify("error", t.state_not_opened_body, undefined, t.state_not_opened_label, {
    sticky: true,
    actions: [
      { label: t.state_not_opened_history, run: () => useSnapshotHistoryStore.getState().openHistory() },
      {
        label: t.state_not_opened_empty,
        run: () => {
          saveWhatIsOpen().catch((err) => useNotificationStore.getState().notify("error", err instanceof Error ? err.message : String(err)));
        },
      },
    ],
  });
}
