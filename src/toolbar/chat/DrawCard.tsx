import { useEffect, useState } from "react";
import { showDrawing, undoAgentOp, useAgentOps } from "../../board/agentOps";
import { thumbnailOf } from "../../board/boardForAgents";
import { AskButton } from "../../components/ask/AskCard";
import { useT } from "../../i18n/useT";
import { useBoardStore } from "../../stores/boardStore";
import { useFileTileStore } from "../../stores/fileTileStore";
import type { CanvasToolView } from "./threadMessages";

/** What an agent drew, in its chat: a picture of it, and where to see it. */
export function DrawCard({ view, running }: { view: CanvasToolView; running: boolean }) {
  const t = useT();
  const op = useAgentOps((s) => s.ops.find((o) => o.id === view.id || (view.kind === "draw" && o.kind === "draw" && o.focus !== null && o.focus === view.id)));
  const id = view.kind === "draw" ? view.id : (op?.focus ?? null);
  // The element itself, so the picture is new when it has moved or been renamed.
  const element = useBoardStore((s) => (id ? s.elements.find((e) => e.id === id) : undefined));
  const file = useFileTileStore((s) => (id ? s.tiles[id] : undefined));
  const [picture, setPicture] = useState<string | null>(null);
  useEffect(() => {
    if (view.kind !== "draw") return;
    if (id && element) setPicture(thumbnailOf(id));
    else if (file) {
      let gone = false;
      window.tacit.fileTiles.inspect(file.path).then(
        (info) => !gone && setPicture(info.ok && info.kind === "image" && info.url ? info.url : null),
        () => !gone && setPicture(null),
      );
      return () => {
        gone = true;
      };
    } else setPicture(null);
  }, [view.kind, id, element, file, op?.undone]);
  const name = view.title || (element?.type === "frame" || element?.type === "section" ? element.title : "");
  const words = running ? t.agent_canvas_drawing : view.asked ? t.agent_canvas_asked : { draw: name || t.agent_canvas_drew, change: t.agent_canvas_changed, delete: t.agent_canvas_deleted }[view.kind];
  return (
    <div className="my-1.5 overflow-hidden tc-sq-card border border-[var(--border)]">
      {picture && (
        <button type="button" className="block w-full bg-[var(--bg)] p-2" onClick={() => id && showDrawing(id)} title={t.agent_canvas_show} aria-label={`${t.agent_canvas_show}: ${words}`}>
          <img src={picture} alt="" className="mx-auto max-h-44 max-w-full object-contain" draggable={false} />
        </button>
      )}
      <div className={`flex min-h-[40px] items-center gap-2 px-3 py-1.5 ${picture ? "border-t border-[var(--border)]" : ""}`}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-metadata)]">
          <path d="M3 13l.8-3.2L11 2.6l2.4 2.4-7.2 7.2zM9.4 4.2l2.4 2.4" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">{words}</span>
        {op?.undone ? (
          <span className="shrink-0 text-[12px] text-[var(--text-metadata)]">{t.agent_canvas_undone}</span>
        ) : (
          <>
            {op && !running && (
              <AskButton tone="quiet" onClick={() => undoAgentOp(op.id)}>
                {t.agent_canvas_undo}
              </AskButton>
            )}
            {id && (element || file) && (
              <AskButton tone="secondary" onClick={() => showDrawing(id)}>
                {t.agent_canvas_show}
              </AskButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}
