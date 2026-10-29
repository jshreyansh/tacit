import { create } from "zustand";
import type { HydraWireStatus, TrackedHandoffStatus, WireMailboxChange, WireRestartSummary } from "../types";
import { useNotificationStore } from "./notificationStore";
import { findTerminal, terminalName } from "../actions/terminalLookup";

/**
 * What is waiting for each agent along its wires, mirrored from the main
 * process (electron/wire-mailbox.ts) for the badge on the canvas.
 */
interface WireMailboxStore {
  waiting: Record<string, WireMailboxChange["waiting"]>;
  /** Agents whose waiting messages are kept from before a restart. */
  held: Record<string, boolean>;
  apply: (change: WireMailboxChange) => void;
  /** Hydra workers' role and status, by terminal, for their wires' labels. */
  hydra: Record<string, HydraWireStatus>;
  applyHydra: (status: HydraWireStatus) => void;
  /** The latest tracked hand-off between two agents, by `sender>target`. */
  handoffs: Record<string, TrackedHandoffStatus["status"]>;
  applyHandoff: (status: TrackedHandoffStatus) => void;
}

export const handoffKey = (senderId: string, targetId: string) => `${senderId}>${targetId}`;

export const useWireMailboxStore = create<WireMailboxStore>((set) => ({
  waiting: {},
  held: {},
  apply: ({ terminalId, waiting, held }) =>
    set((state) => {
      const next = { ...state.waiting };
      const nextHeld = { ...state.held };
      if (waiting.length) next[terminalId] = waiting;
      else delete next[terminalId];
      if (waiting.length && held) nextHeld[terminalId] = true;
      else delete nextHeld[terminalId];
      return { waiting: next, held: nextHeld };
    }),
  hydra: {},
  applyHydra: (status) => set((state) => ({ hydra: { ...state.hydra, [status.terminalId]: status } })),
  handoffs: {},
  applyHandoff: ({ senderId, targetId, status }) =>
    set((state) => ({ handoffs: { ...state.handoffs, [handoffKey(senderId, targetId)]: status } })),
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
  const offHydra = window.tacit.wires.onHydraStatus((status) => {
    const before = useWireMailboxStore.getState().hydra[status.terminalId];
    useWireMailboxStore.getState().applyHydra(status);
    // Said once as it starts: the worker's tile may be off screen.
    if (status.needsYou && !before?.needsYou) {
      useNotificationStore
        .getState()
        .notify(
          "warn",
          `The ${status.role} worker ${terminalName(status.terminalId) ?? status.terminalId} is waiting for you: its terminal is asking something (such as whether to trust its folder) before it can start.`,
        );
    }
  });
  const offSummary = window.tacit.wires.onRestartSummary((summary) => void tellRestartSummary(summary));
  const offHandoff = window.tacit.wires.onHandoffStatus((status) => useWireMailboxStore.getState().applyHandoff(status));
  const offNotice = window.tacit.wires.onNotice(({ message }) => useNotificationStore.getState().notify("warn", message));
  return () => {
    offMail();
    offFlag();
    offHydra();
    offSummary();
    offHandoff();
    offNotice();
  };
}

/**
 * Tells main the window is listening and its workdesk is loaded, so what
 * wires were waiting on before a restart can be matched to terminals
 * (App.tsx calls this once the saved workdesk has been restored).
 */
export function wiresWindowReady(): Promise<void> {
  return window.tacit.wires.windowReady();
}

/**
 * After a restart: what was kept, for whom, and when it goes. Messages for a
 * terminal that is no longer on the workdesk can't go anywhere; they are
 * thrown away (a question among them is answered as dropped) and the user
 * is told how many.
 */
export async function tellRestartSummary(summary: WireRestartSummary): Promise<void> {
  const notify = useNotificationStore.getState().notify;
  if (summary.problem) notify("warn", summary.problem);
  const kept: string[] = [];
  let dropped = 0;
  for (const { terminalId, waiting } of summary.held) {
    if (!findTerminal(terminalId)) {
      dropped += (await window.tacit.wires.discardWaiting(terminalId)).discarded;
      continue;
    }
    kept.push(`${waiting} for ${terminalName(terminalId) ?? terminalId}`);
  }
  if (kept.length > 0) {
    notify(
      "info",
      `Kept from before Tacit restarted: ${kept.join(", ")}. Each agent gets its messages after its next turn, or click ✉ on it to deliver them now.`,
    );
  }
  if (dropped > 0) {
    notify("warn", `${dropped} waiting ${dropped === 1 ? "message was" : "messages were"} for terminals no longer on this workdesk, so ${dropped === 1 ? "it was" : "they were"} dropped.`);
  }
}
