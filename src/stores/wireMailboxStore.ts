import { create } from "zustand";
import type { HydraWireStatus, WireMailboxChange } from "../types";
import { useNotificationStore } from "./notificationStore";

/**
 * What is waiting for each agent along its wires, mirrored from the main
 * process (electron/wire-mailbox.ts) for the badge on the canvas.
 */
interface WireMailboxStore {
  waiting: Record<string, WireMailboxChange["waiting"]>;
  apply: (change: WireMailboxChange) => void;
  /** Hydra workers' role and status, by terminal, for their wires' labels. */
  hydra: Record<string, HydraWireStatus>;
  applyHydra: (status: HydraWireStatus) => void;
}

export const useWireMailboxStore = create<WireMailboxStore>((set) => ({
  waiting: {},
  apply: ({ terminalId, waiting }) =>
    set((state) => {
      const next = { ...state.waiting };
      if (waiting.length) next[terminalId] = waiting;
      else delete next[terminalId];
      return { waiting: next };
    }),
  hydra: {},
  applyHydra: (status) => set((state) => ({ hydra: { ...state.hydra, [status.terminalId]: status } })),
}));

export function installWireMailbox(): () => void {
  const offMail = window.tacit.wires.onMailboxChanged((change) => useWireMailboxStore.getState().apply(change));
  // A tracked hand-off that came back stuck needs the user, not only the
  // agent that handed it off.
  const offFlag = window.tacit.wires.onTrackedFlag((flag) => {
    const what =
      flag.outcome === "stuck"
        ? `is stuck${flag.reason ? ` (${flag.reason.replace(/_/g, " ")})` : ""}`
        : "hit an error";
    useNotificationStore
      .getState()
      .notify("warn", `${flag.targetTitle} ${what} on the work ${flag.senderTitle} handed off. Its report: ${flag.report}`);
  });
  const offHydra = window.tacit.wires.onHydraStatus((status) => useWireMailboxStore.getState().applyHydra(status));
  return () => {
    offMail();
    offFlag();
    offHydra();
  };
}
