import { useState } from "react";
import { useT } from "../i18n/useT";
import type { MenuItem } from "../components/ContextMenu";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useComposerStore } from "../stores/composerStore";
import { useManagerChatStore } from "../stores/managerChatStore";
import { getTerminalPtyId, useTerminalRuntimeStore } from "./terminalRuntimeStore";
import { TurnUndoDialog } from "./TurnUndoDialog";
import { undoButtonState, type UndoButtonState } from "./turnUndoModel";
import { useTurnList } from "./useTurnList";

/**
 * Undoing an agent's turns (T10), for every place its terminal shows: the
 * tile on the canvas and its tab in the workdesk view. Gives the Undo
 * button's state, the menu items, and the dialog to render.
 */
export function useTurnUndo(terminalId: string, chatMode: boolean): {
  undoState: UndoButtonState;
  /** Opens the confirm sheet for the last turn. */
  undoLast: () => void;
  menuItems: MenuItem[];
  /** Why there's no undo for this agent, when there isn't: shown where the button would be. */
  unavailable: { line: string; hint: string } | null;
  dialog: React.ReactNode;
} {
  const t = useT();
  // Which turn the dialog is for, or null for the history list.
  const [open, setOpen] = useState<{ seq: number | null } | null>(null);
  const provider = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.telemetry?.provider);
  const running = useTerminalRuntimeStore((s) => s.terminals[terminalId]?.telemetry?.task_status === "running");
  const turnList = useTurnList(terminalId, !!provider && provider !== "unknown");
  const undoState = undoButtonState(turnList, running);

  const notify = (text: string) => useNotificationStore.getState().notify("info", text);
  const redo = () => {
    void window.tacit.turns.redo(terminalId).then((result) => {
      if (result?.ok) notify(t["turnUndo.redone"]);
      else if (result) useNotificationStore.getState().notify("error", t["turnUndo.redoFailed"](result.message ?? result.reason));
    });
  };
  const undone = (files: number) => {
    useNotificationStore.getState().notify("info", t["turnUndo.done"](files), { label: t["turnUndo.redo"], run: redo });
    // The agent still remembers making those changes. Leave it a note to
    // send or edit, never sent on its own.
    const note = t["turnUndo.agentNote"](files);
    if (chatMode) {
      useManagerChatStore.getState().leaveNote(terminalId, note);
    } else if (usePreferencesStore.getState().composerEnabled) {
      const composer = useComposerStore.getState();
      composer.setDraft(composer.draft ? `${composer.draft}\n${note}` : note);
    } else {
      const ptyId = getTerminalPtyId(terminalId);
      if (ptyId !== null) window.tacit.terminal.input(ptyId, note);
    }
  };

  const unavailable =
    undoState.kind === "no-git"
      ? {
          line: t["turnUndo.noGitLine"],
          hint: undoState.repos.length > 0 ? t["turnUndo.noGitReposHint"](undoState.repos) : t["turnUndo.noGitHint"],
        }
      : undoState.kind === "skipped"
        ? {
            line: t["turnUndo.off"],
            hint: undoState.reason === "sparse-checkout" ? t["turnUndo.offSparse"] : t["turnUndo.offTooManyFiles"],
          }
        : null;

  const menuItems: MenuItem[] = [];
  if (turnList?.ok && turnList.git) {
    menuItems.push({ label: t["turnUndo.history"], onClick: () => setOpen({ seq: null }) });
    if (turnList.turns.some((turn) => turn.undone)) menuItems.push({ label: t["turnUndo.redoMenu"], onClick: redo });
  }
  if (unavailable) {
    const label = undoState.kind === "no-git" ? t["turnUndo.noGit"] : unavailable.line;
    menuItems.push({ label, onClick: () => notify(unavailable.hint) });
  }

  return {
    undoState,
    undoLast: () => {
      if (undoState.kind === "ready") setOpen({ seq: undoState.seq });
    },
    menuItems,
    unavailable,
    dialog: open && (
      <TurnUndoDialog terminalId={terminalId} seq={open.seq} onClose={() => setOpen(null)} onUndone={(_seq, files) => undone(files)} />
    ),
  };
}
