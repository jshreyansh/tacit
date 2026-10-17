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
  /**
   * A move between chat and terminal asked for mid-turn, waiting for the turn
   * to end: a turn lives in the process running it, so moving stops it.
   */
  pendingMoves: Record<string, "terminal" | "chat">;
  setPendingMove: (terminalId: string, to: "terminal" | "chat" | null) => void;
  /**
   * Messages written while the agent works, sent one at a time as each
   * turn ends; any can be sent at once to steer, edited, or removed.
   */
  queues: Record<string, QueuedMessage[]>;
  enqueue: (terminalId: string, text: string) => void;
  editQueued: (terminalId: string, id: string, text: string) => void;
  removeQueued: (terminalId: string, id: string) => void;
  /** Out of usage: the queue holds until the limit resets (ISO time). */
  waitUntil: Record<string, string>;
  setWaitUntil: (terminalId: string, at: string | null) => void;
}

export interface QueuedMessage {
  id: string;
  text: string;
}

let queueSeq = 0;

export const useManagerChatStore = create<ManagerChatStore>((set) => ({
  transcripts: {},
  pendingMoves: {},
  queues: {},
  waitUntil: {},
  enqueue: (terminalId, text) =>
    set((state) => ({ queues: { ...state.queues, [terminalId]: [...(state.queues[terminalId] ?? []), { id: `q${++queueSeq}`, text }] } })),
  editQueued: (terminalId, id, text) =>
    set((state) => ({ queues: { ...state.queues, [terminalId]: (state.queues[terminalId] ?? []).map((q) => (q.id === id ? { ...q, text } : q)) } })),
  removeQueued: (terminalId, id) =>
    set((state) => ({ queues: { ...state.queues, [terminalId]: (state.queues[terminalId] ?? []).filter((q) => q.id !== id) } })),
  setWaitUntil: (terminalId, at) =>
    set((state) => {
      const { [terminalId]: _was, ...rest } = state.waitUntil;
      return { waitUntil: at ? { ...rest, [terminalId]: at } : rest };
    }),
  setPendingMove: (terminalId, to) =>
    set((state) => {
      if ((state.pendingMoves[terminalId] ?? null) === to) return state;
      const { [terminalId]: _was, ...rest } = state.pendingMoves;
      return { pendingMoves: to ? { ...rest, [terminalId]: to } : rest };
    }),
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
      if (!(terminalId in state.transcripts) && !(terminalId in state.pendingMoves) && !(terminalId in state.queues)) return state;
      const { [terminalId]: _dropped, ...rest } = state.transcripts;
      const { [terminalId]: _move, ...moves } = state.pendingMoves;
      const { [terminalId]: _queue, ...queues } = state.queues;
      const { [terminalId]: _wait, ...waitUntil } = state.waitUntil;
      return { transcripts: rest, pendingMoves: moves, queues, waitUntil };
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

export function usePendingManagerMove(terminalId: string | null): "terminal" | "chat" | null {
  return useManagerChatStore((s) => (terminalId ? s.pendingMoves[terminalId] : undefined) ?? null);
}

export function useManagerTranscript(terminalId: string | null): ChatTranscript {
  return useManagerChatStore((s) => (terminalId ? s.transcripts[terminalId] : undefined) ?? EMPTY_TRANSCRIPT);
}
