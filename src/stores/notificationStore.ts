import { create } from "zustand";

export type NotificationType = "error" | "warn" | "info";

export interface NotificationAction {
  /** Shown as a link at the end of the message. */
  label: string;
  run: () => void;
}

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  timestamp: number;
  /** Optional follow-up, e.g. revealing a finished download in Finder. */
  action?: NotificationAction;
}

interface NotificationStore {
  notifications: Notification[];
  notify: (
    type: NotificationType,
    message: string,
    action?: NotificationAction,
  ) => void;
  dismiss: (id: string) => void;
}

let notifyId = 0;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],

  notify: (type, message, action) => {
    const id = `notif-${++notifyId}`;
    const notification: Notification = {
      id,
      type,
      message,
      timestamp: Date.now(),
      ...(action ? { action } : {}),
    };

    const logFn =
      type === "error"
        ? console.error
        : type === "warn"
          ? console.warn
          : console.info;
    logFn(`[Tacit] ${message}`);

    set((state) => ({
      notifications: [...state.notifications, notification],
    }));
  },

  dismiss: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
}));
