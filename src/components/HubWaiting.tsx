import type { CanvasRequest } from "../../shared/canvas-ops";
import { requestVerb } from "../../shared/canvas-ops";
import type { WaitingItem } from "../attention/waitingCount";
import { openCanvasRequest } from "../board/canvasRequests";
import { useT } from "../i18n/useT";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useHubStore } from "../stores/hubStore";
import { useProjectStore } from "../stores/projectStore";
import { goToTerminal, openBoard, openTask } from "../tasks/taskActions";
import { ago } from "../tasks/taskWords";
import { useNow } from "../tasks/useNow";
import { TERMINAL_TYPE_CONFIG } from "../terminal/terminalTypeConfig";

/** Lines shown under a workdesk before "N more". */
const SHOWN = 4;

type Dict = ReturnType<typeof useT>;

/** What a drawing request wants, in a line: "Codex wants to rename “maza” → “jazz”". */
function requestLine(r: CanvasRequest, t: Dict): string {
  const what = r.titles.length === 1 ? `“${r.titles[0]}”` : t["hub.wait.several"](r.titles.length);
  const verb = requestVerb(r);
  if (verb === "rename" && r.changes?.length === 1 && r.titles.length === 1) return t["hub.wait.rename"](r.name, r.titles[0], r.changes[0].text ?? "");
  return verb === "delete" ? t["hub.wait.delete"](r.name, what) : t["hub.wait.change"](r.name, what);
}

/** A task's line: what it asks of you, else the drawing its agent asked to change. */
function taskLine(item: Extract<WaitingItem, { kind: "task" }>, t: Dict): string {
  const ask = item.task.requests.find((r) => r.kind !== "allow");
  if (!ask) return item.requests[0] ? requestLine(item.requests[0], t) : item.task.title;
  if (ask.kind === "decide") return t["hub.wait.asks"](ask.byName, ask.text);
  if (ask.kind === "approve") return t["hub.wait.ok"](ask.byName, ask.text);
  if (ask.kind === "stuck") return t["hub.wait.stuck"](ask.text);
  return t["hub.wait.check"](ask.text);
}

/**
 * Under a workdesk in the Hub: one line for each thing waiting on you there,
 * oldest first. A line takes you to it: its workdesk, then its card.
 */
export function HubWaiting({ workdesk, items }: { workdesk: string; items: readonly WaitingItem[] }) {
  const t = useT();
  const now = useNow();
  const projects = useProjectStore((s) => s.projects);
  if (!items.length) return null;
  const go = (then: () => void) => {
    const registry = useCanvasRegistryStore.getState();
    if (registry.activeCanvasId !== workdesk) registry.switchCanvas(workdesk);
    useHubStore.getState().closeHub();
    then();
  };
  const agentName = (id: string) => {
    for (const p of projects) for (const w of p.worktrees) for (const term of w.terminals) if (term.id === id) return term.customTitle?.trim() || TERMINAL_TYPE_CONFIG[term.type]?.label || term.title;
    return id;
  };
  const line = (item: WaitingItem) => {
    if (item.kind === "task") return { text: taskLine(item, t), meta: `T-${item.task.n} · ${ago(new Date(item.since).toISOString(), now)}`, open: () => openTask(item.task.id) };
    if (item.kind === "request") return { text: requestLine(item.request, t), meta: ago(new Date(item.since).toISOString(), now), open: () => openCanvasRequest(item.request.id) };
    return { text: t["hub.wait.agent"](agentName(item.terminalId)), meta: null, open: () => goToTerminal(item.terminalId) };
  };
  const shown = items.slice(0, SHOWN);
  return (
    <ul className="mb-1 mt-0.5">
      {shown.map((item) => {
        const l = line(item);
        const key = item.kind === "task" ? item.task.id : item.kind === "request" ? item.request.id : item.terminalId;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => go(l.open)}
              className="tc-row-hover flex w-full items-baseline gap-2 rounded-md py-1 pl-[30px] pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            >
              <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 -translate-y-[1px] rounded-full" style={{ background: "var(--amber)" }} />
              <span className="min-w-0 flex-1">
                <span className="tc-ui line-clamp-2 text-[12.5px] text-[var(--text-primary)] [overflow-wrap:anywhere]">{l.text}</span>
                {l.meta && <span className="tc-meta block" style={{ color: "var(--text-metadata)" }}>{l.meta}</span>}
              </span>
            </button>
          </li>
        );
      })}
      {items.length > SHOWN && (
        <li>
          <button type="button" onClick={() => go(openBoard)} className="tc-meta py-0.5 pl-[44px] text-left hover:text-[var(--text-primary)]" style={{ color: "var(--text-metadata)" }}>
            {t["hub.wait.more"](items.length - SHOWN)}
          </button>
        </li>
      )}
    </ul>
  );
}
