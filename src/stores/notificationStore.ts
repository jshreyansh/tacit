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
  /** The line above the message, in place of the type's "Error", "Warning" or "Info". */
  label?: string;
}

interface NotificationStore {
  notifications: Notification[];
  /** Returns the toast's id, to dismiss it later. */
  notify: (
    type: NotificationType,
    message: string,
    action?: NotificationAction,
    label?: string,
  ) => string;
  dismiss: (id: string) => void;
}

let notifyId = 0;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],

  notify: (type, message, action, label) => {
    const id = `notif-${++notifyId}`;
    const notification: Notification = {
      id,
      type,
      message,
      timestamp: Date.now(),
      ...(action ? { action } : {}),
      ...(label ? { label } : {}),
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
    return id;
  },

  dismiss: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
}));
