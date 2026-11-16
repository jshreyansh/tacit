import { useT } from "../i18n/useT";
import { Switch } from "../components/ui/parts";
import { makeNote, makeTask } from "./taskActions";
import { confirmAsync } from "../components/ui/confirmAsync";
import { pinKind } from "../../shared/pin";
import type { Pin } from "../types";

/**
 * One switch for what an item is: on, a task with a status, steps and who's
 * on it (it counts in Tasks and can ask you); off, a plain note. Turning it
 * off keeps the text; the steps become the note's lines.
 */
export function TrackAsTask({ pin, compact }: { pin: Pin; compact?: boolean }) {
  const t = useT();
  const tracked = pinKind(pin) === "task";
  return (
    <label
      className="nodrag inline-flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]"
      title={t.task_track_hint}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {!compact && <span>{t.task_track}</span>}
      <Switch
        checked={tracked}
        label={t.task_track}
        onChange={(next) => {
          if (next) return void makeTask(pin);
          // Turning a task into a note keeps its text but not its status or
          // its steps as steps, so a task with either asks first.
          const hasState = (pin.steps?.length ?? 0) > 0 || (pin.status !== "open" && pin.status !== undefined);
          if (!hasState) return void makeNote(pin);
          void confirmAsync({
            title: t.task_untrack_title,
            body: t.task_untrack_body,
            confirmLabel: t.task_untrack_action,
            focusCancel: true,
          }).then((ok) => {
            if (ok) void makeNote(pin);
          });
        }}
      />
    </label>
  );
}
