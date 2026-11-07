import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useT } from "../i18n/useT";
import type { TurnOtherAgent, TurnPreviewResult, TurnRecord } from "../../shared/turns";
import { buildUndoSheet, historyTurns, type UndoNote } from "./turnUndoModel";

/**
 * Confirms putting a folder back to before one of a terminal's turns (T10).
 * Opened with a turn, it shows what will change for that turn; opened
 * without one, it lists the turns to choose from first.
 */

interface Props {
  terminalId: string;
  /** The turn to go back before; null lists the turns to pick from. */
  seq: number | null;
  onClose: () => void;
  onUndone: (seq: number, files: number) => void;
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  kimi: "Kimi",
  wuu: "Wuu",
};

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TurnUndoDialog({ terminalId, seq, onClose, onUndone }: Props) {
  const t = useT();
  const [turns, setTurns] = useState<TurnRecord[] | null>(null);
  const [selected, setSelected] = useState<number | null>(seq);
  const [preview, setPreview] = useState<TurnPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.tacit.turns.list(terminalId).then((result) => {
      if (live) setTurns(result?.ok ? result.turns : []);
    });
    return () => {
      live = false;
    };
  }, [terminalId]);

  useEffect(() => {
    if (selected === null) return;
    let live = true;
    setPreview(null);
    setError(null);
    void window.tacit.turns.preview(terminalId, selected).then((result) => {
      if (live) setPreview(result);
    });
    return () => {
      live = false;
    };
  }, [terminalId, selected]);

  const sheet = useMemo(
    () => (preview?.ok && turns ? buildUndoSheet(preview.preview, preview.otherAgents, turns, preview.folder) : null),
    [preview, turns],
  );

  const refusal = (reason: string, message?: string) =>
    reason === "turn-running"
      ? t["turnUndo.refused.running"]
      : reason === "unknown-turn"
        ? t["turnUndo.refused.gone"]
        : t["turnUndo.failed"](message ?? reason);

  const confirm = async () => {
    if (selected === null || !preview?.ok) return;
    setBusy(true);
    setError(null);
    const result = await window.tacit.turns.undo(terminalId, selected);
    setBusy(false);
    if (!result) return;
    if (!result.ok) {
      setError(refusal(result.reason, result.message));
      return;
    }
    onUndone(selected, result.files.length);
    onClose();
  };

  const noteText = (note: UndoNote): string => {
    switch (note.kind) {
      case "other-agents":
        return t["turnUndo.note.otherAgents"](
          note.agents.map((a: TurnOtherAgent) => PROVIDER_NAMES[a.provider] ?? a.provider).join(", "),
        );
      case "head-moved":
        return t["turnUndo.note.headMoved"];
      case "late":
        return t["turnUndo.note.late"];
      case "later-turns":
        return t["turnUndo.note.laterTurns"](note.count);
      case "kept":
        return t["turnUndo.note.kept"];
      case "ignored-untouched":
        return t["turnUndo.note.ignored"](note.folder);
    }
  };

  const fileGroup = (label: string, files: string[]) =>
    files.length === 0 ? null : (
      <div className="mt-2">
        <div className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</div>
        <ul className="mt-0.5 space-y-0.5">
          {files.map((file) => (
            <li key={file} className="truncate font-mono text-[11px] text-[var(--text-primary)]" title={file}>
              {file}
            </li>
          ))}
        </ul>
      </div>
    );

  const choices = seq === null && turns ? historyTurns(turns) : [];

  const body = (
    <div className="text-xs">
      {seq === null && (
        <div className="mb-2">
          {turns && choices.length === 0 && <div className="text-[var(--text-secondary)]">{t["turnUndo.historyEmpty"]}</div>}
          <ul className="max-h-36 space-y-0.5 overflow-y-auto">
            {choices.map((turn) => (
              <li key={turn.seq}>
                <button
                  type="button"
                  className={`w-full rounded-md px-2 py-1 text-left ${
                    selected === turn.seq
                      ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--border)]"
                  }`}
                  onClick={() => setSelected(turn.seq)}
                >
                  {t["turnUndo.historyRow"](clock(turn.startedAt), turn.filesChanged ?? 0)}
                  {turn.late && <span className="ml-1 text-[var(--amber)]">· {t["turnUndo.historyLate"]}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {selected !== null && !preview && <div className="text-[var(--text-secondary)]">{t["turnUndo.loading"]}</div>}
      {preview && !preview.ok && <div className="text-[var(--red)]">{refusal(preview.reason, preview.message)}</div>}
      {preview?.ok && sheet && (
        <div>
          <div className="text-[var(--text-primary)]">{t["turnUndo.intro"](clock(preview.preview.startedAt))}</div>
          <div className="max-h-48 overflow-y-auto">
            {preview.preview.files.length === 0 && sheet.kept.length === 0 && (
              <div className="mt-2 text-[var(--text-secondary)]">{t["turnUndo.nothing"]}</div>
            )}
            {fileGroup(t["turnUndo.changed"], sheet.changed)}
            {fileGroup(t["turnUndo.broughtBack"], sheet.broughtBack)}
            {fileGroup(t["turnUndo.removed"], sheet.removed)}
            {fileGroup(t["turnUndo.kept"], sheet.kept)}
          </div>
          <ul className="mt-3 space-y-1">
            {sheet.notes.map((note) => (
              <li
                key={note.kind}
                className={
                  note.kind === "other-agents" || note.kind === "head-moved" || note.kind === "late"
                    ? "text-[var(--amber)]"
                    : "text-[var(--text-secondary)]"
                }
              >
                {noteText(note)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="mt-2 text-[var(--red)]">{error}</div>}
    </div>
  );

  return (
    <ConfirmDialog
      open
      title={seq === null ? t["turnUndo.historyTitle"] : t["turnUndo.title"]}
      body={body}
      confirmLabel={t["turnUndo.confirm"]}
      busyLabel={t["turnUndo.busy"]}
      busy={busy}
      disableConfirm={!preview?.ok || preview.preview.files.length === 0}
      onCancel={onClose}
      onConfirm={() => void confirm()}
    />
  );
}
