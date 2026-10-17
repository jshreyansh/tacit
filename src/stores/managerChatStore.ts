import { create } from "zustand";
import type { ChatEvent } from "../../shared/chat-events";
import { EMPTY_TRANSCRIPT, reduceChat, replayChat, type ChatTranscript } from "../../shared/chat-transcript";

/**
 * The conversation with each manager that runs in chat mode (T6), keyed by
 * its terminal id, built from the engine's events with the shared reducer.
 * Main opens each chat on the session's record and keeps every event after,
 * so a reloaded window hydrates from its snapshot.
 */
interface ManagerChatStore {
  transcripts: Record<string, ChatTranscript>;
  apply: (terminalId: string, event: ChatEvent) => void;
  hydrate: (terminalId: string, events: ChatEvent[]) => void;
  drop: (terminalId: string) => void;
}

export const useManagerChatStore = create<ManagerChatStore>((set) => ({
  transcripts: {},
  apply: (terminalId, event) =>
    set((state) => ({
      transcripts: {
        ...state.transcripts,
        [terminalId]: reduceChat(state.transcripts[terminalId] ?? EMPTY_TRANSCRIPT, event),
      },
    })),
  hydrate: (terminalId, events) =>
    set((state) => ({ transcripts: { ...state.transcripts, [terminalId]: replayChat(events) } })),
  drop: (terminalId) =>
    set((state) => {
      if (!(terminalId in state.transcripts)) return state;
      const { [terminalId]: _dropped, ...rest } = state.transcripts;
      return { transcripts: rest };
    }),
}));

/**
 * A closed terminal's chat agent stops with it. Every closed terminal is
 * passed: main ignores one with no chat. (Absent outside Electron, as in
 * the store's tests.)
 */
export function forgetManagerChat(terminalId: string): void {
  useManagerChatStore.getState().drop(terminalId);
  if (typeof window === "undefined" || !window.tacit) return;
  void window.tacit.chat.forget(terminalId);
}

export function useManagerTranscript(terminalId: string | null): ChatTranscript {
  return useManagerChatStore((s) => (terminalId ? s.transcripts[terminalId] : undefined) ?? EMPTY_TRANSCRIPT);
}
