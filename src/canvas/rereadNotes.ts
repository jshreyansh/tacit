import { usePinStore } from "../stores/pinStore";
import { useConnectionStore, type ConnectionData } from "../stores/connectionStore";
import { useNotificationStore } from "../stores/notificationStore";
import { resolveConnectionType } from "../../shared/connection-types";
import { endpointRole } from "./wireEnds";
import { sendOverWire } from "./wireSend";

/**
 * Reread: a note wired into an agent as standing context.
 *
 * An agent can't be made to reread a note at the start of every turn; Tacit
 * doesn't sit inside its loop. What it can do is make sure the agent always
 * has the current text: the note is sent when the wire is switched to
 * Reread, and again, whole, whenever the note changes, labelled as standing
 * context so the agent knows to follow it for the rest of its work. It waits
 * in the agent's mailbox if the agent is busy.
 *
 * Edits made while the app was closed aren't sent on start, so opening the
 * app doesn't push every standing note into every agent again.
 */

export const STANDING_NOTE_LEAD =
  "Standing context for your work, from a note the user wired to you. Follow it from now on; you'll be sent it again whenever it changes.";

/** How long a note has to stay unchanged before its new text is sent. */
const SETTLE_MS = 4_000;

function isRereadWire(connection: ConnectionData): boolean {
  return (
    connection.noteMode === "reread" &&
    connection.from.kind === "note" &&
    resolveConnectionType(connection) !== "relates-to" &&
    endpointRole(connection.to) === "agent"
  );
}

function noteText(pinId: string): string | null {
  const pin = Object.values(usePinStore.getState().pinsByProject).flat().find((p) => p.id === pinId);
  return pin ? `${pin.title}\n${pin.body}` : null;
}

const lastSent = new Map<string, string>();

/** Send a standing note now, e.g. right after the wire was set to Reread. */
export async function sendStandingNote(connection: ConnectionData): Promise<void> {
  if (!isRereadWire(connection)) return;
  const text = noteText(connection.from.id);
  if (text === null) return;
  lastSent.set(connection.id, text);
  const outcome = await sendOverWire(connection, connection.from, "text", STANDING_NOTE_LEAD);
  if (!outcome.ok) {
    useNotificationStore.getState().notify("warn", `Couldn't send the note to the agent: ${outcome.detail}`);
  }
}

export function installRereadNotes(): () => void {
  // What is on screen now counts as already sent.
  for (const connection of Object.values(useConnectionStore.getState().connections)) {
    if (!isRereadWire(connection)) continue;
    const text = noteText(connection.from.id);
    if (text !== null) lastSent.set(connection.id, text);
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = () => {
    for (const connection of Object.values(useConnectionStore.getState().connections)) {
      if (!isRereadWire(connection)) continue;
      const text = noteText(connection.from.id);
      if (text === null || lastSent.get(connection.id) === text) continue;
      if (!lastSent.has(connection.id)) {
        // A wire that became Reread is sent by setConnectionNoteModeInScene.
        lastSent.set(connection.id, text);
        continue;
      }
      clearTimeout(timers.get(connection.id));
      timers.set(
        connection.id,
        setTimeout(() => {
          timers.delete(connection.id);
          const current = useConnectionStore.getState().connections[connection.id];
          if (current) void sendStandingNote(current);
        }, SETTLE_MS),
      );
    }
  };
  const offPins = usePinStore.subscribe(check);
  return () => {
    offPins();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
