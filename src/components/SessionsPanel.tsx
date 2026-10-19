import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/useT";
import { panToTerminal } from "../utils/panToTerminal";
import {
  type CanvasTerminalItem,
  type CanvasTerminalState,
  type StashedTerminalItem,
} from "./sessionPanelModel";
import {
  closeTerminalInScene,
  stashTerminalInScene,
  unstashTerminalInScene,
  destroyStashedTerminalInScene,
} from "../actions/terminalSceneActions";
import {
  attachTerminalContainer,
  detachTerminalContainer,
  fitTerminalRuntime,
  getTerminalPtyId,
  getTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { IconButton } from "./ui/IconButton";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

const STASHED_PREVIEW_WIDTH = 560;
const STASHED_PREVIEW_HEIGHT = 360;
const STASHED_PREVIEW_MARGIN = 8;
const STASHED_PREVIEW_HIDE_DELAY_MS = 180;

// Three signal levels:
//   red  = needs your attention (real error / explicit awaiting input)
//   green = working, no need to look
//   gray = nothing to convey (done & viewed, or never started)
// `unseenDone` is layered on top at render time using --accent.
const STATUS_COLORS: Record<CanvasTerminalState, string> = {
  attention: "var(--red)",
  active: "var(--green)",
  done: "var(--text-muted)",
  idle: "var(--text-muted)",
};

function formatShortAge(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatItemTime(item: CanvasTerminalItem): string {
  const isActive = item.state === "active" || item.state === "attention";
  if (isActive && item.turnStartedAt) {
    return formatShortAge(item.turnStartedAt);
  }
  return formatShortAge(item.activityAt);
}

function summarizeToolName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";

  const tokens = normalized.split(/\s+/);
  const primary = tokens[0]?.split("/").pop() ?? normalized;
  if (primary === "node" && tokens[1]) {
    const child = tokens[1].split("/").pop() ?? tokens[1];
    if (child === "npm" || child === "npx") return child;
    if (child.endsWith(".js")) return child.replace(/\.js$/, "");
    return child;
  }
  return primary;
}

function formatTerminalActivity(
  item: CanvasTerminalItem,
  t: ReturnType<typeof useT>,
): string {
  switch (item.state) {
    case "attention": {
      if (item.attentionReason === "awaiting_input") {
        const tool = item.currentTool
          ? summarizeToolName(item.currentTool)
          : "";
        return tool
          ? `${t.sessions_status_awaiting_input} · ${tool}`
          : t.sessions_status_awaiting_input;
      }
      return t.sessions_status_attention;
    }
    case "active": {
      const tool = item.currentTool ? summarizeToolName(item.currentTool) : "";
      return tool
        ? `${t.sessions_status_active} · ${tool}`
        : t.sessions_status_active;
    }
    case "done":
      return t.sessions_status_turn_complete;
    default:
      return t.sessions_status_idle;
  }
}

export function TerminalCard({
  item,
  t,
  hideLocation = false,
  unseenDone = false,
  onOpen,
}: {
  item: CanvasTerminalItem;
  t: ReturnType<typeof useT>;
  hideLocation?: boolean;
  unseenDone?: boolean;
  /** What a click does; showing the terminal on the canvas unless given. */
  onOpen?: () => void;
}) {
  const open = onOpen ?? (() => panToTerminal(item.terminalId));
  const subtitleParts = [
    !hideLocation && item.locationLabel && item.locationLabel !== item.title
      ? item.locationLabel
      : null,
    formatTerminalActivity(item, t),
    formatItemTime(item),
  ].filter(Boolean);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`tc-row-icon group w-full rounded-md flex items-center gap-2 text-left cursor-pointer min-h-[44px] px-2 py-1.5 ${
        item.focused
          ? "bg-[var(--surface-hover)] ring-1 ring-[var(--accent)]/35"
          : "bg-[var(--surface)] hover:bg-[var(--sidebar-hover)]"
      }`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{
          backgroundColor: unseenDone
            ? "var(--accent)"
            : STATUS_COLORS[item.state],
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="truncate"
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-regular)",
            color: "var(--text-primary)",
            lineHeight: "var(--leading-snug)",
          }}
        >
          {item.title}
        </div>
        <div
          className="tc-caption truncate"
          style={{ color: "var(--text-muted)" }}
        >
          {subtitleParts.join(" · ")}
        </div>
      </div>
      <IconButton
        size="sm"
        tone="neutral"
        label={t.stash_terminal}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          stashTerminalInScene(
            item.projectId,
            item.worktreeId,
            item.terminalId,
          );
        }}
      >
        {/* archive: arrow down into tray */}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M5 1v5M5 6L3 4M5 6l2-2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M1 6h2v2a1 1 0 001 1h2a1 1 0 001-1V6h2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
      <IconButton
        size="sm"
        tone="danger"
        label={t.panel_close_terminal}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminalInScene(
            item.projectId,
            item.worktreeId,
            item.terminalId,
          );
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 2L8 8M8 2L2 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>
    </div>
  );
}

function StashedCard({
  item,
  t,
}: {
  item: StashedTerminalItem;
  t: ReturnType<typeof useT>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPreview = useCallback(() => {
    clearCloseTimer();
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchorRect(rect);
      setPreviewOpen(true);
    }
  }, [clearCloseTimer]);

  const scheduleClosePreview = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setPreviewOpen(false);
    }, STASHED_PREVIEW_HIDE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return (
    <div
      ref={rowRef}
      className="tc-row-icon group min-h-[44px] flex items-center gap-2 rounded-md px-2 py-1.5 bg-[var(--surface)] hover:bg-[var(--sidebar-hover)]"
      onMouseEnter={openPreview}
      onMouseLeave={scheduleClosePreview}
      onFocus={openPreview}
      onBlur={scheduleClosePreview}
    >
      <div className="flex-1 min-w-0">
        <div
          className="truncate"
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-regular)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-snug)",
          }}
        >
          {item.title}
        </div>
        <div className="tc-caption truncate">{item.originLabel}</div>
      </div>
      <IconButton
        size="sm"
        tone="neutral"
        label={t.stash_restore}
        onClick={() => {
          setPreviewOpen(false);
          unstashTerminalInScene(item.terminalId);
        }}
      >
        {/* unarchive: arrow up out of tray */}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M5 6V1M5 1L3 3M5 1l2 2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M1 6h2v2a1 1 0 001 1h2a1 1 0 001-1V6h2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
      <IconButton
        size="sm"
        tone="danger"
        label={t.stash_destroy}
        onClick={() => {
          setPreviewOpen(false);
          setConfirmOpen(true);
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 2L8 8M8 2L2 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>
      <ConfirmDialog
        open={confirmOpen}
        title={t.stash_destroy}
        body={item.title}
        confirmLabel={t.stash_destroy}
        confirmTone="danger"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          destroyStashedTerminalInScene(item.terminalId);
          setConfirmOpen(false);
        }}
      />
      {previewOpen &&
        anchorRect &&
        createPortal(
          <StashedTerminalPreview
            item={item}
            anchorRect={anchorRect}
            t={t}
            onMouseEnter={openPreview}
            onMouseLeave={scheduleClosePreview}
          />,
          document.body,
        )}
    </div>
  );
}

function getStashedPreviewStyle(anchorRect: DOMRect): CSSProperties {
  const viewportWidth =
    typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? 800 : window.innerHeight;

  const leftCandidate = anchorRect.right + STASHED_PREVIEW_MARGIN;
  const left = Math.min(
    Math.max(STASHED_PREVIEW_MARGIN, leftCandidate),
    Math.max(
      STASHED_PREVIEW_MARGIN,
      viewportWidth - STASHED_PREVIEW_WIDTH - STASHED_PREVIEW_MARGIN,
    ),
  );
  const top = Math.min(
    Math.max(STASHED_PREVIEW_MARGIN, anchorRect.top - 8),
    Math.max(
      STASHED_PREVIEW_MARGIN,
      viewportHeight - STASHED_PREVIEW_HEIGHT - STASHED_PREVIEW_MARGIN,
    ),
  );

  return {
    left,
    top,
    width: STASHED_PREVIEW_WIDTH,
    height: STASHED_PREVIEW_HEIGHT,
  };
}

function StashedTerminalPreview({
  item,
  anchorRect,
  t,
  onMouseEnter,
  onMouseLeave,
}: {
  item: StashedTerminalItem;
  anchorRect: DOMRect;
  t: ReturnType<typeof useT>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const hasRuntime = getTerminalRuntime(item.terminalId) !== null;
  const ptyId = getTerminalPtyId(item.terminalId) ?? item.ptyId;
  const style = getStashedPreviewStyle(anchorRect);

  useLayoutEffect(() => {
    if (!containerEl || !hasRuntime) {
      return;
    }

    attachTerminalContainer(item.terminalId, containerEl);
    const fit = () => fitTerminalRuntime(item.terminalId);
    const frame = window.requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(containerEl);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      if (containerEl.querySelector(".tc-xterm-host")) {
        detachTerminalContainer(item.terminalId, {
          caller: "StashedTerminalPreview",
          reason: "stashed_terminal_preview_unmount",
        });
      }
    };
  }, [containerEl, hasRuntime, item.terminalId]);

  const focusTerminal = useCallback(() => {
    getTerminalRuntime(item.terminalId)?.xterm?.focus();
  }, [item.terminalId]);

  return (
    <div
      className="fixed z-[80] flex flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-[0_18px_50px_-18px_color-mix(in_srgb,var(--shadow-color)_70%,transparent)]"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={focusTerminal}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {item.title}
          </div>
        </div>
        <span
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] tc-mono"
          style={{
            color:
              ptyId === null ? "var(--text-faint)" : "var(--text-secondary)",
            backgroundColor: "var(--surface-hover)",
          }}
        >
          {ptyId === null ? t.stash_preview_stopped : item.type}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 bg-[var(--bg)]">
        {hasRuntime ? (
          <div
            ref={setContainerEl}
            className="absolute inset-0 nopan nodrag nowheel"
            style={{ overflow: "hidden" }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--text-muted)]">
            {t.stash_preview_unavailable}
          </div>
        )}
      </div>
    </div>
  );
}

export function StashedSection({
  items,
  t,
}: {
  items: StashedTerminalItem[];
  t: ReturnType<typeof useT>;
}) {
  const [expanded, setExpanded] = useState(items.length > 0);
  const prevCount = useRef(items.length);

  useEffect(() => {
    if (prevCount.current === 0 && items.length > 0) {
      setExpanded(true);
    }
    prevCount.current = items.length;
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="border-t border-[var(--border)]"
    >
      <CollapsibleTrigger className="tc-row-hover mx-2 flex min-h-[30px] items-center gap-1.5 rounded-md px-3 py-0 text-left">
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={`shrink-0 ${expanded ? "rotate-90" : ""}`}
          style={{
            color: "var(--text-muted)",
            transition: "transform var(--duration-quick) var(--ease-out-soft)",
          }}
        >
          <path d="M3 2l4 3-4 3V2z" fill="currentColor" />
        </svg>
        <span className="tc-eyebrow tc-mono">{t.stash_box}</span>
        <span
          className="tc-eyebrow tc-mono ml-auto tabular-nums"
          style={{ color: "var(--text-faint)" }}
        >
          {items.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2 flex flex-col gap-0.5 px-2">
          {items.map((item) => (
            <StashedCard key={item.terminalId} item={item} t={t} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const HIDDEN_HISTORY_STORAGE_KEY = "tacit:history:hidden:v1";

export function loadHiddenSessions(): Set<string> {
  if (typeof window === "undefined" || !window.localStorage) return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_HISTORY_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function persistHiddenSessions(hidden: Set<string>): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      HIDDEN_HISTORY_STORAGE_KEY,
      JSON.stringify(Array.from(hidden)),
    );
  } catch {}
}

const PINNED_HISTORY_STORAGE_KEY = "tacit:history:pinned:v1";

export function loadPinnedSessions(): Set<string> {
  if (typeof window === "undefined" || !window.localStorage) return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_HISTORY_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function persistPinnedSessions(pinned: Set<string>): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      PINNED_HISTORY_STORAGE_KEY,
      JSON.stringify(Array.from(pinned)),
    );
  } catch {}
}

