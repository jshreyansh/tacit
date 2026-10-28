import { create } from "zustand";
import type { WireMailboxChange } from "../types";

/**
 * What is waiting for each agent along its wires, mirrored from the main
 * process (electron/wire-mailbox.ts) for the badge on the canvas.
 */
interface WireMailboxStore {
  waiting: Record<string, WireMailboxChange["waiting"]>;
  apply: (change: WireMailboxChange) => void;
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
}));

export function installWireMailbox(): () => void {
  return window.tacit.wires.onMailboxChanged((change) => useWireMailboxStore.getState().apply(change));
}
