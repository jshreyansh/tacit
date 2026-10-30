import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n/useT";
import type { ChatTranscript } from "../../../shared/chat-transcript";
import { configureChat } from "../../actions/managerChatMode";
import claudeModelIcon from "../../assets/model-icons/claude.png";
import openaiModelIcon from "../../assets/model-icons/openai.png";
import { AGENT_ICON } from "../agentIcons";
import { MENU_WIDTH, effortLabel, menuPlace, settingsView } from "./composerSettingsModel";

/**
 * The model, effort and mode for this chat, as small chips under the
 * message box. Each agent says what it offers when it starts (Claude's
 * models and permission modes; Codex's models and approval modes), so the
 * menus list only what that agent takes. A change applies from its next
 * step; Claude switches at once, Codex from the next turn.
 *
 * A chip shows an icon and a word or two; as the message box narrows the
 * words go (effort and mode first, then the model), so the row never wraps
 * or overflows. The box is the container these sizes are measured against.
 */

type Item = { id: string; label: string; description?: string };

function Chip({
  icon,
  label,
  title,
  items,
  selected,
  onPick,
  hideLabelClass,
  itemIcon,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  items: Item[];
  selected: string | null;
  onPick: (id: string) => void;
  /** The container width under which only the icon shows. */
  hideLabelClass: string;
  /** Shown at the start of each item in the menu: the model chip's provider mark. */
  itemIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Where the menu sits, against the chip: it stays inside the message
  // box, which a narrow chat cuts off at its edge.
  const [place, setPlace] = useState({ left: 0, width: MENU_WIDTH });
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex min-w-0">
      <button
        type="button"
        className="tc-rail-btn flex h-7 min-w-0 items-center gap-1.5 px-1.5 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${title}: ${label}`}
        title={`${title}: ${label}`}
        onClick={() => {
          const chip = ref.current?.getBoundingClientRect();
          const box = ref.current?.closest("[data-composer-box]")?.getBoundingClientRect();
          if (chip) setPlace(menuPlace(chip.left, box ? { left: box.left, right: box.right } : { left: 8, right: window.innerWidth - 8 }));
          setOpen((v) => !v);
        }}
      >
        <span className="flex shrink-0 items-center">{icon}</span>
        <span className={`min-w-0 truncate ${hideLabelClass}`}>{label}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={title}
          className="tc-float absolute bottom-9 z-30 max-h-[min(360px,60vh)] overflow-y-auto p-1.5"
          style={{ borderRadius: 11, left: place.left, width: place.width }}
        >
          <div className="px-2.5 pb-1 pt-0.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-faint)]">{title}</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === selected}
              className="tc-rail-btn flex w-full items-start gap-2 px-2.5 py-1.5 text-left"
              data-on={item.id === selected ? "" : undefined}
              onClick={() => {
                setOpen(false);
                onPick(item.id);
              }}
            >
              {/* Level with the name's line. */}
              {itemIcon && <span className="mt-[3px] flex shrink-0 items-center">{itemIcon}</span>}
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="text-[12.5px] text-[var(--text-primary)]">{item.label}</span>
                {item.description && <span className="text-[11px] leading-snug text-[var(--text-muted)]">{item.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * Whose models the chip picks from: Claude's for Claude Code, ChatGPT's for
 * Codex, OpenCode's own mark for OpenCode. The agents' own marks stay as
 * they are elsewhere; this says where the model comes from.
 */
const MODEL_ICON: Record<string, string> = { claude: claudeModelIcon, codex: openaiModelIcon, opencode: AGENT_ICON.opencode };

function ModelIcon({ agent }: { agent?: string }) {
  const src = agent ? MODEL_ICON[agent] : undefined;
  if (src) return <img src={src} alt="" width={13} height={13} className="h-[13px] w-[13px] shrink-0 object-contain" aria-hidden="true" />;
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.75l1.6 4.65L14.25 8 9.6 9.6 8 14.25 6.4 9.6 1.75 8 6.4 6.4z" />
    </svg>
  );
}

/** Four bars, as many filled as the effort is high; none filled for the agent's own default. */
function EffortIcon({ level }: { level: number }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 3.5}
          y={11 - i * 2.5}
          width="2.4"
          height={3.5 + i * 2.5}
          rx="0.8"
          fill="currentColor"
          opacity={i < level ? 1 : 0.32}
        />
      ))}
    </svg>
  );
}

function ModeIcon({ mode }: { mode: string | null }) {
  const common = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (mode) {
    case "plan":
      return (
        <svg {...common}>
          <path d="M5.5 4h7.5M5.5 8h7.5M5.5 12h7.5M2.5 4h.5M2.5 8h.5M2.5 12h.5" />
        </svg>
      );
    case "acceptEdits":
      return (
        <svg {...common}>
          <path d="M3 13h3l7-7-3-3-7 7z" />
        </svg>
      );
    case "auto":
      return (
        <svg {...common}>
          <path d="M9 1.75L3.5 9h4l-1 5.25L12.5 7h-4z" />
        </svg>
      );
    case "read-only":
      return (
        <svg {...common}>
          <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
          <circle cx="8" cy="8" r="1.75" />
        </svg>
      );
    case "full-access":
      return (
        <svg {...common}>
          <rect x="3" y="7.25" width="10" height="6.75" rx="1.5" />
          <path d="M5.5 7.25V5a2.5 2.5 0 014.8-1" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 1.75l5.25 2v4c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5v-4z" />
        </svg>
      );
  }
}

export function ComposerSettings({ terminalId, transcript, agent }: { terminalId: string; transcript: ChatTranscript; agent?: string }) {
  const t = useT();
  const view = settingsView(transcript);
  if (!view) return null;
  const effortIndex = view.effort ? view.efforts.indexOf(view.effort) : -1;
  const effortBars = effortIndex < 0 ? 0 : Math.max(1, Math.ceil(((effortIndex + 1) / view.efforts.length) * 4));
  return (
    <span className="flex min-w-0 items-center">
      {view.models.length > 0 && (
        <Chip
          icon={<ModelIcon agent={agent} />}
          itemIcon={agent && MODEL_ICON[agent] ? <ModelIcon agent={agent} /> : undefined}
          label={view.model ? (view.model.short ?? view.model.label) : t.chat_settings_model}
          title={t.chat_settings_model}
          items={view.models}
          selected={view.model?.id ?? null}
          onPick={(id) => void configureChat(terminalId, { model: id })}
          hideLabelClass="@max-[300px]:hidden"
        />
      )}
      {view.efforts.length > 0 && (
        <Chip
          icon={<EffortIcon level={effortBars} />}
          label={view.effort ? effortLabel(view.effort, t) : t.chat_settings_effort_default}
          title={t.chat_settings_effort}
          items={view.efforts.map((e) => ({ id: e, label: effortLabel(e, t) }))}
          selected={view.effort}
          onPick={(id) => void configureChat(terminalId, { effort: id })}
          hideLabelClass="@max-[400px]:hidden"
        />
      )}
      {view.modes.length > 0 && (
        <Chip
          icon={<ModeIcon mode={view.mode?.id ?? null} />}
          label={view.mode ? (view.mode.short ?? view.mode.label) : t.chat_settings_mode}
          title={t.chat_settings_mode}
          items={view.modes}
          selected={view.mode?.id ?? null}
          onPick={(id) => void configureChat(terminalId, { mode: id })}
          hideLabelClass="@max-[400px]:hidden"
        />
      )}
    </span>
  );
}
