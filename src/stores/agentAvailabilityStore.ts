import { create } from "zustand";
import type { AgentDetection } from "../../shared/agent-adapters";
import { usePreferencesStore } from "./preferencesStore";

/**
 * Which agent CLIs are installed on this machine, for the dock and the
 * workspace-manager roster (detection itself runs in main, see
 * electron/agent-detect.ts).
 *
 * Until detection answers, every agent counts as available: an agent must
 * never be greyed out because a check is slow, only because the check said
 * it is missing.
 */

interface AgentAvailabilityStore {
  byId: Record<string, AgentDetection>;
  load: (refresh?: boolean) => Promise<void>;
}

function commandOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [id, config] of Object.entries(usePreferencesStore.getState().cliCommands)) {
    if (config?.command) overrides[id] = config.command;
  }
  return overrides;
}

export const useAgentAvailabilityStore = create<AgentAvailabilityStore>((set) => ({
  byId: {},
  load: async (refresh = false) => {
    const detect = window.tacit?.agents?.detect;
    if (!detect) return;
    try {
      const results = await detect({ commandOverrides: commandOverrides(), refresh });
      set({ byId: Object.fromEntries(results.map((result) => [result.id, result])) });
    } catch (error) {
      // Leaves every agent offered, per the rule above, but not silently.
      console.error("[agents] detection failed; every agent stays offered:", error);
    }
  },
}));

/** The detection for one agent, or null while unknown. */
export function useAgentDetection(id: string): AgentDetection | null {
  return useAgentAvailabilityStore((state) => state.byId[id] ?? null);
}

/** Loads once, and again whenever the Settings command overrides change. */
export function startAgentAvailability(): () => void {
  void useAgentAvailabilityStore.getState().load();
  return usePreferencesStore.subscribe((state, previous) => {
    if (state.cliCommands !== previous.cliCommands) {
      void useAgentAvailabilityStore.getState().load(true);
    }
  });
}
