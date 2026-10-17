import { create } from "zustand";
import type { ChatEvent } from "../../shared/chat-events";
import { EMPTY_TRANSCRIPT, reduceChat, replayChat, type ChatTranscript } from "../../shared/chat-transcript";

/**
 * The conversation with each manager that runs in chat mode (T6), keyed by
 * its terminal id, built from the engine's events with the shared reducer.
 * Main keeps every event, so a reloaded window hydrates from its snapshot.
 */
interface ManagerChatStore {
  transcripts: Record<string, ChatTranscript>;
  apply: (terminalId: string, event: ChatEvent) => void;
  hydrate: (terminalId: string, events: ChatEvent[]) => void;
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
}));

export function useManagerTranscript(terminalId: string | null): ChatTranscript {
  return useManagerChatStore((s) => (terminalId ? s.transcripts[terminalId] : undefined) ?? EMPTY_TRANSCRIPT);
}
