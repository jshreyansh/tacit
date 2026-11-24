/**
 * Notes as the board's store has them. Needs only that store, so anything that
 * reads or adds to a note can use it (board/notes.ts makes and opens them).
 */
import { useMemo } from "react";
import { useBoardStore } from "../stores/boardStore";
import { getTranslations } from "../i18n/useT";
import type { BoardElement, BoardSticky } from "../types/board";
import { noteTitle as titleOf } from "./noteText";

export interface Note {
  id: string;
  title: string;
  text: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const noteTitle = (text: string): string => titleOf(text, getTranslations().tb.noteEmpty);
const toNote = (e: BoardSticky): Note => ({ id: e.id, title: noteTitle(e.text), text: e.text, color: e.color, x: e.x, y: e.y, w: e.w, h: e.h });
const isSticky = (e: BoardElement): e is BoardSticky => e.type === "sticky";

export const notes = (elements = useBoardStore.getState().elements): Note[] => elements.filter(isSticky).map(toNote);
export function noteById(id: string): Note | null {
  const e = useBoardStore.getState().elements.find((x) => x.id === id);
  return e && isSticky(e) ? toNote(e) : null;
}
export function useNotes(): Note[] {
  const elements = useBoardStore((s) => s.elements);
  return useMemo(() => notes(elements), [elements]);
}
export function useNote(id: string | null): Note | null {
  const elements = useBoardStore((s) => s.elements);
  return useMemo(() => notes(elements).find((n) => n.id === id) ?? null, [elements, id]);
}

export const NOTE_MAX = 100_000;

/** Your words, or an agent's: one step to undo for each time it's opened or added to. */
export function setNoteText(id: string, text: string): void {
  useBoardStore.getState().patch({ [id]: { text: text.slice(0, NOTE_MAX) } as Partial<BoardElement> });
}
