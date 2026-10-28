import { useRulePromptStore } from "../canvas/wireRules";
import { useT } from "../i18n/useT";

/**
 * A rule on a wire asking before it runs (src/canvas/wireRules.ts): what it
 * is about to do and the first words of what it would send, with Run once,
 * Always and Skip. Mounted over the whole app, not the canvas, so it shows in
 * the grid as well. One at a time, oldest first.
 */
export function RulePrompts() {
  const t = useT();
  const prompt = useRulePromptStore((s) => s.prompts[0]);
  const waiting = useRulePromptStore((s) => s.prompts.length);
  if (!prompt) return null;
  return (
    <div
      role="alertdialog"
      aria-label={t.rule_prompt_title}
      className="tc-float fixed z-[120] w-[340px] p-3 flex flex-col gap-2"
      style={{
        right: "max(16px, env(safe-area-inset-right, 0px))",
        bottom: 96,
        borderRadius: 10,
        fontFamily: '"Geist Mono", monospace',
      }}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
        {t.rule_prompt_title}
        {waiting > 1 ? ` · ${t.rule_prompt_more.replace("{n}", String(waiting - 1))}` : ""}
      </div>
      <div className="text-[12px] leading-snug text-[var(--text-primary)]">{prompt.sentence}</div>
      {prompt.preview && (
        <div className="text-[11px] leading-snug text-[var(--text-muted)] truncate" title={prompt.preview}>
          “{prompt.preview}”
        </div>
      )}
      <div className="flex gap-1.5 justify-end pt-1">
        <button
          type="button"
          className="px-2 py-1 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => prompt.decide("skip")}
        >
          {t.rule_prompt_skip}
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => prompt.decide("always")}
        >
          {t.rule_prompt_always}
        </button>
        <button
          type="button"
          autoFocus
          className="px-2 py-1 rounded text-[11px] border border-[var(--accent)]/60 text-[var(--accent)] bg-[var(--accent)]/10"
          onClick={() => prompt.decide("once")}
        >
          {t.rule_prompt_once}
        </button>
      </div>
    </div>
  );
}
