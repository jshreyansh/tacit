import { create } from "zustand";
import { MAX_AUTOMATIC_HOPS, envelopePreview, stepFromMessage } from "../../shared/wire-envelope";
import { RULE_TRIGGERS, consoleErrorsText, ruleWords, withinHourlyLimit, type RuleTrigger, type WireRule } from "../../shared/wire-rules";
import { resolveConnectionType } from "../../shared/connection-types";
import { useConnectionStore, type ConnectionData, type ConnectionEndpoint } from "../stores/connectionStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePinStore } from "../stores/pinStore";
import { useBridgeActivityStore } from "../stores/bridgeActivityStore";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { setRuleAlwaysInScene } from "../actions/sceneConnectionActions";
import { endpointRole, nodeTitle } from "./wireEnds";

/**
 * Runs the rules on wires (shared/wire-rules.ts) when their events happen.
 *
 * Every firing goes through three checks before anything is sent:
 *  - consent: a rule set to "ask" puts a prompt on screen (Run once,
 *    Always, Skip) and waits; the decision of 2026-10-28;
 *  - its hourly limit;
 *  - the hop limit: a delivery made by a rule counts one hop on top of the
 *    message that caused it, so two agents passing replies back and forth
 *    stop after MAX_AUTOMATIC_HOPS and the user is told.
 */

// ------------------------------------------------------------- consent

export interface RulePrompt {
  key: string;
  wireId: string;
  ruleId: string;
  sentence: string;
  preview: string;
  decide: (choice: "once" | "always" | "skip") => void;
}

interface RulePromptStore {
  prompts: RulePrompt[];
  push: (prompt: RulePrompt) => void;
  remove: (key: string) => void;
}

export const useRulePromptStore = create<RulePromptStore>((set) => ({
  prompts: [],
  push: (prompt) => set((state) => ({ prompts: [...state.prompts, prompt] })),
  remove: (key) => set((state) => ({ prompts: state.prompts.filter((p) => p.key !== key) })),
}));

function askConsent(wire: ConnectionData, rule: WireRule, sentence: string, preview: string): Promise<boolean> {
  return new Promise((resolve) => {
    const key = crypto.randomUUID();
    useRulePromptStore.getState().push({
      key,
      wireId: wire.id,
      ruleId: rule.id,
      sentence,
      preview,
      decide: (choice) => {
        useRulePromptStore.getState().remove(key);
        if (choice === "always") setRuleAlwaysInScene(wire.id, rule.id);
        resolve(choice !== "skip");
      },
    });
  });
}

// ------------------------------------------------------------- limits

const firedAt = new Map<string, number[]>();
/** The hop count of the last message a rule delivered into each terminal. */
const hopInto = new Map<string, number>();

function name(endpoint: ConnectionEndpoint): string {
  return nodeTitle(endpoint.kind, endpoint.id) ?? endpoint.id;
}

function notify(type: "warn" | "info", message: string): void {
  useNotificationStore.getState().notify(type, message);
}

// ------------------------------------------------------------- firing

function rulesFor(endpoint: ConnectionEndpoint, when: RuleTrigger): Array<{ wire: ConnectionData; rule: WireRule }> {
  const out: Array<{ wire: ConnectionData; rule: WireRule }> = [];
  for (const wire of Object.values(useConnectionStore.getState().connections)) {
    if (!wire.rules?.length || resolveConnectionType(wire) === "relates-to") continue;
    for (const rule of wire.rules) {
      if (rule.when !== when) continue;
      const at = rule.at === "from" ? wire.from : wire.to;
      if (at.kind === endpoint.kind && at.id === endpoint.id) out.push({ wire, rule });
    }
  }
  return out;
}

export function hasRules(endpoint: ConnectionEndpoint, when: RuleTrigger): boolean {
  return rulesFor(endpoint, when).length > 0;
}

async function fire(wire: ConnectionData, rule: WireRule, body: string, hop: number): Promise<void> {
  const source = rule.at === "from" ? wire.from : wire.to;
  const target = rule.at === "from" ? wire.to : wire.from;
  const sentence = ruleWords(rule, name(source), name(target));

  if (hop > MAX_AUTOMATIC_HOPS) {
    notify(
      "info",
      `Stopped a chain of automatic messages after ${MAX_AUTOMATIC_HOPS}: the rule "${sentence}" didn't run. Send something yourself to carry on.`,
    );
    return;
  }
  const now = Date.now();
  const history = firedAt.get(rule.id) ?? [];
  if (!withinHourlyLimit(history, now, rule.perHour)) {
    notify("warn", `The rule "${sentence}" has run ${rule.perHour} times in the last hour, its limit; it didn't run this time.`);
    return;
  }
  if (rule.consent === "ask") {
    const go = await askConsent(wire, rule, sentence, envelopePreview(body, 120));
    if (!go) return;
  }
  firedAt.set(rule.id, [...history.filter((t) => now - t < 3_600_000), now]);

  const requestId = crypto.randomUUID();
  const activity = useBridgeActivityStore.getState();
  activity.startConnectionEvent(requestId, "message", source, target, envelopePreview(body));
  const ok = await deliver(source, target, rule.when, body, hop);
  activity.endConnectionEvent(requestId, source, target, ok);
}

async function deliver(
  source: ConnectionEndpoint,
  target: ConnectionEndpoint,
  when: RuleTrigger,
  body: string,
  hop: number,
): Promise<boolean> {
  const targetRole = endpointRole(target);
  const sentence = `${name(source)} → ${name(target)}`;
  if (targetRole === "task") {
    const pin = Object.values(usePinStore.getState().pinsByProject).flat().find((p) => p.id === target.id);
    const step = stepFromMessage(body);
    if (!pin || !step) return false;
    try {
      const updated = await window.tacit.pins.update(pin.repo, pin.id, {
        steps: [...(pin.steps ?? []), { text: step, status: "done" }],
      });
      if (updated) usePinStore.getState().upsertPin(pin.repo, updated);
      return true;
    } catch (err) {
      notify("warn", `A rule couldn't log in ${name(target)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  const found = findTerminal(target.id);
  const ptyId = getLivePtyId(target.id);
  if (!found || ptyId == null) {
    notify("warn", `A rule (${sentence}) didn't run: ${name(target)} isn't running.`);
    return false;
  }
  const result = await window.tacit.wires.sendToTerminal({
    target: { terminalId: target.id, ptyId, terminalType: found.terminal.type, worktreePath: found.worktree.path },
    envelope: {
      from: { kind: source.kind, id: source.id, title: name(source), role: endpointRole(source) },
      payload: RULE_TRIGGERS[when].payload,
      body,
    },
  });
  if (!result.ok) {
    notify("warn", `A rule (${sentence}) didn't run: ${result.detail ?? "the terminal didn't take it"}.`);
    return false;
  }
  hopInto.set(target.id, hop);
  return true;
}

/**
 * An agent finished a turn with this reply (src/browser/chatReplyDelivery.ts
 * calls this once the reply is read). Its hop is one more than the message
 * a rule last delivered into it, which that turn was answering.
 */
export async function agentTurnFinished(terminalId: string, reply: string): Promise<void> {
  const endpoint = { kind: "terminal" as const, id: terminalId };
  const hop = (hopInto.get(terminalId) ?? 0) + 1;
  hopInto.delete(terminalId);
  for (const { wire, rule } of rulesFor(endpoint, "turn_finished")) {
    await fire(wire, rule, reply, hop);
  }
}

// Console errors arrive in bursts (one failure, ten lines); they are gathered
// for a moment and sent as one message.
const CONSOLE_GATHER_MS = 3_000;
const consoleBuffers = new Map<string, { errors: string[]; timer: ReturnType<typeof setTimeout> }>();

/** A browser card logged an error (src/components/BrowserCard.tsx). */
export function browserConsoleError(browserId: string, message: string): void {
  const endpoint = { kind: "browser" as const, id: browserId };
  if (!hasRules(endpoint, "console_error")) return;
  const existing = consoleBuffers.get(browserId);
  if (existing) {
    existing.errors.push(message);
    return;
  }
  const entry = {
    errors: [message],
    timer: setTimeout(() => {
      consoleBuffers.delete(browserId);
      for (const { wire, rule } of rulesFor(endpoint, "console_error")) {
        // A page's error isn't caused by a message along a wire: hop 1.
        void fire(wire, rule, consoleErrorsText(entry.errors), 1);
      }
    }, CONSOLE_GATHER_MS),
  };
  consoleBuffers.set(browserId, entry);
}
