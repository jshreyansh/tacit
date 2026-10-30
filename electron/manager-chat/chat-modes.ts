import fs from "fs";
import path from "path";
import type { ChatAgent } from "./chat-engine";

/**
 * The permission mode last picked for each agent's chats, in one small
 * file, so a new chat (or one after a restart) starts in it instead of the
 * agent's default and doesn't ask for what the person already let it do.
 */
export function chatModeStore(file: string) {
  const read = (): Partial<Record<ChatAgent, string>> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Partial<Record<ChatAgent, string>>) : {};
    } catch {
      return {};
    }
  };
  let kept = read();
  return {
    get: (agent: ChatAgent): string | null => (typeof kept[agent] === "string" ? kept[agent] : null),
    set: (agent: ChatAgent, mode: string): void => {
      if (kept[agent] === mode) return;
      kept = { ...kept, [agent]: mode };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(kept));
      } catch {
        // Not kept for next launch; this chat is in it all the same.
      }
    },
  };
}
