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
