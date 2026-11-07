import { useMemo } from "react";
import type { TerminalData } from "../types";
import { usePreferencesStore } from "../stores/preferencesStore";
import { getTerminalLaunchOptions } from "./cliConfig";
import { bypassFlags } from "./agentApprovals";

/**
 * The flags this terminal's agent runs with that switch its approvals off
 * (T15.1), read from the arguments its launch is built with, including
 * the person's own command override. Empty when it asks as usual.
 */
export function useBypassFlags(terminal: Pick<TerminalData, "type" | "sessionId" | "autoApprove">): string[] {
  const override = usePreferencesStore((s) => s.cliCommands[terminal.type]);
  return useMemo(() => {
    const launch = getTerminalLaunchOptions(terminal.type, terminal.sessionId, terminal.autoApprove, override);
    return launch ? bypassFlags(launch.args) : [];
  }, [terminal.type, terminal.sessionId, terminal.autoApprove, override]);
}
