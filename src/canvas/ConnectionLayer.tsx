import { useEffect, useMemo, useRef, useState } from "react";
import { useNodes } from "@xyflow/react";
import { useCanvasStore } from "../stores/canvasStore";
import {
  useBrowserCardStore,
  type BrowserCardData,
} from "../stores/browserCardStore";
import type {
  CanvasFlowNode,
  PinFlowNode,
  TerminalFlowNode,
} from "./nodeProjection";
import {
  endpointKey,
  getHoverFamily,
  useConnectionStore,
  type ConnectionEndpoint,
  type ConnectionEndpointKind,
} from "../stores/connectionStore";
import {
  createConnectionInScene,
  removeConnectionFromScene,
} from "../actions/sceneConnectionActions";
import {
  useBridgeActivityStore,
  connectionEventPairKey,
} from "../stores/bridgeActivityStore";
import { useProjectStore } from "../stores/projectStore";
import { usePinStore } from "../stores/pinStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { ContextMenu } from "../components/ContextMenu";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useT } from "../i18n/useT";
import { describeEndpoint, type EndpointLabelContext } from "./connectionLabels";
import {
  connectionFamily,
  connectionTypeSpec,
  isPendingBehaviour,
  resolveConnectionType,
} from "../../shared/connection-types";
import {
  connectionStrokeStyle,
  formatConnectionTypeLabel,
  hasCustomMarker,
} from "./connectionTypeStyle";
import { connectionLabelLayout } from "./connectionLabelScale";
import { ConnectionTypeMenu } from "./ConnectionTypeMenu";

/**
 * Draws every connection between canvas items — terminals, browser tiles and
 * notes — plus the small connector dots you drag new ones from.
 *
 * This is the single connection renderer. It used to be one of two: a
 * separate `ClusterLinkLayer` drew agent spawn lineage from
 * `terminal.parentTerminalId` while this layer drew user-created wires from
 * `connectionStore`, so the canvas showed two kinds of line that looked
 * related but shared no data, no persistence and no behaviour — and only the
 * wires actually granted anything (browser control, emit_event fan-out).
 * Spawning now creates a real connection tagged `origin: "spawn"`, so lineage
 * is just the subset of wires that were created by spawning, and this
 * component renders all of them.
 *
 * Two levels of detail, by zoom, replacing what the split used to give:
 *  - zoomed out — soft dashed centre-to-centre curves, hovering a node lights
 *    up everything it works with. The map-mode read of "what belongs to
 *    what", with no connector dots competing for attention.
 *  - zoomed in — solid elbow wires, connector dots, live activity pulse.
 *    The working view, where you actually manipulate connections.
 *
 * The map-view highlight colours by ORIGIN, not by importance: lineage in the
 * accent, hand-drawn wires in teal, both at the same weight and opacity. An
 * earlier cut lit only lineage and left hand-drawn wires on the faint resting
 * hairline, which made a wire you drew yourself read as absent next to its
 * siblings — the two-tier split this component exists to remove, rebuilt in
 * styling. Visibility says "there's a link here"; colour says "what kind".
 *
 * Connections span two different rendering systems — terminals and notes live
 * inside React Flow's own transformed/pooled node tree, browser tiles live in
 * the parallel `CanvasCardLayer` (kept separate deliberately, see that file)
 * — so this can't use React Flow's native edges, which only know about its
 * own node registry. Instead it's a standalone SVG overlay using the exact
 * same `translate(viewport.x, viewport.y) scale(viewport.scale)` transform
 * `CanvasCardLayer` already uses, reading positions straight from the stores
 * that actually own them.
 */

interface EndpointRect {
  kind: ConnectionEndpointKind;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

// A 5px visible dot is honest-looking but was nearly impossible to actually
// grab — real hit-testing needs a much bigger, invisible target around it
// (this is how tldraw/excalidraw/n8n all do connection handles: a small
// clean dot for the eye, a generous circle for the pointer).
const HANDLE_VISIBLE_RADIUS = 6;
const HANDLE_HOVER_RADIUS = 9;
const HANDLE_HIT_RADIUS = 20;

const FALLBACK_TERMINAL_WIDTH = 300;
const FALLBACK_TERMINAL_HEIGHT = 200;

// Below this zoom the layer crossfades from working view (elbow wires +
// connector dots) to map view (soft family curves), ramping across
// [THRESHOLD - BAND, THRESHOLD] so the change arrives gradually rather than
// popping. Inherited from the old ClusterLinkLayer, which is where the
// zoomed-out reading of the canvas originally lived.
const OVERVIEW_ZOOM_THRESHOLD = 0.6;
const OVERVIEW_FADE_BAND = 0.1;
const FAMILY_OUTLINE_PADDING = 4;
const FAMILY_OUTLINE_RADIUS = 6;

// Lineage keeps the accent (a warm off-white in the default theme); hand-drawn
// wires get teal. Cool-vs-warm separates faster than two hues at the same
// temperature would, and the canvas wallpaper is the one thing neither colour
// can be tuned against — so the pair is chosen to survive an arbitrary one.
const LINEAGE_COLOR = "var(--accent)";
const ATTACHED_COLOR = "var(--cyan)";

/**
 * Terminal positions come from React Flow's own live node state (`useNodes`,
 * reactive on every render frame) rather than `projectStore`, which only
 * gets the final position on drag-*stop* — reading the store here would
 * leave connector handles and wires frozen at the pre-drag position for the
 * whole duration of a drag.
 */
function collectEndpointRects(
  terminalNodes: TerminalFlowNode[],
  pinNodes: PinFlowNode[],
  browserCards: Record<string, BrowserCardData>,
): EndpointRect[] {
  const rects: EndpointRect[] = [];
  for (const node of terminalNodes) {
    rects.push({
      kind: "terminal",
      id: node.data.terminalId,
      x: node.position.x,
      y: node.position.y,
      w: (node.style?.width as number | undefined) ?? FALLBACK_TERMINAL_WIDTH,
      h: (node.style?.height as number | undefined) ?? FALLBACK_TERMINAL_HEIGHT,
    });
  }
  // Notes come from the same React Flow node tree as terminals (and so are
  // already live during a drag, unlike reading pinStore directly). Only pins
  // with x/y are on the canvas at all — buildPinFlowNodes skips the rest —
  // so anything in this list is genuinely placed and connectable.
  for (const node of pinNodes) {
    rects.push({
      kind: "note",
      id: node.data.pinId,
      x: node.position.x,
      y: node.position.y,
      w: (node.style?.width as number | undefined) ?? FALLBACK_TERMINAL_WIDTH,
      h: (node.style?.height as number | undefined) ?? FALLBACK_TERMINAL_HEIGHT,
    });
  }
  for (const card of Object.values(browserCards)) {
    rects.push({ kind: "browser", id: card.id, x: card.x, y: card.y, w: card.w, h: card.h });
  }
  return rects;
}

/** Soft bowed curve between two rect centres, for the zoomed-out map view. */
function curvedPath(a: EndpointRect, b: EndpointRect): string {
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h / 2;
  const x2 = b.x + b.w / 2;
  const y2 = b.y + b.h / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Pull the control point off the chord so the line reads as a soft
  // connection rather than a ruler, capped so long edges across the canvas
  // don't bow into a giant arc.
  const offset = Math.min(80, len * 0.18);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const cx = midX + (-dy / len) * offset;
  const cy = midY + (dx / len) * offset;
  return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
}

function handlePoints(rect: EndpointRect): Point[] {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return [
    { x: cx, y: rect.y }, // top
    { x: rect.x + rect.w, y: cy }, // right
    { x: cx, y: rect.y + rect.h }, // bottom
    { x: rect.x, y: cy }, // left
  ];
}

/** Border-midpoint anchors facing each other, for a clean orthogonal path. */
function facingAnchors(a: EndpointRect, b: EndpointRect): [Point, Point] {
  const aCx = a.x + a.w / 2;
  const aCy = a.y + a.h / 2;
  const bCx = b.x + b.w / 2;
  const bCy = b.y + b.h / 2;
  const horizontal = Math.abs(bCx - aCx) >= Math.abs(bCy - aCy);
  if (horizontal) {
    const aIsLeft = aCx <= bCx;
    return [
      { x: aIsLeft ? a.x + a.w : a.x, y: aCy },
      { x: aIsLeft ? b.x : b.x + b.w, y: bCy },
    ];
  }
  const aIsAbove = aCy <= bCy;
  return [
    { x: aCx, y: aIsAbove ? a.y + a.h : a.y },
    { x: bCx, y: aIsAbove ? b.y : b.y + b.h },
  ];
}

function elbowPath(p1: Point, p2: Point): string {
  const midX = (p1.x + p2.x) / 2;
  return `M${p1.x},${p1.y} L${midX},${p1.y} L${midX},${p2.y} L${p2.x},${p2.y}`;
}

/**
 * Middle of the elbow's vertical leg, which is the one segment of the path that
 * is always present and never overlaps either endpoint — the label and the
 * custom marker both anchor here so they never sit on top of a card.
 */
function elbowMidpoint(p1: Point, p2: Point): Point {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

/** The same point on the map view's quadratic curve (t = 0.5). */
function curveMidpoint(a: EndpointRect, b: EndpointRect): Point {
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h / 2;
  const x2 = b.x + b.w / 2;
  const y2 = b.y + b.h / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Mirrors curvedPath's control point exactly; a marker floating off the
  // curve it is meant to be marking would read as a separate object.
  const offset = Math.min(80, len * 0.18);
  const cx = (x1 + x2) / 2 + (-dy / len) * offset;
  const cy = (y1 + y2) / 2 + (dx / len) * offset;
  return { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 };
}

/**
 * The hand-written marker: a small hollow diamond straddling the wire.
 *
 * Hollow and unfilled so it reads as an annotation on the line rather than the
 * activity pulse (a filled circle), and diamond rather than round so the two are
 * still distinguishable when both are on the same wire.
 */
function CustomMarker({
  at,
  scale,
  color,
  opacity,
}: {
  at: Point;
  scale: number;
  color: string;
  opacity: number;
}) {
  const half = 3.5 / scale;
  return (
    <rect
      x={at.x - half}
      y={at.y - half}
      width={half * 2}
      height={half * 2}
      transform={`rotate(45 ${at.x} ${at.y})`}
      fill="none"
      stroke={color}
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
      style={{ opacity, transition: "opacity 0.15s ease" }}
    />
  );
}

export function ConnectionLayer() {
  // useNodes()'s generic is a type hint only — it does not filter at
  // runtime, and the node tree now also holds "pin" (note) nodes, so this
  // must explicitly narrow to terminals before anything here can assume
  // node.data.terminalId exists.
  const allNodes = useNodes<CanvasFlowNode>();
  const terminalNodes = useMemo(
    () => allNodes.filter((node): node is TerminalFlowNode => node.type === "terminal"),
    [allNodes],
  );
  const pinNodes = useMemo(
    () => allNodes.filter((node): node is PinFlowNode => node.type === "pin"),
    [allNodes],
  );
  const viewport = useCanvasStore((s) => s.viewport);
  const browserCardMap = useBrowserCardStore((s) => s.cards);
  const connections = useConnectionStore((s) => s.connections);
  const pending = useConnectionStore((s) => s.pending);
  const activeCalls = useBridgeActivityStore((s) => s.activeCalls);
  const activeConnectionEvents = useBridgeActivityStore(
    (s) => s.activeConnectionEvents,
  );
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
  // An endpoint key (`kind:id`), so a browser or note can be the hover source
  // just as well as a terminal — otherwise a hand-drawn wire only lights from
  // the terminal end, and hovering the browser you wired up does nothing.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // Right-clicking a wire used to delete it outright, with no menu and no
  // confirmation — one stray click on a 14px-wide hit area silently destroyed
  // a link the user may have spent a task setting up. Now it opens a menu,
  // and the menu asks.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    connectionId: string;
  } | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  // Opened by clicking a wire's type label — a separate piece of state from
  // `menu` (the right-click one) so the two can never fight over one anchor.
  const [typeMenu, setTypeMenu] = useState<{
    x: number;
    y: number;
    connectionId: string;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Two events rather than one: `terminal-hover` predates connections (the old
  // ClusterLinkLayer used it, and WorktreeLabelLayer/FamilyTreeOverlay still
  // do, reading its detail as a bare terminal id), so it can't be widened to
  // carry other kinds without breaking them. `node-hover` carries a full
  // endpoint and is what BrowserCard and PinNode emit.
  useEffect(() => {
    const handleTerminal = (event: Event) => {
      const id = (event as CustomEvent<string | null>).detail;
      setHoveredKey(id ? `terminal:${id}` : null);
    };
    const handleNode = (event: Event) => {
      const endpoint = (event as CustomEvent<ConnectionEndpoint | null>).detail;
      setHoveredKey(endpoint ? endpointKey(endpoint) : null);
    };
    window.addEventListener("tacit:terminal-hover", handleTerminal);
    window.addEventListener("tacit:node-hover", handleNode);
    return () => {
      window.removeEventListener("tacit:terminal-hover", handleTerminal);
      window.removeEventListener("tacit:node-hover", handleNode);
    };
  }, []);

  const rects = useMemo(
    () => collectEndpointRects(terminalNodes, pinNodes, browserCardMap),
    [terminalNodes, pinNodes, browserCardMap],
  );
  const rectByKey = useMemo(() => {
    const map = new Map<string, EndpointRect>();
    for (const rect of rects) map.set(`${rect.kind}:${rect.id}`, rect);
    return map;
  }, [rects]);

  // Which rects (terminal AND browser sides) are currently part of an
  // in-flight browser-bridge call, so both the wire and both endpoints'
  // handles can be highlighted together — not just the browser tile the
  // event technically named. `browserId` is the only id the event carries
  // (see electron/api-server.ts's browserAction); the terminal side is
  // resolved here via whichever connection actually pairs that browser
  // with a terminal.
  const activeRectKeys = useMemo(() => {
    const map = new Map<string, { status: "active" | "error" }>();
    for (const connection of Object.values(connections)) {
      const browserEndpoint =
        connection.from.kind === "browser"
          ? connection.from
          : connection.to.kind === "browser"
            ? connection.to
            : null;
      const terminalEndpoint =
        connection.from.kind === "terminal"
          ? connection.from
          : connection.to.kind === "terminal"
            ? connection.to
            : null;
      if (browserEndpoint && terminalEndpoint) {
        const call = activeCalls[browserEndpoint.id];
        if (call) {
          map.set(`browser:${browserEndpoint.id}`, call);
          map.set(`terminal:${terminalEndpoint.id}`, call);
        }
      }

      const pairKey = connectionEventPairKey(connection.from, connection.to);
      const event = activeConnectionEvents[pairKey];
      if (event) {
        map.set(`${connection.from.kind}:${connection.from.id}`, event);
        map.set(`${connection.to.kind}:${connection.to.id}`, event);
      }
    }
    return map;
  }, [connections, activeCalls, activeConnectionEvents]);

  // 0 = fully zoomed-in working view, 1 = fully zoomed-out map view. The two
  // renderings crossfade against each other across the band so neither pops.
  const overviewOpacity =
    viewport.scale >= OVERVIEW_ZOOM_THRESHOLD
      ? 0
      : viewport.scale <= OVERVIEW_ZOOM_THRESHOLD - OVERVIEW_FADE_BAND
        ? 1
        : (OVERVIEW_ZOOM_THRESHOLD - viewport.scale) / OVERVIEW_FADE_BAND;
  const isOverview = overviewOpacity > 0;
  // Connector dots would be unusable (and visually noisy) at map zoom, and
  // a drag in progress must keep them regardless of zoom so the user can
  // still see where they're dropping.
  const showHandles = overviewOpacity < 1 || pending !== null;

  // Only read while a confirmation is open, but hooks can't be conditional —
  // these are cheap store reads.
  const t = useT();
  const projects = useProjectStore((s) => s.projects);
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);

  const labelContext = useMemo<EndpointLabelContext>(() => {
    const activeCanvas =
      canvases.find((canvas) => canvas.id === activeCanvasId) ?? canvases[0];
    return {
      projects,
      browserCards: browserCardMap,
      pins: Object.values(pinsByProject).flat(),
      workspaceManagerTerminalId:
        activeCanvas?.workspaceManagerTerminalId ?? null,
      strings: {
        workspaceManager: t.connection_endpoint_workspace_manager,
        unknownTerminal: t.connection_endpoint_unknown_terminal,
        unknownBrowser: t.connection_endpoint_unknown_browser,
        unknownNote: t.connection_endpoint_unknown_note,
      },
    };
  }, [projects, browserCardMap, pinsByProject, canvases, activeCanvasId, t]);

  const pendingRemoval = pendingRemovalId
    ? (connections[pendingRemovalId] ?? null)
    : null;
  const removalBody = useMemo(() => {
    if (!pendingRemoval) return null;
    const a = describeEndpoint(pendingRemoval.from, labelContext);
    const b = describeEndpoint(pendingRemoval.to, labelContext);
    const sentence = t.connection_remove_dialog_body
      .replace("{a}", a)
      .replace("{b}", b);
    // What actually changes for the user, which differs by wire: a
    // terminal↔browser wire is the thing granting browser control, and a spawn
    // wire gets rebuilt from parentTerminalId on the next load, so promising
    // permanence there would be a lie.
    const involvesBrowser =
      pendingRemoval.from.kind === "browser" ||
      pendingRemoval.to.kind === "browser";
    const effect =
      pendingRemoval.origin === "spawn"
        ? t.connection_remove_effect_spawn
        : involvesBrowser
          ? t.connection_remove_effect_browser
          : null;
    return { sentence, effect };
  }, [pendingRemoval, labelContext, t]);

  // One layout for every label on the canvas — they all share a zoom.
  const labelLayout = useMemo(
    () => connectionLabelLayout(viewport.scale),
    [viewport.scale],
  );

  // Resolved rather than stored, so a wire deleted while its menu is open
  // closes the menu instead of leaving it pointed at nothing.
  const typeMenuTarget = useMemo(() => {
    if (!typeMenu) return null;
    const connection = connections[typeMenu.connectionId];
    if (!connection) return null;
    return { x: typeMenu.x, y: typeMenu.y, connection };
  }, [typeMenu, connections]);

  const { spawnKeys, attachedKeys } = useMemo(
    () => getHoverFamily(connections, hoveredKey),
    [connections, hoveredKey],
  );
  // `spawnKeys` always holds the hovered node itself, so "is anything actually
  // connected to what I'm hovering" needs more than a non-empty check.
  const hasFamily = spawnKeys.size > 1 || attachedKeys.size > 0;

  // Global drag tracking while a connection is being drawn — mousemove
  // updates the live cursor (in flow coords), mouseup hit-tests whatever
  // DOM element is under the cursor for a `data-connect-id` ancestor
  // (BrowserCard's root / TerminalNode's root both carry one) rather than
  // trying to have each handle claim the event itself, which would race
  // against a window-level listener in an order-sensitive way.
  useEffect(() => {
    if (!pending) return;
    const store = useConnectionStore.getState();

    const toFlow = (clientX: number, clientY: number): Point => {
      const container = containerRef.current;
      const originX = container?.getBoundingClientRect().left ?? 0;
      const originY = container?.getBoundingClientRect().top ?? 0;
      return {
        x: (clientX - originX - viewport.x) / viewport.scale,
        y: (clientY - originY - viewport.y) / viewport.scale,
      };
    };

    const handleMove = (event: MouseEvent) => {
      store.updatePendingCursor(toFlow(event.clientX, event.clientY));
    };

    const handleUp = (event: MouseEvent) => {
      // event.target alone isn't enough: our own connector dots and wire
      // paths sit visually on top of every card (this layer renders after
      // CanvasCardLayer), so when the cursor is right over a dot — exactly
      // where you're aiming to drop a connection — event.target is that dot,
      // and `.closest("[data-connect-id]")` on it walks up through this
      // layer's own DOM tree, which never has that attribute, and misses
      // the real card underneath entirely. elementsFromPoint returns every
      // element stacked at that point, not just the topmost, so it finds
      // the actual card regardless of what's drawn above it.
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      let target: HTMLElement | null = null;
      for (const el of stack) {
        const match = (el as HTMLElement).closest?.("[data-connect-id]");
        if (match) {
          target = match as HTMLElement;
          break;
        }
      }
      const kind = target?.dataset.connectKind as
        | ConnectionEndpointKind
        | undefined;
      const id = target?.dataset.connectId;
      const resolved = store.endPending(kind && id ? { kind, id } : undefined);
      if (resolved) {
        createConnectionInScene(resolved.from, resolved.to);
      }
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [pending !== null, viewport.x, viewport.y, viewport.scale]);

  return (
    <div ref={containerRef} className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <svg
        className="absolute inset-0"
        width="100%"
        height="100%"
        style={{ pointerEvents: "none" }}
        aria-hidden="true"
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {Object.values(connections).map((connection) => {
            const from = rectByKey.get(`${connection.from.kind}:${connection.from.id}`);
            const to = rectByKey.get(`${connection.to.kind}:${connection.to.id}`);
            if (!from || !to) return null;
            const [p1, p2] = facingAnchors(from, to);

            const browserEndpoint =
              connection.from.kind === "browser" ? connection.from : connection.to;
            const activeCall =
              browserEndpoint.kind === "browser"
                ? activeCalls[browserEndpoint.id]
                : undefined;

            // An emitted event (emit_event/canvas-bridge:event) carries its
            // own explicit source/target — unlike the browser-bridge call
            // above, it isn't always terminal-calls-browser (a
            // terminal↔terminal wire can pulse in either direction).
            const eventPairKey = connectionEventPairKey(connection.from, connection.to);
            const activeEvent = activeConnectionEvents[eventPairKey];

            const isActive = !!activeCall || !!activeEvent;
            const isError =
              activeCall?.status === "error" || activeEvent?.status === "error";
            const pulseColor = isError ? "var(--red)" : "var(--accent)";

            // Direction for the traveling dot: an active emitted event's
            // explicit source→target wins; otherwise the legacy
            // browser-bridge-call assumption (terminal is always the
            // caller, browser always the callee) applies; otherwise the
            // static line stays undirected.
            let sourceAnchor = p1;
            let targetAnchor = p2;
            if (activeEvent) {
              const sourceRect = rectByKey.get(
                `${activeEvent.source.kind}:${activeEvent.source.id}`,
              );
              const targetRect = rectByKey.get(
                `${activeEvent.target.kind}:${activeEvent.target.id}`,
              );
              if (sourceRect && targetRect) {
                [sourceAnchor, targetAnchor] = facingAnchors(sourceRect, targetRect);
              }
            } else if (activeCall) {
              const terminalRect = from.kind === "terminal" ? from : to;
              const browserRect = from.kind === "browser" ? from : to;
              [sourceAnchor, targetAnchor] = facingAnchors(terminalRect, browserRect);
            }

            // At map zoom, hovering promotes the edges around the hovered node
            // out of the faint resting hairline, so one hover answers "what is
            // this working with?". Which colour it promotes to says how the
            // two ends came to be connected.
            const fromKey = endpointKey(connection.from);
            const toKey = endpointKey(connection.to);
            const isLineageEdge =
              hasFamily &&
              connection.origin === "spawn" &&
              spawnKeys.has(fromKey) &&
              spawnKeys.has(toKey);
            // One end in the lineage, the other hanging off it by hand. Both
            // orderings, since connections are undirected for lookup.
            const isAttachedEdge =
              hasFamily &&
              !isLineageEdge &&
              ((spawnKeys.has(fromKey) && attachedKeys.has(toKey)) ||
                (spawnKeys.has(toKey) && attachedKeys.has(fromKey)));
            const isHighlighted = isLineageEdge || isAttachedEdge;
            const highlightColor = isAttachedEdge
              ? ATTACHED_COLOR
              : LINEAGE_COLOR;

            // What the wire means, drawn into the stroke so it survives all the
            // way out to map zoom where the label is gone. Read through
            // resolveConnectionType, so an untyped wire shows its inferred
            // meaning rather than nothing.
            const family = connectionFamily(connection);
            const workingStroke = connectionStrokeStyle(family, "working");
            const overviewStroke = connectionStrokeStyle(family, "overview");
            const isCustom = hasCustomMarker(connection);

            return (
              <g key={connection.id}>
                <path
                  d={elbowPath(p1, p2)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{
                    pointerEvents: isOverview ? "none" : "stroke",
                    cursor: "pointer",
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({
                      x: event.clientX,
                      y: event.clientY,
                      connectionId: connection.id,
                    });
                  }}
                />
                {overviewOpacity < 1 && (
                  <path
                    d={elbowPath(p1, p2)}
                    fill="none"
                    stroke={isActive ? pulseColor : "var(--accent)"}
                    strokeWidth={
                      (isActive ? 2.5 : workingStroke.width) / viewport.scale
                    }
                    strokeDasharray={workingStroke.dash ?? undefined}
                    vectorEffect="non-scaling-stroke"
                    style={{
                      opacity:
                        (isActive ? 1 : workingStroke.opacity) *
                        (1 - overviewOpacity),
                      transition: "stroke 0.15s ease, opacity 0.15s ease",
                    }}
                  />
                )}
                {overviewOpacity < 1 && isCustom && (
                  <CustomMarker
                    at={elbowMidpoint(p1, p2)}
                    scale={viewport.scale}
                    color={isActive ? pulseColor : "var(--accent)"}
                    opacity={1 - overviewOpacity}
                  />
                )}
                {isOverview && (
                  <path
                    d={curvedPath(from, to)}
                    fill="none"
                    stroke={
                      isHighlighted
                        ? `color-mix(in srgb, ${highlightColor} 70%, transparent)`
                        : "var(--text-faint)"
                    }
                    strokeWidth={overviewStroke.width}
                    // Family, not highlight state, decides the dash out here:
                    // colour and opacity already carry "is this in the hovered
                    // set", and losing the dash on hover would make a knowledge
                    // wire momentarily claim to be an action.
                    strokeDasharray={overviewStroke.dash ?? undefined}
                    vectorEffect="non-scaling-stroke"
                    style={{
                      opacity:
                        (isHighlighted ? 0.85 : overviewStroke.opacity) *
                        overviewOpacity,
                      transition:
                        "stroke var(--duration-quick) var(--ease-out-soft), opacity var(--duration-quick) var(--ease-out-soft)",
                    }}
                  />
                )}
                {isOverview && isCustom && (
                  <CustomMarker
                    at={curveMidpoint(from, to)}
                    scale={viewport.scale}
                    color={
                      isHighlighted ? highlightColor : "var(--text-secondary)"
                    }
                    opacity={0.7 * overviewOpacity}
                  />
                )}
                {isActive && (
                  <circle
                    r={4 / viewport.scale}
                    fill={pulseColor}
                    stroke="var(--surface)"
                    strokeWidth={1 / viewport.scale}
                  >
                    <animateMotion
                      dur={isError ? "0.6s" : "1s"}
                      repeatCount="indefinite"
                      path={elbowPath(sourceAnchor, targetAnchor)}
                    />
                  </circle>
                )}
              </g>
            );
          })}

          {pending &&
            (() => {
              const from = rectByKey.get(`${pending.from.kind}:${pending.from.id}`);
              if (!from) return null;
              const [p1] = facingAnchors(from, {
                kind: "terminal",
                id: "",
                x: pending.cursor.x,
                y: pending.cursor.y,
                w: 0,
                h: 0,
              });
              return (
                <path
                  d={elbowPath(p1, pending.cursor)}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: 0.6 }}
                />
              );
            })()}

          {pending &&
            rects
              .filter(
                (rect) =>
                  !(rect.kind === pending.from.kind && rect.id === pending.from.id),
              )
              .map((rect) => (
                <rect
                  key={`drop-zone:${rect.kind}:${rect.id}`}
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                  rx={8}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: 0.5 }}
                />
              ))}

          {isOverview &&
            hasFamily &&
            rects
              .filter((rect) => {
                const key = `${rect.kind}:${rect.id}`;
                return spawnKeys.has(key) || attachedKeys.has(key);
              })
              .map((rect) => {
                // Outlined in whichever colour its wire was drawn in, so the
                // browser you hand-wired reads as part of the highlighted set
                // without being mistaken for a spawned agent.
                const isAttached = attachedKeys.has(`${rect.kind}:${rect.id}`);
                return (
                  <rect
                    key={`family-outline:${rect.kind}:${rect.id}`}
                    x={rect.x - FAMILY_OUTLINE_PADDING}
                    y={rect.y - FAMILY_OUTLINE_PADDING}
                    width={rect.w + FAMILY_OUTLINE_PADDING * 2}
                    height={rect.h + FAMILY_OUTLINE_PADDING * 2}
                    rx={FAMILY_OUTLINE_RADIUS}
                    ry={FAMILY_OUTLINE_RADIUS}
                    fill="none"
                    stroke={isAttached ? ATTACHED_COLOR : LINEAGE_COLOR}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    style={{
                      opacity: 0.4 * overviewOpacity,
                      transition:
                        "opacity var(--duration-quick) var(--ease-out-soft)",
                    }}
                  />
                );
              })}

          {showHandles &&
            rects.map((rect) => {
            // While a connection is being dragged, every OTHER card's
            // handles grow and light up as valid drop targets — the same
            // "here's where you can let go" affordance tldraw/excalidraw
            // give arrow endpoints, instead of leaving the user to guess.
            const isDragSource =
              pending?.from.kind === rect.kind && pending?.from.id === rect.id;
            const isDropCandidate = pending !== null && !isDragSource;

            const activeCall = activeRectKeys.get(`${rect.kind}:${rect.id}`);
            const isActive = activeCall !== undefined;
            const activeColor =
              activeCall?.status === "error" ? "var(--red)" : "var(--accent)";

            return handlePoints(rect).map((point, index) => {
              const handleKey = `${rect.kind}:${rect.id}:${index}`;
              const isHovered = hoveredHandle === handleKey;
              const isLit = isHovered || isDropCandidate || isActive;
              const visibleRadius =
                (isLit ? HANDLE_HOVER_RADIUS : HANDLE_VISIBLE_RADIUS) /
                viewport.scale;

              return (
                <g key={handleKey}>
                  {/* Invisible, much larger than the dot you actually see —
                      the whole reason the old 5px dots were nearly
                      unclickable. `data-scene-box-select-block` matters
                      just as much as the size: XyFlowCanvas's marquee
                      box-select listens on `onMouseDownCapture`, which
                      fires during the CAPTURE phase — top-down, before this
                      circle's own (bubble-phase) onMouseDown ever runs. So
                      calling stopPropagation() inside that handler is too
                      late; the box-select drag has already started by
                      then. `data-scene-box-select-block` is the existing
                      escape hatch BrowserCard's own drag/resize handles
                      already rely on for the same reason — the capture
                      handler checks for this attribute and bails out
                      before initiating box-select. */}
                  <circle
                    data-scene-box-select-block
                    cx={point.x}
                    cy={point.y}
                    r={HANDLE_HIT_RADIUS / viewport.scale}
                    fill="transparent"
                    style={{ pointerEvents: "auto", cursor: "crosshair" }}
                    onMouseEnter={() => setHoveredHandle(handleKey)}
                    onMouseLeave={() =>
                      setHoveredHandle((current) =>
                        current === handleKey ? null : current,
                      )
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const container = containerRef.current;
                      const originX = container?.getBoundingClientRect().left ?? 0;
                      const originY = container?.getBoundingClientRect().top ?? 0;
                      const flowX = (event.clientX - originX - viewport.x) / viewport.scale;
                      const flowY = (event.clientY - originY - viewport.y) / viewport.scale;
                      useConnectionStore
                        .getState()
                        .startPending({ kind: rect.kind, id: rect.id }, { x: flowX, y: flowY });
                    }}
                  />
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={visibleRadius}
                    fill={isLit ? activeColor : "var(--surface)"}
                    stroke={isActive ? activeColor : "var(--accent)"}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    style={{
                      pointerEvents: "none",
                      // Fades out with the map-view crossfade, but a drag in
                      // progress keeps them fully visible at any zoom.
                      opacity:
                        (isLit ? 1 : 0.85) *
                        (pending !== null ? 1 : 1 - overviewOpacity),
                      transition:
                        "r 0.1s ease, fill 0.1s ease, stroke 0.15s ease, opacity 0.1s ease",
                    }}
                  />
                </g>
              );
            });
          })}
        </g>
      </svg>

      {/* Type labels, as HTML rather than SVG <text>: they are buttons, they
          need to be tab-reachable and hoverable, and their size is decided in
          screen pixels (see connectionLabelScale) — so they are positioned in
          screen space instead of riding the SVG's canvas transform. */}
      {labelLayout.visible && (
        <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
          {Object.values(connections).map((connection) => {
            const from = rectByKey.get(endpointKey(connection.from));
            const to = rectByKey.get(endpointKey(connection.to));
            if (!from || !to) return null;
            const [p1, p2] = facingAnchors(from, to);
            // Labels outlive the start of the map-view crossfade by a little,
            // and the two renderings have different midpoints, so the anchor
            // travels between them rather than letting the label detach from
            // whichever line is currently the prominent one.
            const elbowMid = elbowMidpoint(p1, p2);
            const curveMid = curveMidpoint(from, to);
            const mid = {
              x: elbowMid.x + (curveMid.x - elbowMid.x) * overviewOpacity,
              y: elbowMid.y + (curveMid.y - elbowMid.y) * overviewOpacity,
            };
            const type = resolveConnectionType(connection);
            const spec = connectionTypeSpec(type);
            const isCustom = type === "custom";
            // Pair-aware: the same label runs at one pair and not another, so
            // the endpoints decide the mark, not the type on its own.
            const pending = isPendingBehaviour(
              type,
              connection.from.kind,
              connection.to.kind,
            );

            return (
              <button
                key={`type-label:${connection.id}`}
                type="button"
                data-scene-box-select-block
                aria-label={t.connection_type_label_aria.replace(
                  "{type}",
                  spec.label,
                )}
                className="absolute rounded border transition-colors duration-quick"
                style={{
                  left: viewport.x + mid.x * viewport.scale,
                  top: viewport.y + mid.y * viewport.scale,
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "auto",
                  fontFamily: '"Geist Mono", monospace',
                  fontSize: labelLayout.fontPx,
                  lineHeight: 1.2,
                  padding: "1px 5px",
                  whiteSpace: "nowrap",
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  background: "var(--surface)",
                  borderColor: "var(--border)",
                  // A type whose behaviour has not landed gets a dashed border:
                  // the label still says what the wire means, because that is
                  // recorded and true, while the broken outline says the words
                  // are not yet a promise the app keeps. The stroke itself is
                  // left alone — family is what the relationship *means*, and
                  // encoding a temporary fact about the build in the permanent
                  // visual vocabulary would have to be unwound later.
                  borderStyle: pending ? "dashed" : "solid",
                  // Structural wires say nothing runs, so their label recedes
                  // the same way their stroke does.
                  color:
                    spec.family === "structural" || pending
                      ? "var(--text-muted)"
                      : "var(--text-secondary)",
                  opacity: labelLayout.opacity,
                  cursor: "pointer",
                }}
                onMouseDown={(event) => {
                  // Capture-phase marquee box-select is already blocked by the
                  // data attribute; this stops the canvas from starting a pan.
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setTypeMenu({
                    x: event.clientX,
                    y: event.clientY,
                    connectionId: connection.id,
                  });
                }}
              >
                {/* Echoes the diamond drawn on the wire, so the label and the
                    marker read as one thing rather than two coincidences. */}
                {isCustom ? "◇ " : ""}
                {formatConnectionTypeLabel(connection)}
              </button>
            );
          })}
        </div>
      )}

      {/* Outside the <svg> because both are HTML, and inside a
          pointer-events: auto wrapper because this layer's root disables
          pointer events for everything that isn't a wire or a handle.
          ConfirmDialog portals to document.body, so it escapes that anyway. */}
      {typeMenuTarget && (
        <div style={{ pointerEvents: "auto" }}>
          <ConnectionTypeMenu
            x={typeMenuTarget.x}
            y={typeMenuTarget.y}
            connectionId={typeMenuTarget.connection.id}
            fromKind={typeMenuTarget.connection.from.kind}
            toKind={typeMenuTarget.connection.to.kind}
            current={resolveConnectionType(typeMenuTarget.connection)}
            currentPrompt={typeMenuTarget.connection.customPrompt}
            onClose={() => setTypeMenu(null)}
          />
        </div>
      )}

      {menu && (
        <div style={{ pointerEvents: "auto" }}>
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={[
              // The label is the primary way in; this exists for the case
              // where the label is too small to aim at, or hidden.
              {
                label: t.connection_change_type,
                onClick: () =>
                  setTypeMenu({
                    x: menu.x,
                    y: menu.y,
                    connectionId: menu.connectionId,
                  }),
              },
              { type: "separator" },
              {
                label: t.connection_remove,
                danger: true,
                onClick: () => setPendingRemovalId(menu.connectionId),
              },
            ]}
            onClose={() => setMenu(null)}
          />
        </div>
      )}

      <ConfirmDialog
        open={removalBody !== null}
        title={t.connection_remove_dialog_title}
        body={
          removalBody && (
            <>
              <div>{removalBody.sentence}</div>
              {removalBody.effect && (
                <div className="mt-2 text-[var(--text-faint)]">
                  {removalBody.effect}
                </div>
              )}
            </>
          )
        }
        confirmLabel={t.connection_remove_confirm}
        confirmTone="danger"
        onCancel={() => setPendingRemovalId(null)}
        onConfirm={() => {
          if (pendingRemovalId) removeConnectionFromScene(pendingRemovalId);
          setPendingRemovalId(null);
        }}
      />
    </div>
  );

}
