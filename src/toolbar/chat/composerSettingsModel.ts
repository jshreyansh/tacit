import type { ChatModeOption, ChatModelOption } from "../../../shared/chat-events";
import type { ChatTranscript } from "../../../shared/chat-transcript";

/**
 * What the composer's model, effort and mode chips show: the agent's
 * offer, and the choice in use (its default when nothing's picked). Pure.
 */
export interface SettingsView {
  models: ChatModelOption[];
  model: ChatModelOption | null;
  efforts: string[];
  effort: string | null;
  modes: ChatModeOption[];
  mode: ChatModeOption | null;
}

export function settingsView(t: Pick<ChatTranscript, "capabilities" | "settings">): SettingsView | null {
  if (!t.capabilities) return null;
  const { models, modes } = t.capabilities;
  const model = models.find((m) => m.id === t.settings.model) ?? models.find((m) => m.isDefault) ?? null;
  const efforts = model?.efforts ?? [];
  const effort = t.settings.effort && efforts.includes(t.settings.effort) ? t.settings.effort : (model?.defaultEffort ?? null);
  const mode = modes.find((m) => m.id === t.settings.mode) ?? null;
  return { models, model, efforts, effort, modes, mode };
}

type EffortDict = {
  chat_effort_low: string;
  chat_effort_medium: string;
  chat_effort_high: string;
  chat_effort_xhigh: string;
  chat_effort_max: string;
  chat_effort_minimal: string;
  chat_effort_none: string;
};

export function effortLabel(effort: string, t: EffortDict): string {
  const known: Record<string, string> = {
    none: t.chat_effort_none,
    minimal: t.chat_effort_minimal,
    low: t.chat_effort_low,
    medium: t.chat_effort_medium,
    high: t.chat_effort_high,
    xhigh: t.chat_effort_xhigh,
    max: t.chat_effort_max,
  };
  return known[effort] ?? effort;
}

/** The settings menus' width, when there is room for it. */
export const MENU_WIDTH = 250;

/**
 * The menu's left edge (from the chip's) and width: it opens from the chip
 * and slides left as far as it must to end inside the bounds, narrowing
 * only when the bounds are narrower than the menu.
 */
export function menuPlace(chipLeft: number, bounds: { left: number; right: number }): { left: number; width: number } {
  const width = Math.min(MENU_WIDTH, Math.max(0, bounds.right - bounds.left));
  const start = Math.max(bounds.left, Math.min(chipLeft, bounds.right - width));
  return { left: start - chipLeft, width };
}
