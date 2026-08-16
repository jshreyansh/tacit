import { create } from "zustand";
import type { BrowserBridgeCallEvent, CanvasBridgeEvent } from "../types";
import type { ConnectionEndpoint } from "./connectionStore";

export interface ActiveBridgeCall {
  requestId: string;
  action: string;
  startedAt: number;
  status: "active" | "error";
}

export interface ActiveConnectionEvent {
  requestId: string;
  type: string;
  source: ConnectionEndpoint;
  target: ConnectionEndpoint;
  startedAt: number;
  status: "active" | "error";
}

/** Canonical, order-independent key for a pair of endpoints — the store
 * keys active connection events by this, and ConnectionLayer.tsx computes
 * the same key from a connection's from/to to look it up, without either
 * side needing to know the connection's own id. */
export function connectionEventPairKey(
  a: ConnectionEndpoint,
  b: ConnectionEndpoint,
): string {
  return [`${a.kind}:${a.id}`, `${b.kind}:${b.id}`].sort().join("~");
}

interface BridgeActivityStore {
  /** Keyed by browserId — the only id electron/api-server.ts's browserAction has to hand. */
  activeCalls: Record<string, ActiveBridgeCall>;
  /** Keyed by connectionEventPairKey(source, target) — see emit_event/canvas-bridge:event. */
  activeConnectionEvents: Record<string, ActiveConnectionEvent>;
  startCall: (browserId: string, requestId: string, action: string) => void;
  endCall: (browserId: string, requestId: string, ok: boolean) => void;
  startConnectionEvent: (
    requestId: string,
    type: string,
    source: ConnectionEndpoint,
    target: ConnectionEndpoint,
  ) => void;
  endConnectionEvent: (
    requestId: string,
    source: ConnectionEndpoint,
    target: ConnectionEndpoint,
    ok: boolean,
  ) => void;
}

// Failed calls get a brief red flash instead of vanishing instantly — long
// enough to actually notice, short enough to stay out of the way.
const ERROR_FLASH_MS = 600;
// Safety net if an "end" event is ever lost (renderer reload mid-call, main
// process crash, etc.) — mirrors the PTY_READY_TIMEOUT_MS precedent in
// sceneConnectionActions.ts. A pulse must never persist forever.
const STALE_CALL_TIMEOUT_MS = 30_000;

const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearStaleTimer(key: string) {
  const timer = staleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    staleTimers.delete(key);
  }
}

const eventStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearEventStaleTimer(key: string) {
  const timer = eventStaleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    eventStaleTimers.delete(key);
  }
}

export const useBridgeActivityStore = create<BridgeActivityStore>((set, get) => ({
  activeCalls: {},
  activeConnectionEvents: {},

  startCall: (browserId, requestId, action) => {
    clearStaleTimer(browserId);
    set((state) => ({
      activeCalls: {
        ...state.activeCalls,
        [browserId]: { requestId, action, startedAt: Date.now(), status: "active" },
      },
    }));

    const timer = setTimeout(() => {
      const current = get().activeCalls[browserId];
      if (current?.requestId === requestId) {
        get().endCall(browserId, requestId, true);
      }
    }, STALE_CALL_TIMEOUT_MS);
    staleTimers.set(browserId, timer);
  },

  endCall: (browserId, requestId, ok) => {
    // Only clear if this end matches the call we're currently tracking — a
    // stale "end" from an earlier call must not stomp a newer one that
    // started on the same browser tile in the meantime.
    const current = get().activeCalls[browserId];
    if (!current || current.requestId !== requestId) return;
    clearStaleTimer(browserId);

    if (ok) {
      set((state) => {
        const { [browserId]: _removed, ...rest } = state.activeCalls;
        return { activeCalls: rest };
      });
      return;
    }

    set((state) => ({
      activeCalls: {
        ...state.activeCalls,
        [browserId]: { ...current, status: "error" },
      },
    }));
    setTimeout(() => {
      const stillThere = get().activeCalls[browserId];
      if (stillThere?.requestId === requestId) {
        set((state) => {
          const { [browserId]: _removed, ...rest } = state.activeCalls;
          return { activeCalls: rest };
        });
      }
    }, ERROR_FLASH_MS);
  },

  startConnectionEvent: (requestId, type, source, target) => {
    const key = connectionEventPairKey(source, target);
    clearEventStaleTimer(key);
    set((state) => ({
      activeConnectionEvents: {
        ...state.activeConnectionEvents,
        [key]: { requestId, type, source, target, startedAt: Date.now(), status: "active" },
      },
    }));

    const timer = setTimeout(() => {
      const current = get().activeConnectionEvents[key];
      if (current?.requestId === requestId) {
        get().endConnectionEvent(requestId, source, target, true);
      }
    }, STALE_CALL_TIMEOUT_MS);
    eventStaleTimers.set(key, timer);
  },

  endConnectionEvent: (requestId, source, target, ok) => {
    const key = connectionEventPairKey(source, target);
    const current = get().activeConnectionEvents[key];
    if (!current || current.requestId !== requestId) return;
    clearEventStaleTimer(key);

    if (ok) {
      set((state) => {
        const { [key]: _removed, ...rest } = state.activeConnectionEvents;
        return { activeConnectionEvents: rest };
      });
      return;
    }

    set((state) => ({
      activeConnectionEvents: {
        ...state.activeConnectionEvents,
        [key]: { ...current, status: "error" },
      },
    }));
    setTimeout(() => {
      const stillThere = get().activeConnectionEvents[key];
      if (stillThere?.requestId === requestId) {
        set((state) => {
          const { [key]: _removed, ...rest } = state.activeConnectionEvents;
          return { activeConnectionEvents: rest };
        });
      }
    }, ERROR_FLASH_MS);
  },
}));

export function initBridgeActivityIPC(): () => void {
  return window.termcanvas.browser.onBridgeCall(
    (payload: BrowserBridgeCallEvent) => {
      const { startCall, endCall } = useBridgeActivityStore.getState();
      if (payload.phase === "start") {
        startCall(payload.browserId, payload.requestId, payload.action);
      } else {
        endCall(payload.browserId, payload.requestId, payload.ok ?? false);
      }
    },
  );
}

export function initCanvasBridgeEventIPC(): () => void {
  return window.termcanvas.browser.onCanvasBridgeEvent(
    (payload: CanvasBridgeEvent) => {
      const { startConnectionEvent, endConnectionEvent } =
        useBridgeActivityStore.getState();
      const source = { kind: payload.sourceKind, id: payload.sourceId };
      const target = { kind: payload.targetKind, id: payload.targetId };
      if (payload.phase === "start") {
        startConnectionEvent(payload.requestId, payload.type, source, target);
      } else {
        endConnectionEvent(payload.requestId, source, target, payload.ok ?? false);
      }
    },
  );
}
