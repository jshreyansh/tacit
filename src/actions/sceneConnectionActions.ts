import {
  connectionsInvolving,
  useConnectionStore,
  type ConnectionData,
  type ConnectionEndpoint,
  type ConnectionOrigin,
} from "../stores/connectionStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStateStore } from "../stores/terminalRuntimeStateStore";
import { findTerminal, getLivePtyId } from "./terminalLookup";
import { captureRef, recordDecision } from "../capture";
import type { CaptureActor } from "../../shared/capture";
import {
  defaultConnectionType,
  isTwoWay,
  resolveConnectionType,
  type ConnectionType,
} from "../../shared/connection-types";
import { wireNoticeText } from "../../shared/wire-notice";
import { abilitiesFor, endpointRole, nodeTitle } from "../canvas/wireEnds";
import { migrateWires } from "../canvas/wireMigration";
import { sendStandingNote } from "../canvas/rereadNotes";
import type { WireRole, WireTracking } from "../../shared/wire-tracking";
import {
  DEFAULT_RULE_PER_HOUR,
  ruleWords,
  type RuleTrigger,
  type WireRule,
} from "../../shared/wire-rules";

interface CreateConnectionOptions {
  origin?: ConnectionOrigin;
  /**
   * Whether to tell the agents at its ends what the wire gives them.
   * Defaults to true for manual wires (the user just did something and the
   * agent should hear about it) and false for spawn wires — see
   * createConnectionInScene.
   */
  announce?: boolean;
  /**
   * Who is wiring these together, for the decision record. Defaults to "user"
   * because the drag-to-connect path is the only caller that passes nothing,
   * and an agent acting through the MCP bridge must say so — conflating the
   * two would make the record useless for reading back intent.
   */
  by?: CaptureActor;
  /**
   * Set false for wires that aren't decisions. Only backfillLineageConnections
   * uses it: recreating a wire from `parentTerminalId` on load is a migration
   * of something already decided, and recording it would write a fresh
   * "decision" into the record on every single app start.
   */
  capture?: boolean;
}

export function createConnectionInScene(
  from: ConnectionEndpoint,
  to: ConnectionEndpoint,
  options: CreateConnectionOptions = {},
): string | null {
  const origin = options.origin ?? "manual";
  // Spawn wires stay silent by default: notifyWireEnds pushes
  // a real auto-submitted turn into the terminal, and firing that while the
  // agent is still inside its own spawn_browser tool call would interrupt
  // the very turn that asked for the browser. The spawn tool's own result
  // text tells the agent it can drive the page instead.
  const announce = options.announce ?? origin === "manual";
  const existing = useConnectionStore.getState().connections;
  const id = useConnectionStore.getState().addConnection(from, to, origin);
  // Stamped so the record says what the pair meant when it was drawn; what
  // the wire allows comes from its ends (shared/node-contracts.ts).
  if (id && !existing[id] && origin === "manual") {
    useConnectionStore.getState().setConnectionType(id, defaultConnectionType(from.kind, to.kind));
  }
  if (id && !existing[id] && announce) void notifyWireEnds(id);
  // addConnection returns the existing id for an already-wired pair, so
  // checking whether the id was already known is what keeps a re-wire of the
  // same pair out of the record — otherwise the idempotent callers would each
  // log a decision that didn't happen.
  if (id && !existing[id] && options.capture !== false) {
    recordDecision({
      kind: "wire",
      from: captureRef(from),
      to: captureRef(to),
      origin,
      by: options.by ?? "user",
      // Resolved rather than read, so a wire that never had a type stamped
      // still records the meaning it actually has.
      connection_type: resolveConnectionType({ from, to }),
    });
  }
  return id;
}

/**
 * Change what a wire means, and record that it changed.
 *
 * Lives here rather than in the store because the store has no business
 * knowing about the record — the same split every other scene action uses.
 * The previous meaning is resolved before the change so the entry says what it
 * was, which is the whole point of recording a retype instead of a rewrite.
 */
export function setConnectionTypeInScene(
  id: string,
  type: ConnectionType,
  customPrompt?: string,
  by: CaptureActor = "user",
): void {
  const existing = useConnectionStore.getState().connections[id];
  if (!existing) return;
  const previous = resolveConnectionType(existing);
  useConnectionStore.getState().setConnectionType(id, type, customPrompt);
  const applied = useConnectionStore.getState().connections[id];
  // The store no-ops when nothing actually changed; recording anyway would
  // put a decision in the log that the user never made.
  if (!applied || resolveConnectionType(applied) === previous) return;
  recordDecision({
    kind: "retype_wire",
    from: captureRef(existing.from),
    to: captureRef(existing.to),
    connection_type: type,
    previous_type: previous,
    by,
  });
}

/** Turn a one-way wire round, so the other end sends. */
export function flipConnectionInScene(id: string, by: CaptureActor = "user"): void {
  const store = useConnectionStore.getState();
  if (!store.connections[id]) return;
  store.flipConnection(id);
  recordRedirect(id, by);
  void notifyWireEnds(id);
}

/** Let both ends send along a wire, or only the end it was drawn from. */
export function setConnectionTwoWayInScene(
  id: string,
  twoWay: boolean,
  by: CaptureActor = "user",
): void {
  const store = useConnectionStore.getState();
  const existing = store.connections[id];
  if (!existing || isTwoWay(existing) === twoWay) return;
  store.setConnectionTwoWay(id, twoWay);
  recordRedirect(id, by);
  // Only the end that gained something hears about it: the head of a wire
  // that just became two-way.
  if (twoWay) void notifyWireEnds(id, existing.to);
}

/**
 * Say what a wire is for. The agent at its tail is told, because the
 * purpose is what tells it when to use the wire.
 */
export function setConnectionPurposeInScene(
  id: string,
  purpose: string | undefined,
  by: CaptureActor = "user",
): void {
  const store = useConnectionStore.getState();
  if (!store.setConnectionPurpose(id, purpose)) return;
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({
    kind: "edit_wire",
    from: captureRef(applied.from),
    to: captureRef(applied.to),
    purpose: applied.purpose ?? "",
    by,
  });
  if (applied.purpose) void notifyWireEnds(id);
}

/** Let the agent only read a wired browser, or drive it again. */
export function setConnectionBrowserAccessInScene(
  id: string,
  access: "read" | "drive",
  by: CaptureActor = "user",
): void {
  const store = useConnectionStore.getState();
  if (!store.setConnectionLimits(id, access === "read" ? { browser: "read" } : undefined)) return;
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({
    kind: "edit_wire",
    from: captureRef(applied.from),
    to: captureRef(applied.to),
    browser_access: access,
    by,
  });
  void notifyWireEnds(id);
}

/**
 * Send a note along by hand, or make it standing context the agent rereads.
 * Switching to Reread sends it at once (src/canvas/rereadNotes.ts keeps it
 * current after that).
 */
export function setConnectionNoteModeInScene(
  id: string,
  mode: "send" | "reread",
  by: CaptureActor = "user",
): void {
  const store = useConnectionStore.getState();
  if (!store.setConnectionNoteMode(id, mode)) return;
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({
    kind: "edit_wire",
    from: captureRef(applied.from),
    to: captureRef(applied.to),
    note_mode: mode,
    by,
  });
  if (mode === "reread") void sendStandingNote(applied);
}

/**
 * Add a rule to a wire: when `when` happens at the `at` end, send to the
 * other end. New rules ask the user before they run (shared/wire-rules.ts).
 */
export function addRuleInScene(
  id: string,
  when: RuleTrigger,
  at: "from" | "to",
  by: CaptureActor = "user",
): void {
  const connection = useConnectionStore.getState().connections[id];
  if (!connection) return;
  const rule: WireRule = { id: crypto.randomUUID(), when, at, consent: "ask", perHour: DEFAULT_RULE_PER_HOUR };
  useConnectionStore.getState().putConnectionRule(id, rule);
  recordRuleChange(connection, rule, "added a rule", by);
}

export function removeRuleInScene(id: string, ruleId: string, by: CaptureActor = "user"): void {
  const connection = useConnectionStore.getState().connections[id];
  const rule = connection?.rules?.find((r) => r.id === ruleId);
  if (!connection || !rule) return;
  if (!useConnectionStore.getState().removeConnectionRule(id, ruleId)) return;
  recordRuleChange(connection, rule, "removed the rule", by);
}

/** The user chose Always on a rule's prompt: it runs without asking now. */
export function setRuleAlwaysInScene(id: string, ruleId: string, by: CaptureActor = "user"): void {
  const connection = useConnectionStore.getState().connections[id];
  const rule = connection?.rules?.find((r) => r.id === ruleId);
  if (!connection || !rule || rule.consent === "always") return;
  useConnectionStore.getState().putConnectionRule(id, { ...rule, consent: "always" });
  recordRuleChange(connection, rule, "let the rule run without asking", by);
}

function recordRuleChange(connection: ConnectionData, rule: WireRule, what: string, by: CaptureActor): void {
  const eventEnd = rule.at === "from" ? connection.from : connection.to;
  const otherEnd = rule.at === "from" ? connection.to : connection.from;
  recordDecision({
    kind: "edit_wire",
    from: captureRef(connection.from),
    to: captureRef(connection.to),
    rule: `${what}: ${ruleWords(rule, nodeTitle(eventEnd.kind, eventEnd.id) ?? eventEnd.id, nodeTitle(otherEnd.kind, otherEnd.id) ?? otherEnd.id)}`,
    by,
  });
}

/** The Hydra tracking switch for hand-offs along a wire. */
export function setConnectionTrackingInScene(id: string, tracking: WireTracking, by: CaptureActor = "user"): void {
  if (!useConnectionStore.getState().setConnectionTracking(id, tracking)) return;
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({ kind: "edit_wire", from: captureRef(applied.from), to: captureRef(applied.to), track: tracking, by });
}

/** The role the agent at the head plays for the one at the tail. */
export function setConnectionRoleInScene(id: string, role: WireRole | null, by: CaptureActor = "user"): void {
  if (!useConnectionStore.getState().setConnectionRole(id, role)) return;
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({ kind: "edit_wire", from: captureRef(applied.from), to: captureRef(applied.to), role: applied.role ?? "", by });
  if (applied.role) void notifyWireEnds(id);
}

/**
 * Make a wire a plain link, which carries nothing, or a live one again.
 * Recorded as a retype, which is what it is in the stored record.
 */
export function setConnectionPlainInScene(
  id: string,
  plain: boolean,
  by: CaptureActor = "user",
): void {
  const existing = useConnectionStore.getState().connections[id];
  if (!existing) return;
  const wasPlain = resolveConnectionType(existing) === "relates-to";
  if (wasPlain === plain) return;
  setConnectionTypeInScene(
    id,
    plain ? "relates-to" : defaultConnectionType(existing.from.kind, existing.to.kind),
    undefined,
    by,
  );
  if (!plain) void notifyWireEnds(id);
}

function recordRedirect(id: string, by: CaptureActor): void {
  const applied = useConnectionStore.getState().connections[id];
  if (!applied) return;
  recordDecision({
    kind: "redirect_wire",
    from: captureRef(applied.from),
    to: captureRef(applied.to),
    two_way: isTwoWay(applied),
    by,
  });
}

/**
 * Wire a freshly-spawned browser to the agent that asked for it, dropping
 * that agent's previous browser wire first.
 *
 * The replace is deliberate rather than additive: getBrowserBindingForTerminal
 * (src/App.tsx) resolves the drivable browser as the *most recently
 * connected* one, so leaving older browsers wired would mean an agent that
 * opened several pages silently drives only the newest while the canvas
 * shows it connected to all of them. Replacing keeps "the agent drives the
 * browser it just opened" true and visible.
 */
export function wireSpawnedBrowser(
  spawnerTerminalId: string,
  browserId: string,
): string | null {
  const { connections } = useConnectionStore.getState();
  for (const connection of connectionsInvolving(
    connections,
    "terminal",
    spawnerTerminalId,
  )) {
    const other =
      connection.from.kind === "terminal" ? connection.to : connection.from;
    if (other.kind === "browser") {
      // Recorded as an unwire by the agent, not a silent side effect: from the
      // record's point of view the agent dropped one browser in favour of
      // another, and losing that leaves the later wire looking unexplained.
      removeConnectionFromScene(connection.id, `terminal:${spawnerTerminalId}`);
    }
  }

  return createConnectionInScene(
    { kind: "terminal", id: spawnerTerminalId },
    { kind: "browser", id: browserId },
    { origin: "spawn", by: `terminal:${spawnerTerminalId}` },
  );
}

/**
 * Turn the parent→child terminal lineage that predates unified connections
 * into real spawn-origin wires.
 *
 * Lineage used to live only in `terminal.parentTerminalId` and was drawn by
 * a separate overlay, so canvases saved before this change have the
 * relationship but no connection record. Runs on every restore rather than
 * once behind a flag: addConnection returns the existing id for a pair that
 * is already wired, so re-running is a no-op, and a terminal spawned by an
 * older build still gets its line the next time the app opens.
 */
export function backfillLineageConnections(): void {
  const store = useConnectionStore.getState();
  const terminalIds = new Set<string>();
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        terminalIds.add(terminal.id);
      }
    }
  }

  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        const parentId = terminal.parentTerminalId;
        // A parent that is no longer on the canvas (closed, or never
        // restored) would otherwise produce a wire with a dangling endpoint.
        if (!parentId || !terminalIds.has(parentId)) continue;
        // Goes straight to the store rather than through
        // createConnectionInScene: this is a migration, not a decision, and it
        // must not reach the decision record. See the `capture` option there.
        store.addConnection(
          { kind: "terminal", id: parentId },
          { kind: "terminal", id: terminal.id },
          "spawn",
        );
      }
    }
  }
}

/**
 * October-style capability-grant notice: when a connection pairs a terminal
 * with a browser tile, push a real (auto-submitted) turn into that
 * terminal's running agent announcing the browser-bridge tools now work for
 * it — see electron/main.ts's browser:notify-wired handler, which reuses
 * the same composer-submit pipeline pin dispatch already relies on. The
 * actual capability grant itself is enforced separately, per-call, by
 * browser-bridge checking /terminal/:id/browser-binding — this notice is
 * just courtesy, not the gate.
 */
// PTY spawn isn't just "start a process" — buildLaunchSpec (electron/
// pty-launch.ts) first does an async login-shell env probe (spawning the
// user's actual shell to capture PATH/aliases/etc, cached only after the
// first call) before the real PTY exists, and that can genuinely take
// several seconds on a heavier zsh/oh-my-zsh/powerlevel10k setup — a fixed
// short poll window gives up on perfectly healthy terminals. This waits
// reactively on the store instead of polling on a timer, so it resolves the
// instant ptyId actually appears; the generous cap is just a safety net for
// a terminal that genuinely fails to spawn.
const PTY_READY_TIMEOUT_MS = 20_000;

/** Exported for reuse by src/toolbar/BottomToolbar.tsx's workspace-manager
 * briefing, which hits the exact same "just-spawned terminal, PTY not up
 * yet" race this was originally written for. */
export function waitForTerminalReady(
  terminalId: string,
): Promise<ReturnType<typeof findTerminal>> {
  const immediate = findTerminal(terminalId);
  if (immediate && getLivePtyId(terminalId) != null) {
    return Promise.resolve(immediate);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(findTerminal(terminalId));
    }, PTY_READY_TIMEOUT_MS);

    const unsubscribe = useTerminalRuntimeStateStore.subscribe(() => {
      if (getLivePtyId(terminalId) == null) return;
      const found = findTerminal(terminalId);
      if (found) {
        clearTimeout(timer);
        unsubscribe();
        resolve(found);
      }
    });
  });
}

/**
 * Tell the agents at a wire's ends what it now lets them do.
 *
 * Pushed as a real turn into each agent, through the same composer-submit
 * path pin dispatch uses (electron/main.ts's browser:notify-wired handler).
 * Only agents are told: typing a notice into a shell would run it. An end
 * the wire gives nothing to (the head of a one-way wire, a plain link) is
 * skipped, since there is nothing for it to know. The notice is courtesy;
 * what an agent may actually do is checked on every call.
 */
async function notifyWireEnds(
  connectionId: string,
  only?: ConnectionEndpoint,
): Promise<void> {
  const connection = useConnectionStore.getState().connections[connectionId];
  if (!connection) return;
  for (const self of [connection.from, connection.to]) {
    if (self.kind !== "terminal") continue;
    if (only && (only.kind !== self.kind || only.id !== self.id)) continue;
    if (endpointRole(self) !== "agent") continue;
    const other = self === connection.from ? connection.to : connection.from;
    const text = wireNoticeText({
      other: { role: endpointRole(other), id: other.id, title: nodeTitle(other.kind, other.id) },
      abilities: abilitiesFor(connection, self),
      purpose: connection.purpose,
      // The role describes the head, for the tail.
      role: self === connection.from ? connection.role : undefined,
      twoWay: isTwoWay(connection),
    });
    if (text) await sendWireNotice(self.id, text);
  }
}

async function sendWireNotice(terminalId: string, text: string): Promise<void> {
  // A terminal's ptyId is null until its real PTY process finishes spawning
  // — wiring a terminal within the first moment or two of creating it would
  // otherwise silently drop the notice with no PTY to write into yet.
  const found = await waitForTerminalReady(terminalId);
  const ptyId = found ? getLivePtyId(terminalId) : null;
  if (!found || ptyId == null) {
    useNotificationStore
      .getState()
      .notify(
        "warn",
        "Couldn't tell the agent about the new wire: its terminal isn't ready yet. The wire still works; ask the agent to use it.",
      );
    return;
  }
  const { terminal, worktree } = found;
  const result = await window.tacit.browser.notifyWired(
    {
      terminalId: terminal.id,
      ptyId,
      terminalType: terminal.type,
      worktreePath: worktree.path,
    },
    text,
  );
  if (!result.ok) {
    useNotificationStore
      .getState()
      .notify(
        "warn",
        `Couldn't tell the agent about the new wire: ${result.detail ?? result.error}. The wire still works; ask the agent to use it.`,
      );
  }
}

export function removeConnectionFromScene(
  connectionId: string,
  by: CaptureActor = "user",
) {
  // Read before removing — the endpoints are the only interesting part of the
  // entry, and they're gone once the store drops the record.
  const connection = useConnectionStore.getState().connections[connectionId];
  useConnectionStore.getState().removeConnection(connectionId);
  if (!connection) return;
  recordDecision({
    kind: "unwire",
    from: captureRef(connection.from),
    to: captureRef(connection.to),
    origin: connection.origin ?? "manual",
    by,
  });
}

export function restoreConnectionsInScene(
  connections: Record<string, ConnectionData>,
) {
  useConnectionStore.setState({ connections: migrateWires(connections), pending: null });
}
