import { noteById } from "../board/notes";
import { noteBody } from "../board/noteText";
import { newTask } from "./taskActions";

/** Its name is the note's first line; the rest, the description. The note stays, linked. */
export function startTaskFromNote(id: string): void {
  const note = noteById(id);
  if (!note) return;
  newTask({
    title: note.text.trim() ? note.title : "",
    body: noteBody(note.text),
    startFrom: [{ kind: "note", label: note.title, target: id }],
    madeFrom: { kind: "note", label: note.title, target: id },
  });
}
