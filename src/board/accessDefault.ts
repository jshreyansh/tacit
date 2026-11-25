/** What your new drawings start as for agents: yours, on this Mac. */
import type { BoardAgentAccess } from "../types/board";

const KEY = "tacit.board.agents";

export function agentsDefault(): BoardAgentAccess {
  try {
    const v = localStorage.getItem(KEY);
    return v === "edit" || v === "mine" ? v : "ask";
  } catch {
    return "ask";
  }
}
export function setAgentsDefault(value: BoardAgentAccess): void {
  try {
    localStorage.setItem(KEY, value);
  } catch (err) {
    console.error("[board] couldn't keep the setting:", err);
  }
}
