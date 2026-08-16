import {
  connectionsInvolving,
  useConnectionStore,
  type ConnectionData,
  type ConnectionEndpoint,
  type ConnectionOrigin,
} from "../stores/connectionStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalRuntimeStateStore } from "../stores/terminalRuntimeStateStore";
import { findTerminal, getLivePtyId } from "./terminalLookup";
import { captureRef, recordDecision } from "../capture";
import type { CaptureActor } from "../../shared/capture";

interface CreateConnectionOptions {
  origin?: ConnectionOrigin;
  /**
   * Whether to push the terminal↔browser capability notice into the agent.
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
  // Spawn wires stay silent by default: notifyIfTerminalBrowserWired pushes
  // a real auto-submitted turn into the terminal, and firing that while the
  // agent is still inside its own spawn_browser tool call would interrupt
  // the very turn that asked for the browser. The spawn tool's own result
  // text tells the agent it can drive the page instead.
  const announce = options.announce ?? origin === "manual";
  const existing = useConnectionStore.getState().connections;
  const id = useConnectionStore.getState().addConnection(from, to, origin);
  if (id && announce) notifyIfTerminalBrowserWired(from, to);
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
    });
  }
  return id;
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

async function notifyIfTerminalBrowserWired(
  from: ConnectionEndpoint,
  to: ConnectionEndpoint,
) {
  const terminalEndpoint =
    from.kind === "terminal" ? from : to.kind === "terminal" ? to : null;
  const browserEndpoint =
    from.kind === "browser" ? from : to.kind === "browser" ? to : null;
  if (!terminalEndpoint || !browserEndpoint) return;

  // A terminal's ptyId is null until its real PTY process finishes spawning
  // — connecting a browser to a terminal within the first moment or two of
  // creating it would otherwise silently drop the wire-up notice with no
  // PTY to write into yet.
  const found = await waitForTerminalReady(terminalEndpoint.id);
  const ptyId = found ? getLivePtyId(terminalEndpoint.id) : null;
  if (!found || ptyId == null) {
    useNotificationStore
      .getState()
      .notify(
        "warn",
        "Couldn't announce the browser connection — the terminal's shell process isn't ready yet. The browser-bridge tools still work; just ask the agent to use them directly.",
      );
    return;
  }
  const { terminal, worktree } = found;

  const card = useBrowserCardStore.getState().cards[browserEndpoint.id];
  const shownAs = card?.title || card?.url || "a page";
  const result = await window.termcanvas.browser.notifyWired(
    {
      terminalId: terminal.id,
      ptyId,
      terminalType: terminal.type,
      worktreePath: worktree.path,
    },
    `A browser on the canvas is wired to this terminal (showing: ${shownAs}). Read or drive it with the browser-bridge tools (browser_read, browser_navigate, browser_click, browser_eval) when the task needs it.`,
  );
  if (!result.ok) {
    useNotificationStore
      .getState()
      .notify(
        "warn",
        `Couldn't announce the browser connection to the terminal: ${result.detail ?? result.error}. The browser-bridge tools still work; just ask the agent to use them directly.`,
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
  useConnectionStore.setState({ connections, pending: null });
}
