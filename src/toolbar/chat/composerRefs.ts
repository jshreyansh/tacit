import type { TerminalType } from "../../types";
import { filterSlashCommands, type SlashCommand } from "../../terminal/slashCommands";

/**
 * What a message can point at, from the workdesk: a chat or terminal, a
 * page open in a browser, a file on the canvas, a task. Picked from the
 * input's + menu ("From the workdesk") or by typing @.
 *
 * A file goes with the message as an attachment; everything else is
 * written into the text in words the agent can act on (an agent's chat by
 * its name, a page by its address, a task by its title), since the manager
 * can look any of them up by those.
 */
export type WorkdeskRefKind = "chat" | "terminal" | "page" | "file" | "task";

export interface WorkdeskRef {
  key: string;
  kind: WorkdeskRefKind;
  label: string;
  /** Where it is: its folder, or the page's address. */
  detail: string;
  /** Text put in the message for it, or a path attached instead. */
  insert: { text: string } | { path: string };
}

export interface WorkdeskRefSources {
  terminals: { id: string; title: string; type: string; folder: string; agent: boolean }[];
  pages: { id: string; title: string; url: string }[];
  files: { id: string; path: string }[];
  tasks: { id: string; title: string; folder: string }[];
}

const quoteName = (name: string) => (/[\s"]/.test(name) ? `@"${name.replace(/"/g, '\\"')}"` : `@${name}`);

export function workdeskRefs(sources: WorkdeskRefSources): WorkdeskRef[] {
  return [
    ...sources.terminals.map((term): WorkdeskRef => ({
      key: `terminal:${term.id}`,
      kind: term.agent ? "chat" : "terminal",
      label: term.title,
      detail: term.folder,
      insert: { text: quoteName(term.title) },
    })),
    ...sources.pages.map((page): WorkdeskRef => ({
      key: `page:${page.id}`,
      kind: "page",
      label: page.title || page.url,
      detail: page.url,
      insert: { text: page.url },
    })),
    ...sources.files.map((file): WorkdeskRef => ({
      key: `file:${file.id}`,
      kind: "file",
      label: file.path.split(/[\\/]/).pop() ?? file.path,
      detail: file.path,
      insert: { path: file.path },
    })),
    ...sources.tasks.map((task): WorkdeskRef => ({
      key: `task:${task.id}`,
      kind: "task",
      label: task.title,
      detail: task.folder,
      insert: { text: `the task "${task.title}"` },
    })),
  ];
}

/** Refs whose name or place contains every word typed, any case. */
export function filterRefs(refs: readonly WorkdeskRef[], query: string, limit = 8): WorkdeskRef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length === 0 ? refs : refs.filter((r) => words.every((w) => `${r.label} ${r.detail}`.toLowerCase().includes(w)));
  return hits.slice(0, limit);
}

/**
 * What's being typed at the caret that opens a suggestion: `@name` after a
 * space or at the start (a mention), or `/cmd` as the message's first word
 * (a command). Null when neither.
 */
export function triggerAt(text: string, caret: number): { kind: "mention" | "command"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) return { kind: "mention", query: mention[2], start: caret - mention[2].length - 1 };
  const command = /^\/(\S*)$/.exec(before);
  if (command) return { kind: "command", query: command[1], start: 0 };
  return null;
}

/** The text with the trigger (from `start` to the caret) replaced. */
export function replaceTrigger(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

/**
 * Commands a chat can take. A chat runs the agent through its SDK, where
 * only some of the terminal's commands work: the ones that are prompts or
 * act on the conversation. The rest (/model, /login, /vim…) belong to the
 * terminal, and the chat's own chips cover model and mode.
 */
const CHAT_COMMANDS: Partial<Record<TerminalType, readonly string[]>> = {
  claude: ["/compact", "/clear", "/init", "/review"],
  codex: ["/compact"],
};

export function chatCommands(agent: string, query: string): SlashCommand[] {
  const allowed = CHAT_COMMANDS[agent as TerminalType];
  if (!allowed) return [];
  return filterSlashCommands(agent as TerminalType, query).filter((c) => allowed.includes(c.command));
}
