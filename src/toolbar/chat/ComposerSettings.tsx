import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import type { ChatTranscript } from "../../../shared/chat-transcript";
import { configureChat } from "../../actions/managerChatMode";
import { effortLabel, settingsView } from "./composerSettingsModel";
import { UsageMeter } from "./LongRunning";

/**
 * The model, effort and mode for this chat, as small chips under the
 * message box. Each agent says what it offers when it starts (Claude's
 * models and permission modes; Codex's models and approval modes), so the
 * menus list only what that agent takes. A change applies from its next
 * step; Claude switches at once, Codex from the next turn.
 */

type Item = { id: string; label: string; description?: string };

function Chip({ label, title, items, selected, onPick }: { label: string; title: string; items: Item[]; selected: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
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
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        className="tc-rail-btn flex h-7 max-w-[150px] items-center gap-1 px-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{label}</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
          <path d="M4 10l4-4 4 4" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={title} className="tc-float absolute bottom-9 left-0 z-30 w-[250px] p-1.5" style={{ borderRadius: 11 }}>
          <div className="px-2.5 pb-1 pt-0.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-faint)]">{title}</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === selected}
              className="tc-rail-btn flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
              data-on={item.id === selected ? "" : undefined}
              onClick={() => {
                setOpen(false);
                onPick(item.id);
              }}
            >
              <span className="text-[12.5px] text-[var(--text-primary)]">{item.label}</span>
              {item.description && <span className="text-[11px] leading-snug text-[var(--text-muted)]">{item.description}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function ComposerSettings({ terminalId, transcript, agent }: { terminalId: string; transcript: ChatTranscript; agent: string }) {
  const t = useT();
  const view = settingsView(transcript);
  if (!view) return <UsageMeter transcript={transcript} agent={agent} />;
  return (
    <span className="flex min-w-0 items-center">
      {view.models.length > 0 && (
        <Chip
          label={view.model?.label ?? t.chat_settings_model}
          title={t.chat_settings_model}
          items={view.models}
          selected={view.model?.id ?? null}
          onPick={(id) => void configureChat(terminalId, { model: id })}
        />
      )}
      {view.efforts.length > 0 && (
        <Chip
          label={view.effort ? effortLabel(view.effort, t) : t.chat_settings_effort_default}
          title={t.chat_settings_effort}
          items={view.efforts.map((e) => ({ id: e, label: effortLabel(e, t) }))}
          selected={view.effort}
          onPick={(id) => void configureChat(terminalId, { effort: id })}
        />
      )}
      {view.modes.length > 0 && (
        <Chip
          label={view.mode?.label ?? t.chat_settings_mode}
          title={t.chat_settings_mode}
          items={view.modes}
          selected={view.mode?.id ?? null}
          onPick={(id) => void configureChat(terminalId, { mode: id })}
        />
      )}
      <UsageMeter transcript={transcript} agent={agent} />
    </span>
  );
}
