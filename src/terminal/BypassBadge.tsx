import { useT } from "../i18n/useT";
import type { TerminalData } from "../types";
import { useBypassFlags } from "./useBypassFlags";

/**
 * Marks an agent that runs without approvals (T15.1), with the flags that
 * did it on hover. Shows nothing for one that asks as usual.
 */
export function BypassBadge({ terminal }: { terminal: Pick<TerminalData, "type" | "sessionId" | "autoApprove"> }) {
  const t = useT();
  const flags = useBypassFlags(terminal);
  if (flags.length === 0) return null;
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium"
      style={{
        color: "var(--amber)",
        background: "color-mix(in srgb, var(--amber) 12%, transparent)",
        fontFamily: '"Geist Mono", monospace',
      }}
      title={t["agentApproval.badgeHint"](flags.join(" "))}
    >
      {t["agentApproval.badge"]}
    </span>
  );
}
