import fs from "fs";
import path from "path";
import type { ChatAgent, ChatLimitEvent } from "./chat-engine";

/**
 * Each agent's last usage-limit reading, in one small file, so a chat
 * opened after a restart shows it before the agent's first turn reports
 * it again. A reading without a percentage keeps the last one's.
 */
export function chatLimitStore(file: string) {
  const read = (): Partial<Record<ChatAgent, ChatLimitEvent>> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Partial<Record<ChatAgent, ChatLimitEvent>>) : {};
    } catch {
      return {};
    }
  };
  let kept = read();
  return {
    get: (agent: ChatAgent): ChatLimitEvent | null => kept[agent] ?? null,
    set: (agent: ChatAgent, limit: ChatLimitEvent): void => {
      const before = kept[agent];
      const sameWindow = before && (!limit.window || before.window === limit.window);
      const next: ChatLimitEvent = sameWindow ? { ...before, ...limit } : limit;
      kept = { ...kept, [agent]: next };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(kept));
      } catch {
        // Not kept for next launch; the chat still shows it now.
      }
    },
  };
}
