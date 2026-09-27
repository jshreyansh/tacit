import type { TerminalType } from "../types";
import shellIcon from "../assets/dock-icons/terminal-shell.png";
import claudeIcon from "../assets/dock-icons/terminal-claude.png";
import codexIcon from "../assets/dock-icons/codex.png";
import geminiIcon from "../assets/dock-icons/gemini.png";
import antigravityIcon from "../assets/dock-icons/antigravity.png";
import opencodeIcon from "../assets/dock-icons/opencode-mark.png";

/**
 * One mark per terminal type, shared by the dock and the manager picker so the
 * two places you pick an agent can't drift apart. Names and which agents
 * exist come from shared/agent-adapters.ts; only the artwork lives here,
 * because it is a renderer asset.
 */
export const AGENT_ICON = {
  shell: shellIcon,
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  antigravity: antigravityIcon,
  opencode: opencodeIcon,
} satisfies Partial<Record<TerminalType, string>>;

/** The mark for any terminal type, or undefined for one without art. */
export function agentIcon(type: string | null | undefined): string | undefined {
  return type ? (AGENT_ICON as Record<string, string>)[type] : undefined;
}
