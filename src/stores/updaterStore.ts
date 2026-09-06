import { create } from "zustand";
import type { UpdateEventInfo } from "../types";
import { useNotificationStore } from "./notificationStore";
import { useLocaleStore } from "./localeStore";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";

export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "error";

interface UpdaterStore {
  status: UpdateStatus;
  info: UpdateEventInfo | null;
  downloadPercent: number;
  errorMessage: string | null;
}

export const useUpdaterStore = create<UpdaterStore>((set) => ({
  status: "idle",
  info: null,
  downloadPercent: 0,
  errorMessage: null,
}));

export function initUpdaterListeners(): () => void {
  if (!window.tacit?.updater) {
    return () => {};
  }

  const cleanups: (() => void)[] = [];

  cleanups.push(
    window.tacit.updater.onUpdateAvailable((info) => {
      useUpdaterStore.setState({ status: "downloading", info, downloadPercent: 0 });
    }),
  );

  cleanups.push(
    window.tacit.updater.onDownloadProgress((progress) => {
      useUpdaterStore.setState({ downloadPercent: progress.percent });
    }),
  );

  // Catch up on anything main decided before these listeners existed. Without
  // it, a broadcast that arrived during renderer boot was lost outright: no
  // toolbar button, no dialog, and a downloaded update unreachable until the
  // next check half an hour later.
  void window.tacit.updater
    .getState?.()
    .then((snapshot) => {
      if (!snapshot || snapshot.status === "idle") return;
      // Only fill a gap. A live event that landed while this was in flight is
      // newer than the snapshot and must not be overwritten by it.
      if (useUpdaterStore.getState().status !== "idle") return;
      useUpdaterStore.setState({
        status: snapshot.status,
        info: snapshot.info,
        downloadPercent: snapshot.downloadPercent,
        errorMessage: snapshot.errorMessage,
      });
    })
    .catch(() => {
      // An older main process has no such handler. Events still work.
    });

  cleanups.push(
    window.tacit.updater.onUpdateDownloaded((info) => {
      useUpdaterStore.setState({ status: "ready", info, downloadPercent: 100 });
    }),
  );

  cleanups.push(
    window.tacit.updater.onError((error) => {
      useUpdaterStore.setState({ status: "error", errorMessage: error.message });
    }),
  );

  if (window.tacit.updater.onLocationWarning) {
    cleanups.push(
      window.tacit.updater.onLocationWarning(() => {
        const locale = useLocaleStore.getState().locale;
        const dict = locale === "zh" ? { ...en, ...zh } : en;
        useNotificationStore
          .getState()
          .notify("warn", dict.update_location_warning);
      }),
    );
  }

  return () => cleanups.forEach((fn) => fn());
}
