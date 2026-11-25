import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasRequest } from "../../shared/canvas-ops";
import { AskBadge, AskButton, AskFoot, AskHead, AskReply } from "../components/ask/AskCard";
import { useT } from "../i18n/useT";
import { useBoardStore } from "../stores/boardStore";
import { ago } from "../tasks/taskWords";
import { useNow } from "../tasks/useNow";
import { openTask } from "../tasks/taskActions";
import { useTask, useTaskOfTerminal } from "../tasks/taskStore";
import { answerCanvasRequest, beforeAndAfter, changeWords, onlyWords, openCanvasRequest, showCanvasRequest, useCanvasRequestStore, useCanvasRequests, wantsTo } from "./canvasRequests";

/**
 * An agent asking to change something of yours: what, as it is and as it would
 * be, and your answer. The chat's own anatomy, on the canvas and in its chat.
 */
export function CanvasAskCard({ request, show = true, onClose, inTask = false }: { request: CanvasRequest; /** A way to the drawing, when it isn't beside it. */ show?: boolean; /** It can be put away, beside its drawing. */ onClose?: () => void; /** On its task's card, which needs no line naming it. */ inTask?: boolean }) {
  const t = useT();
  const now = useNow();
  const [denying, setDenying] = useState(false);
  const busy = useCanvasRequestStore((s) => s.answering.has(request.id));
  const elements = useBoardStore((s) => s.elements);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pictures = useMemo(() => beforeAndAfter(request), [request, elements]);
  const words = changeWords(request);
  const current = useTaskOfTerminal(request.terminalId);
  const kept = useTask(request.task?.id ?? null);
  const task = request.task ? kept : current;
  const plain = onlyWords(request);
  // A rename says it in one: "maza" → "jazz".
  const renamed = wantsTo(request) === "rename" && words.length === 1;
  const name = request.titles.length === 1 ? `"${request.titles[0]}"` : t.canvas_ask_several(request.titles.length);
  return (
    <div className="tc-sq-card overflow-hidden border border-[var(--border)] bg-[var(--surface)]">
      <AskHead kind="approval" label={t.canvas_ask_wants[wantsTo(request)](request.name)} title={renamed ? words[0] : name} meta={<span className="inline-flex items-center gap-1.5">{ago(new Date(request.at).toISOString(), now)}{onClose && <CloseButton onClick={onClose} />}</span>} />
      <p className="px-3 pb-2 pl-[46px] text-[12.5px] leading-snug text-[var(--text-secondary)] empty:hidden [overflow-wrap:anywhere]">
        {renamed ? null : words.join(", ")}
        {task && !inTask && (
          <button type="button" className="mt-1 block text-[12px] text-[var(--text-metadata)] hover:underline" onClick={() => openTask(task.id)}>
            {t.canvas_ask_on_task(`T-${task.n} ${task.title}`)}
          </button>
        )}
      </p>
      {pictures && !plain && (
        <div className="mx-3 mb-2 flex items-stretch gap-1.5">
          {[
            [t.canvas_ask_before, pictures.before],
            ...(pictures.after ? [[t.canvas_ask_after, pictures.after]] : []),
          ].map(([label, src]) => (
            <figure key={label} className="tc-sq-ctl flex min-w-0 flex-1 flex-col overflow-hidden bg-[color-mix(in_srgb,var(--bg)_60%,transparent)]" style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}>
              <img src={src} alt="" className="m-1.5 min-h-0 flex-1 object-contain" style={{ maxHeight: 96 }} draggable={false} />
              <figcaption className="px-2 pb-1 text-center text-[11px] text-[var(--text-metadata)]">{label}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!pictures && <p className="px-3 pb-2 text-[12.5px] text-[var(--text-metadata)]">{t.agent_canvas_gone}</p>}
      {denying ? (
        <AskReply placeholder={t.canvas_ask_deny_note} action={t.canvas_ask_deny} onSend={(note) => void answerCanvasRequest(request.id, "deny", note)} onBack={() => setDenying(false)} />
      ) : (
        <AskFoot>
          <AskButton tone="primary" disabled={busy || !pictures} onClick={() => void answerCanvasRequest(request.id, "once")}>
            {request.kind === "delete" ? t.canvas_ask_allow_delete : t.canvas_ask_allow}
          </AskButton>
          {request.kind === "change" && (
            <AskButton disabled={busy || !pictures} title={t.canvas_ask_always_title} onClick={() => void answerCanvasRequest(request.id, "always")}>
              {t.canvas_ask_always}
            </AskButton>
          )}
          <AskButton tone="quiet" disabled={busy} onClick={() => setDenying(true)}>
            {t.canvas_ask_deny_more}
          </AskButton>
          {show && pictures && (
            <AskButton tone="quiet" className="ml-auto" title={t.canvas_ask_show} onClick={() => showCanvasRequest(request)}>
              {t.agent_canvas_show}
            </AskButton>
          )}
        </AskFoot>
      )}
    </div>
  );
}

/** On the board, alone or on its task's card: brought into view when that's what you came for. */
export function BoardAskCard({ request, inTask = false }: { request: CanvasRequest; inTask?: boolean }) {
  const shown = useCanvasRequestStore((s) => s.shown === request.id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const timer = window.setTimeout(() => useCanvasRequestStore.setState({ shown: null }), 2_500);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return (
    <div ref={ref} className="tc-tk-request" data-shown={shown || undefined}>
      <CanvasAskCard request={request} inTask={inTask} />
    </div>
  );
}

/** In an agent's chat, above its message box. */
export function CanvasAsks({ terminalId, width }: { terminalId: string; width?: string }) {
  const requests = useCanvasRequests(terminalId);
  if (!requests.length) return null;
  return (
    <div className={width ?? "mb-2"}>
      <CanvasAskCard key={requests[0].id} request={requests[0]} />
      {requests.length > 1 && <MoreLine count={requests.length - 1} />}
    </div>
  );
}
function MoreLine({ count }: { count: number }) {
  const t = useT();
  return <p className="px-3 pt-1 text-[11.5px] text-[var(--text-metadata)]">{t.canvas_ask_more(count)}</p>;
}

function CloseButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-metadata)] hover:text-[var(--text-primary)]" aria-label={t.close} title={t.close} onClick={onClick}>
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <path d="M2 2l6 6M8 2L2 8" />
      </svg>
    </button>
  );
}

/** On an agent's terminal, on the canvas and in the grid: what it asks, and your answer. */
export function CanvasAskStrip({ terminalId }: { terminalId: string }) {
  const t = useT();
  const requests = useCanvasRequests(terminalId);
  const request = requests[0];
  const busy = useCanvasRequestStore((s) => !!request && s.answering.has(request.id));
  const [denying, setDenying] = useState<string | null>(null);
  if (!request) return null;
  const name = request.titles.length === 1 ? `"${request.titles[0]}"` : t.canvas_ask_several(request.titles.length);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className="tc-bd-askstrip nodrag nopan nowheel" role="status" onMouseDown={stop} onPointerDown={stop} onDoubleClick={stop} onKeyDown={stop}>
      {denying === request.id ? (
        <AskReply placeholder={t.canvas_ask_deny_note} action={t.canvas_ask_deny} onSend={(note) => void answerCanvasRequest(request.id, "deny", note)} onBack={() => setDenying(null)} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
          <AskBadge kind="approval" />
          <span className="min-w-[120px] flex-1 text-[12.5px] leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">
            {t.canvas_ask_strip[wantsTo(request)](wantsTo(request) === "rename" && changeWords(request).length === 1 ? changeWords(request)[0] : name)}
            {wantsTo(request) === "change" && <span className="text-[var(--text-secondary)]"> {changeWords(request).join(", ")}</span>}
            {requests.length > 1 && <span className="text-[var(--text-metadata)]"> {t.canvas_ask_more(requests.length - 1)}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <AskButton tone="primary" disabled={busy} onClick={() => void answerCanvasRequest(request.id, "once")}>
              {request.kind === "delete" ? t.canvas_ask_allow_delete : t.canvas_ask_allow}
            </AskButton>
            <AskButton tone="quiet" disabled={busy} onClick={() => setDenying(request.id)}>
              {t.canvas_ask_deny_more}
            </AskButton>
            <AskButton tone="quiet" onClick={() => openCanvasRequest(request.id)}>
              {t.canvas_ask_details}
            </AskButton>
          </span>
        </div>
      )}
    </div>
  );
}
