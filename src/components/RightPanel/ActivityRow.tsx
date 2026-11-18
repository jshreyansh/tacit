import { useState, type ReactNode } from "react";
import type { CaptureEntryView } from "../../../shared/capture";
import { useT } from "../../i18n/useT";
import { useBrowserCardStore } from "../../stores/browserCardStore";
import { usePinStore } from "../../stores/pinStore";
import { useProjectStore } from "../../stores/projectStore";
import { agentIcon } from "../../toolbar/agentIcons";
import { findAgentAdapter } from "../../../shared/agent-adapters";
import { flyToBounds, panToTerminal } from "../../utils/panToTerminal";
import { BrowserTabIcon } from "../../workdesk/BrowserTabIcon";

/**
 * One line of the Activity feed: an icon for what happened on a timeline,
 * then what happened in words, with every node it names shown as a chip (an
 * agent's icon and name, a page's icon and title) that flies the canvas to
 * it. The record keeps ids; this turns them back into the things you see.
 */

type Dict = ReturnType<typeof useT>;

export const KIND_COLOR: Record<string, string> = {
  prompt: "var(--accent)",
  spawn: "var(--cyan)",
  close: "var(--text-faint)",
  wire: "var(--purple)",
  unwire: "var(--text-faint)",
  retype_wire: "var(--purple)",
  redirect_wire: "var(--purple)",
  edit_wire: "var(--purple)",
  tracked_handoff: "var(--purple)",
  rename: "var(--text-muted)",
  manager: "var(--amber)",
  browser_action: "var(--cyan)",
  journal_write: "var(--purple)",
  handoff: "var(--accent)",
  topology: "var(--text-faint)",
  run_started: "var(--green)",
  run_named: "var(--green)",
  run_ended: "var(--green)",
  worker_state: "var(--amber)",
  spawn_refused: "var(--red)",
};

/** A small line icon per kind, on the 16-unit grid the rail's icons use. */
function KindGlyph({ kind }: { kind: string }) {
  const p = (d: string) => <path d={d} />;
  let body: ReactNode;
  switch (kind) {
    case "prompt":
      body = (
        <>
          {p("M3 3.5h10a1.2 1.2 0 0 1 1.2 1.2v5.1a1.2 1.2 0 0 1-1.2 1.2H7.6L5 13v-2H3a1.2 1.2 0 0 1-1.2-1.2V4.7A1.2 1.2 0 0 1 3 3.5z")}
          {p("M5 6.4h6M5 8.6h3.5")}
        </>
      );
      break;
    case "spawn":
      body = (
        <>
          {p("M3 3h10v10H3z")}
          {p("M8 5.5v5M5.5 8h5")}
        </>
      );
      break;
    case "close":
      body = (
        <>
          {p("M3 3h10v10H3z")}
          {p("M6 6l4 4M10 6l-4 4")}
        </>
      );
      break;
    case "wire":
    case "retype_wire":
    case "redirect_wire":
    case "edit_wire":
      body = p("M6.5 9.5l3-3M5 7.2L3.8 8.4a2.4 2.4 0 0 0 3.4 3.4l1.2-1.2M11 8.8l1.2-1.2a2.4 2.4 0 0 0-3.4-3.4L7.6 5.4");
      break;
    case "unwire":
      body = p("M5 7.2L3.8 8.4a2.4 2.4 0 0 0 3.4 3.4l1.2-1.2M11 8.8l1.2-1.2a2.4 2.4 0 0 0-3.4-3.4L7.6 5.4M3 3l10 10");
      break;
    case "tracked_handoff":
    case "handoff":
      body = p("M2.5 6h9l-2.5-2.5M13.5 10h-9l2.5 2.5");
      break;
    case "rename":
      body = p("M10.5 3l2.5 2.5L6 12.5H3.5V10z");
      break;
    case "manager":
      body = p("M2.5 11.5l1-6 3 2.5L8 4l1.5 4 3-2.5 1 6z");
      break;
    case "browser_action":
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" />
          {p("M2.5 8h11M8 2.5c2 2.3 2 8.7 0 11M8 2.5c-2 2.3-2 8.7 0 11")}
        </>
      );
      break;
    case "journal_write":
      body = (
        <>
          {p("M4 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4z")}
          {p("M4 2.5v11M6.5 5.5h4M6.5 7.8h3")}
        </>
      );
      break;
    case "topology":
      body = (
        <>
          {p("M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z")}
        </>
      );
      break;
    case "run_started":
    case "run_named":
    case "run_ended":
      body = p("M4 13.5V2.5M4 3h7.5l-1.5 2.5L11.5 8H4");
      break;
    case "worker_state":
      body = p("M1.5 8h3l2-4.5 3 9 2-4.5h3");
      break;
    case "spawn_refused":
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" />
          {p("M4.2 11.8l7.6-7.6")}
        </>
      );
      break;
    default:
      body = <circle cx="8" cy="8" r="2" />;
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {body}
    </svg>
  );
}

const NODE_REF = /\b((?:terminal|browser|note|pin|task):[A-Za-z0-9_-]+)/g;

/** Text with node refs as chips, and long URLs as their host. */
function withChips(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(NODE_REF)) {
    const at = match.index ?? 0;
    if (at > last) out.push(...withHosts(text.slice(last, at), out.length));
    out.push(<NodeChip key={`n${out.length}`} nodeRef={match[1]} />);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(...withHosts(text.slice(last), out.length));
  return out;
}

function withHosts(text: string, offset: number): ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) => {
    if (!/^https?:\/\//.test(part)) return part;
    let host = part;
    try {
      const u = new URL(part);
      host = u.host.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "");
    } catch {
      // Not a URL after all: shown as written.
    }
    return (
      <span key={`u${offset + i}`} className="text-[var(--text-secondary)] underline decoration-[var(--border-hover)] underline-offset-2" title={part}>
        {host}
      </span>
    );
  });
}

/**
 * The record's sentence, reworded where it reads like a log: "used navigate
 * on browser:x via managed — https://…" becomes "went to google.com in x".
 */
function sentence(entry: CaptureEntryView): string {
  if (entry.kind === "browser_action") {
    const m = /^(used|failed) (\S+) on (\S+) via \S+(?: — (\S+))?(?: — (.*))?$/.exec(entry.summary);
    if (m) {
      const [, outcome, action, node, url, error] = m;
      const verb = action === "navigate" ? "went to" : action === "back" ? "went back" : action === "forward" ? "went forward" : action === "reload" ? "reloaded" : `${action}`;
      const where = url && action === "navigate" ? `${verb} ${url} in ${node}` : `${verb} ${node}${url ? ` — ${url}` : ""}`;
      return outcome === "failed" ? `couldn't ${where}${error ? ` — ${error}` : ""}` : where;
    }
  }
  if (entry.kind === "topology") return entry.summary.replace(/^canvas: /, "on the canvas: ");
  return entry.summary;
}

export function ActivityRow({ entry, time, isLast }: { entry: CaptureEntryView; time: string; isLast: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const color = KIND_COLOR[entry.kind] ?? "var(--text-muted)";
  const decision = entry.intent === "decision";
  const isPrompt = entry.kind === "prompt";
  const label = kindLabel(entry.kind, t);
  const long = isPrompt && entry.summary.length > 120;

  return (
    <div className="group relative flex gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-[color-mix(in_srgb,var(--surface-hover)_60%,transparent)]">
      {/* The timeline: the line through every row, and this row's mark on it. */}
      {!isLast && <span aria-hidden="true" className="absolute bottom-[-6px] left-[17.5px] top-[26px] w-px bg-[var(--border)]" />}
      <span
        className="relative mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
        style={{
          color,
          background: `color-mix(in srgb, ${color} ${decision ? 18 : 10}%, var(--surface))`,
          boxShadow: decision ? `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)` : undefined,
        }}
        title={label}
      >
        <KindGlyph kind={entry.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium" style={{ color }}>
            {label}
          </span>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{time}</span>
        </div>
        {isPrompt ? (
          <div className="mt-0.5">
            {entry.nodes[0] && (
              <div className="mb-1 text-[11px] text-[var(--text-muted)]">
                {t.activity_prompt_to} <NodeChip nodeRef={entry.nodes[0]} />
              </div>
            )}
            <div
              className={`rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_40%,transparent)] px-2 py-1.5 text-[12px] leading-[1.5] text-[var(--text-primary)] ${long && !open ? "line-clamp-2" : ""}`}
            >
              {entry.summary}
            </div>
            {long && (
              <button type="button" className="mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setOpen((v) => !v)}>
                {open ? t.activity_less : t.activity_more}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-0.5 break-words text-[12px] leading-[1.55] text-[var(--text-primary)]">{withChips(sentence(entry))}</div>
        )}
      </div>
    </div>
  );
}

export function kindLabel(kind: string, t: Dict): string {
  const key = `activity_kind_${kind}` as keyof typeof t;
  const label = t[key];
  return typeof label === "string" ? label : kind;
}

/** A node the record names: its icon and name, and a click that flies to it. */
function NodeChip({ nodeRef }: { nodeRef: string }) {
  const t = useT();
  const [kind, id] = [nodeRef.slice(0, nodeRef.indexOf(":")), nodeRef.slice(nodeRef.indexOf(":") + 1)];
  const terminal = useProjectStore((s) => {
    if (kind !== "terminal") return null;
    for (const p of s.projects) for (const w of p.worktrees) for (const term of w.terminals) if (term.id === id) return term;
    return null;
  });
  const browser = useBrowserCardStore((s) => (kind === "browser" ? (s.cards[id] ?? null) : null));
  const pin = usePinStore((s) => {
    if (kind !== "note" && kind !== "pin" && kind !== "task") return null;
    for (const list of Object.values(s.pinsByProject)) {
      const found = list.find((p) => p.id === id);
      if (found) return found;
    }
    return null;
  });

  let icon: ReactNode = null;
  let name: string;
  let go: (() => void) | null = null;
  if (terminal) {
    const isAgent = findAgentAdapter(terminal.type) !== null;
    icon = isAgent ? <img src={agentIcon(terminal.type)} alt="" className="h-3 w-3 object-contain" draggable={false} /> : <ShellGlyph />;
    name = terminal.customTitle?.trim() || terminal.title || (findAgentAdapter(terminal.type)?.displayName ?? terminal.type);
    go = () => panToTerminal(terminal.id);
  } else if (browser) {
    icon = <BrowserTabIcon cardId={browser.id} favicon={browser.favicon} size={12} />;
    name = browser.title || hostOf(browser.url);
    go = () => flyToBounds(browser.x, browser.y, browser.w, browser.h);
  } else if (pin) {
    icon = <PinGlyph />;
    name = pin.title || t.task_untitled;
    if (pin.x != null && pin.y != null) go = () => flyToBounds(pin.x!, pin.y!, pin.w ?? 300, pin.h ?? 240);
  } else {
    name = kind === "terminal" ? t.activity_closed_terminal : kind === "browser" ? t.activity_closed_browser : t.activity_closed_node;
  }

  const cls =
    "mx-0.5 inline-flex max-w-[200px] items-center gap-1 rounded-[5px] border border-[var(--border)] bg-[var(--surface)] px-1.5 py-[1px] align-[-2px] text-[11px] text-[var(--text-primary)]";
  if (!go) {
    return (
      <span className={`${cls} text-[var(--text-muted)]`} title={nodeRef}>
        {icon}
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <button type="button" className={`${cls} hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]`} title={t.activity_show_node(name)} onClick={go}>
      {icon}
      <span className="truncate">{name}</span>
    </button>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ShellGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l2 1.5L5 10M8.5 10.5h2.5" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 2.5h9v11l-4.5-3-4.5 3z" />
    </svg>
  );
}
