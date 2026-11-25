import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * What waits on you, wherever it's asked: a question, an approval or a plan in
 * a chat, and everything a task needs from you. One anatomy: a badge, what it
 * is, the content, then the actions, the main one first and the way out last.
 * Colour is in the badge and its label only.
 */
export type AskKind = "question" | "approval" | "plan" | "permission" | "stuck" | "check" | "suggestion";

const COLOR: Record<AskKind, string> = {
  question: "var(--accent)",
  approval: "var(--amber)",
  plan: "var(--cyan)",
  permission: "var(--amber)",
  stuck: "var(--red)",
  check: "var(--git-graph-purple)",
  suggestion: "var(--cyan)",
};

const MARK: Record<AskKind, ReactNode> = {
  question: <path d="M6 6a2 2 0 113 1.7c-.6.4-1 .8-1 1.5V10M8 12.5v.01" />,
  approval: <path d="M8 2l5.5 2.5v3.5c0 3.2-2.4 5.3-5.5 6-3.1-.7-5.5-2.8-5.5-6V4.5z" />,
  plan: <path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01" />,
  permission: <path d="M4.5 7.5V5.5a3.5 3.5 0 017 0v2M3.5 7.5h9v6h-9z" />,
  stuck: <path d="M8 4.5v4.2M8 11.5v.01M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8z" />,
  check: <path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z" />,
  suggestion: <path d="M3 13h3l7-7-3-3-7 7z" />,
};

export function AskBadge({ kind }: { kind: AskKind }) {
  return (
    <span className="tc-sq-sm flex h-6 w-6 shrink-0 items-center justify-center" style={{ background: `color-mix(in srgb, ${COLOR[kind]} 15%, transparent)`, color: COLOR[kind] }}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {MARK[kind]}
      </svg>
    </span>
  );
}

/** Badge, what it is, what it asks; who and how many more on the right. */
export function AskHead({ kind, label, title, meta }: { kind: AskKind; label: ReactNode; title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 px-3 pb-2 pt-3">
      <AskBadge kind={kind} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" style={{ color: kind === "question" ? "var(--text-secondary)" : COLOR[kind] }}>
            {label}
          </span>
          {meta && <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-metadata)]">{meta}</span>}
        </span>
        <span className="text-[13.5px] font-medium leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">{title}</span>
      </span>
    </div>
  );
}

/** The actions, under a line. */
export function AskFoot({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] px-3 py-2.5">{children}</div>;
}

/** The words, command or message it's about, as they are. */
export function AskWords({ children, mono = true }: { children: ReactNode; mono?: boolean }) {
  return (
    <pre
      className={`${mono ? "tc-mono text-[12px]" : "font-[inherit] text-[12.5px] leading-relaxed"} tc-sq-ctl mx-3 mb-1.5 max-h-28 overflow-auto whitespace-pre-wrap bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-2.5 py-2 text-[var(--text-primary)] [overflow-wrap:anywhere]`}
      style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}
    >
      {children}
    </pre>
  );
}

export type AskTone = "primary" | "secondary" | "quiet";
const TONE: Record<AskTone, CSSProperties> = {
  primary: { background: "var(--text-primary)", color: "var(--bg)" },
  secondary: { background: "color-mix(in srgb, var(--text-primary) 8%, transparent)", color: "var(--text-primary)" },
  quiet: {},
};
export const askButtonClass = (tone: AskTone) =>
  `tc-sq-ctl inline-flex h-8 shrink-0 items-center gap-1.5 px-3 text-[12.5px] disabled:opacity-40 ${tone === "primary" ? "font-medium hover:brightness-95" : tone === "secondary" ? "hover:brightness-125" : "text-[var(--text-metadata)] hover:text-[var(--text-primary)]"}`;
export const askButtonStyle = (tone: AskTone) => TONE[tone];

export function AskButton({ tone = "secondary", children, ...rest }: { tone?: AskTone } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`${askButtonClass(tone)} ${rest.className ?? ""}`} style={TONE[tone]}>
      {children}
    </button>
  );
}

/** A line to say something with the answer: what to do instead, what to change. Enter sends; Esc goes back. */
export function AskReply({ placeholder, action, onSend, onBack, required = false, children }: { placeholder: string; action: string; onSend: (words: string) => void; onBack: () => void; required?: boolean; children?: ReactNode }) {
  const [words, setWords] = useState("");
  const ready = !required || words.trim() !== "";
  const send = () => ready && onSend(words.trim());
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] px-3 py-2.5">
      <input
        autoFocus
        value={words}
        maxLength={2000}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => {
          // The canvas listens globally for single-key shortcuts.
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onBack();
          }
        }}
        className="tc-sq-ctl h-8 min-w-[120px] flex-1 bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        style={{ boxShadow: "inset 0 0 0 1px var(--border-hover)" }}
      />
      {children}
      <AskButton tone="primary" disabled={!ready} onClick={send}>
        {action}
      </AskButton>
    </div>
  );
}

export function AskKbd({ children }: { children: ReactNode }) {
  return (
    <span className="tc-ask-kbd tc-mono tc-sq-sm shrink-0 border border-[var(--border)] bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] px-1 text-[10px] leading-[16px] text-[var(--text-muted)]">{children}</span>
  );
}

/** One answer to pick. */
export function AskOption({ multi, checked, label, description, recommended, hotkey, onPick }: { multi: boolean; checked: boolean; label: string; description?: string; recommended?: string; hotkey?: string; onPick: () => void }) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={checked}
      onClick={onPick}
      className="tc-sq-ctl flex min-h-10 w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] text-[var(--text-primary)] transition-colors"
      style={checked ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)" } : { background: "color-mix(in srgb, var(--text-primary) 4%, transparent)" }}
    >
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${multi ? "rounded-[5px]" : "rounded-full"}`}
        style={
          checked
            ? multi
              ? { background: "var(--accent)", color: "var(--accent-foreground)" }
              : { boxShadow: "inset 0 0 0 5px var(--accent)" }
            : { boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--text-primary) 25%, transparent)" }
        }
      >
        {checked && multi && (
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="[overflow-wrap:anywhere]">
          {label}
          {recommended && <span className="ml-2 text-[11.5px] text-[var(--cyan)]">{recommended}</span>}
        </span>
        {description && <span className="text-[11.5px] leading-snug text-[var(--text-metadata)] [overflow-wrap:anywhere]">{description}</span>}
      </span>
      {hotkey && <AskKbd>{hotkey}</AskKbd>}
    </button>
  );
}
