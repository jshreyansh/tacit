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
  isTwoWay,
  resolveConnectionType,
} from "../../shared/connection-types";
import {
  anchorToward,
  arrowHead,
  curvePath,
  curvePoint,
  facingAnchors,
  trimmed,
  wireCurve,
  type WireCurve,
} from "./wireGeometry";
import { connectionStrokeStyle, wireLabel } from "./connectionTypeStyle";
import { connectionLabelLayout } from "./connectionLabelScale";
import { WirePanel } from "./WirePanel";
import { useWireMailboxStore } from "../stores/wireMailboxStore";
import { abilitiesFor } from "./wireEnds";

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
 *  - zoomed in — curved wires with an arrow where messages arrive, connector
 *    dots on the node under the pointer, and each message as a dot travelling
 *    the wire with its first words. The working view, where you actually
 *    manipulate connections.
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

// A small dot for the eye and a generous invisible circle for the pointer
// (how tldraw/excalidraw/n8n do connection handles). The dots show only on
// the node under the pointer: four big rings on every node read as clutter.
const HANDLE_VISIBLE_RADIUS = 4;
const HANDLE_HOVER_RADIUS = 6;
const HANDLE_HIT_RADIUS = 20;
/** Arrowhead length on screen, in pixels. */
const ARROW_PX = 9;
/** The travelling dot's radius on screen, in pixels. */
const FLIGHT_DOT_PX = 4;

const FALLBACK_TERMINAL_WIDTH = 300;
const FALLBACK_TERMINAL_HEIGHT = 200;

// Below this zoom the layer crossfades from working view (curved wires +
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

/** A curve with its arrow ends pulled back, so the stroke stops at the arrowhead. */
function strokeCurve(curve: WireCurve, arrowAtStart: boolean, arrowAtEnd: boolean, arrow: number): WireCurve {
  return trimmed(curve, arrowAtStart ? arrow * 0.7 : 0, arrowAtEnd ? arrow * 0.7 : 0);
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
  const flights = useBridgeActivityStore((s) => s.flights);
  const recentByPair = useBridgeActivityStore((s) => s.recentByPair);
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
  // The node a wire being dragged would connect to if let go now.
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
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
  const [waitingMenu, setWaitingMenu] = useState<{ x: number; y: number; terminalId: string } | null>(null);
  const waitingMail = useWireMailboxStore((s) => s.waiting);
  const heldMail = useWireMailboxStore((s) => s.held);
  const hydraStatus = useWireMailboxStore((s) => s.hydra);
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

    // event.target alone isn't enough: our own connector dots and wire
    // paths sit visually on top of every card (this layer renders after
    // CanvasCardLayer), so when the cursor is right over a dot — exactly
    // where you're aiming to drop a connection — event.target is that dot,
    // and `.closest("[data-connect-id]")` on it walks up through this
    // layer's own DOM tree, which never has that attribute, and misses
    // the real card underneath entirely. elementsFromPoint returns every
    // element stacked at that point, not just the topmost, so it finds
    // the actual card regardless of what's drawn above it.
    const endpointAt = (clientX: number, clientY: number): ConnectionEndpoint | null => {
      for (const el of document.elementsFromPoint(clientX, clientY)) {
        const match = (el as HTMLElement).closest?.("[data-connect-id]") as HTMLElement | null;
        if (!match) continue;
        const kind = match.dataset.connectKind as ConnectionEndpointKind | undefined;
        const id = match.dataset.connectId;
        if (!kind || !id) return null;
        // The node the wire starts from isn't somewhere it can end.
        if (kind === pending.from.kind && id === pending.from.id) return null;
        return { kind, id };
      }
      return null;
    };

    const handleMove = (event: MouseEvent) => {
      store.updatePendingCursor(toFlow(event.clientX, event.clientY));
      const over = endpointAt(event.clientX, event.clientY);
      const key = over ? endpointKey(over) : null;
      setDropTargetKey((current) => (current === key ? current : key));
    };

    const handleUp = (event: MouseEvent) => {
      setDropTargetKey(null);
      const over = endpointAt(event.clientX, event.clientY);
      const resolved = store.endPending(over ?? undefined);
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
            const [a1, a2] = facingAnchors(from, to);
            const curve = wireCurve(a1, a2);

            const browserEndpoint =
              connection.from.kind === "browser" ? connection.from : connection.to;
            const activeCall =
              browserEndpoint.kind === "browser"
                ? activeCalls[browserEndpoint.id]
                : undefined;

            // An emitted event or a message (canvas-bridge:event) carries its
            // own source and target, so it lights the wire whichever way it
            // travelled.
            const eventPairKey = connectionEventPairKey(connection.from, connection.to);
            const activeEvent = activeConnectionEvents[eventPairKey];

            const isActive = !!activeCall || !!activeEvent;
            const isError =
              activeCall?.status === "error" || activeEvent?.status === "error";
            const pulseColor = isError ? "var(--red)" : "var(--accent)";

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

            // The arrow is where things arrive: at the end it was dropped on,
            // and at both ends of a two-way wire. A bare relationship carries
            // nothing, so it has no arrow.
            const arrow = ARROW_PX / viewport.scale;
            const directed = family !== "structural";
            const arrowAtEnd = directed;
            const arrowAtStart = directed && isTwoWay(connection);
            const wireColor = isActive ? pulseColor : "var(--accent)";
            const wireOpacity = (isActive ? 1 : workingStroke.opacity) * (1 - overviewOpacity);

            return (
              <g key={connection.id}>
                <path
                  d={curvePath(curve)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  vectorEffect="non-scaling-stroke"
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
                  onClick={(event) => {
                    event.stopPropagation();
                    setTypeMenu({
                      x: event.clientX,
                      y: event.clientY,
                      connectionId: connection.id,
                    });
                  }}
                />
                {overviewOpacity < 1 && (
                  <>
                    <path
                      d={curvePath(strokeCurve(curve, arrowAtStart, arrowAtEnd, arrow))}
                      fill="none"
                      stroke={wireColor}
                      strokeWidth={isActive ? 2.25 : workingStroke.width}
                      strokeDasharray={workingStroke.dash ?? undefined}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                      style={{
                        opacity: wireOpacity,
                        transition: "stroke 0.15s ease, opacity 0.15s ease",
                      }}
                    />
                    {arrowAtEnd && (
                      <path
                        d={arrowHead(curve, "end", arrow)}
                        fill={wireColor}
                        stroke="none"
                        style={{ opacity: wireOpacity, transition: "fill 0.15s ease, opacity 0.15s ease" }}
                      />
                    )}
                    {arrowAtStart && (
                      <path
                        d={arrowHead(curve, "start", arrow)}
                        fill={wireColor}
                        stroke="none"
                        style={{ opacity: wireOpacity, transition: "fill 0.15s ease, opacity 0.15s ease" }}
                      />
                    )}
                  </>
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
                {/* A browser-bridge call has no message to show, only that the
                    agent is driving the page, so it keeps a looping pulse for
                    as long as the call runs. */}
                {activeCall && !activeEvent && (
                  <circle
                    r={FLIGHT_DOT_PX / viewport.scale}
                    fill={pulseColor}
                    stroke="var(--surface)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  >
                    <animateMotion
                      dur={isError ? "0.6s" : "1.2s"}
                      repeatCount="indefinite"
                      path={curvePath(
                        from.kind === "terminal" ? curve : wireCurve(a2, a1),
                      )}
                    />
                  </circle>
                )}
              </g>
            );
          })}

          {/* Each message travels its wire once, from the node that sent it. */}
          {overviewOpacity < 1 &&
            Object.values(flights).map((flight) => {
              const source = rectByKey.get(endpointKey(flight.source));
              const target = rectByKey.get(endpointKey(flight.target));
              if (!source || !target) return null;
              const [s1, s2] = facingAnchors(source, target);
              const failed = flight.status === "failed";
              return (
                <circle
                  key={`flight:${flight.requestId}`}
                  r={FLIGHT_DOT_PX / viewport.scale}
                  fill={failed ? "var(--red)" : "var(--accent)"}
                  stroke="var(--surface)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: 1 - overviewOpacity }}
                >
                  <animateMotion
                    // Started when it mounts: an SVG animation with a fixed
                    // begin would count from page load and be long over.
                    ref={(el) => (el as SVGAnimationElement | null)?.beginElement()}
                    begin="indefinite"
                    dur="0.9s"
                    fill="freeze"
                    calcMode="spline"
                    keyTimes="0;1"
                    keySplines="0.4 0 0.2 1"
                    path={curvePath(wireCurve(s1, s2))}
                  />
                </circle>
              );
            })}

          {pending &&
            (() => {
              const from = rectByKey.get(`${pending.from.kind}:${pending.from.id}`);
              if (!from) return null;
              // Over a node it could connect to, the wire snaps to the side it
              // would arrive at, so you see the wire you'll get.
              const target = dropTargetKey ? rectByKey.get(dropTargetKey) : undefined;
              const [s1, s2] = target ? facingAnchors(from, target) : anchorToward(from, pending.cursor);
              const curve = wireCurve(s1, s2);
              const arrow = ARROW_PX / viewport.scale;
              return (
                <>
                  <path
                    d={curvePath(strokeCurve(curve, false, true, arrow))}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={1.75}
                    strokeLinecap="round"
                    strokeDasharray={target ? undefined : "5 4"}
                    vectorEffect="non-scaling-stroke"
                    style={{ opacity: target ? 0.95 : 0.6 }}
                  />
                  <path d={arrowHead(curve, "end", arrow)} fill="var(--accent)" style={{ opacity: target ? 0.95 : 0.6 }} />
                </>
              );
            })()}

          {pending &&
            dropTargetKey &&
            (() => {
              const rect = rectByKey.get(dropTargetKey);
              if (!rect) return null;
              return (
                <rect
                  x={rect.x - 3 / viewport.scale}
                  y={rect.y - 3 / viewport.scale}
                  width={rect.w + 6 / viewport.scale}
                  height={rect.h + 6 / viewport.scale}
                  rx={10 / viewport.scale}
                  fill="color-mix(in srgb, var(--accent) 6%, transparent)"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: 0.9 }}
                />
              );
            })()}

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
            const rectKey = `${rect.kind}:${rect.id}`;
            const isDragSource =
              pending?.from.kind === rect.kind && pending?.from.id === rect.id;

            const activeCall = activeRectKeys.get(rectKey);
            const isActive = activeCall !== undefined;
            const activeColor =
              activeCall?.status === "error" ? "var(--red)" : "var(--accent)";
            // Dots show on the node under the pointer (or one of its dots), on
            // the node a wire is being dragged from, and while it is busy. The
            // hit circles stay live on every node, so moving off a node's edge
            // onto its dot doesn't make the dot vanish under the pointer.
            const showDots =
              hoveredKey === rectKey ||
              hoveredHandle?.startsWith(`${rectKey}:`) === true ||
              isDragSource ||
              isActive;

            return handlePoints(rect).map((point, index) => {
              const handleKey = `${rectKey}:${index}`;
              const isHovered = hoveredHandle === handleKey;
              const isLit = isHovered || isActive;
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
                      opacity: showDots
                        ? (isLit ? 1 : 0.9) * (pending !== null ? 1 : 1 - overviewOpacity)
                        : 0,
                      transition:
                        "r 0.1s ease, fill 0.1s ease, stroke 0.15s ease, opacity 0.12s ease",
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
            const [a1, a2] = facingAnchors(from, to);
            // Labels outlive the start of the map-view crossfade by a little,
            // and the two renderings have different midpoints, so the anchor
            // travels between them rather than letting the label detach from
            // whichever line is currently the prominent one.
            const wireMid = curvePoint(wireCurve(a1, a2), 0.5);
            const curveMid = curveMidpoint(from, to);
            const mid = {
              x: wireMid.x + (curveMid.x - wireMid.x) * overviewOpacity,
              y: wireMid.y + (curveMid.y - wireMid.y) * overviewOpacity,
            };
            const type = resolveConnectionType(connection);
            const spec = connectionTypeSpec(type);
            const twoWay = isTwoWay(connection) && spec.family !== "structural";
            const label = wireLabel({
              connection,
              tailAbilities: abilitiesFor(connection, connection.from),
            });
            // A Hydra worker's wire says what the worker is and how it's going.
            const hydra =
              !connection.purpose && connection.to.kind === "terminal" ? hydraStatus[connection.to.id] : undefined;
            const labelText = hydra
              ? t.wire_label_hydra.replace("{role}", hydra.role).replace("{status}", t[`hydra_status_${hydra.status}` as const])
              : label.kind === "purpose"
                ? label.text
                : t[label.key];

            return (
              <button
                key={`type-label:${connection.id}`}
                type="button"
                data-scene-box-select-block
                aria-label={t.connection_label_aria.replace("{label}", labelText)}
                title={connection.purpose}
                className="absolute rounded-full border transition-colors duration-quick hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50"
                style={{
                  left: viewport.x + mid.x * viewport.scale,
                  top: viewport.y + mid.y * viewport.scale,
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "auto",
                  fontFamily: '"Geist Mono", monospace',
                  fontSize: labelLayout.fontPx,
                  lineHeight: 1.2,
                  padding: "2px 8px",
                  boxShadow: "0 1px 3px rgb(0 0 0 / 0.25)",
                  whiteSpace: "nowrap",
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  background: "var(--surface)",
                  borderColor: "var(--border)",
                  borderStyle: "solid",
                  // Plain links say nothing runs, so their label recedes the
                  // same way their stroke does.
                  color:
                    spec.family === "structural"
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
                {twoWay ? "⇄ " : ""}
                {labelText}
              </button>
            );
          })}
        </div>
      )}

      {/* How many messages along wires are waiting for an agent's turn to
          end (electron/wire-mailbox.ts), over the agent's top-right corner.
          Clicking it offers to deliver them now or throw them away. */}
      {overviewOpacity < 1 && Object.keys(waitingMail).length > 0 && (
        <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
          {Object.entries(waitingMail).map(([terminalId, items]) => {
            const rect = rectByKey.get(`terminal:${terminalId}`);
            if (!rect) return null;
            return (
              <button
                key={`waiting:${terminalId}`}
                type="button"
                data-scene-box-select-block
                data-testid="wire-waiting-badge"
                title={`${heldMail[terminalId] ? t.wire_waiting_held_title : t.wire_waiting_title}\n${items.map((item) => `• ${item.preview}`).join("\n")}`}
                className="absolute rounded-full border text-[11px]"
                style={{
                  left: viewport.x + (rect.x + rect.w) * viewport.scale,
                  top: viewport.y + rect.y * viewport.scale,
                  transform: "translate(-100%, calc(-100% - 6px))",
                  pointerEvents: "auto",
                  padding: "1px 8px",
                  fontFamily: '"Geist Mono", monospace',
                  background: "var(--surface)",
                  borderColor: "color-mix(in srgb, var(--accent) 55%, var(--border))",
                  color: "var(--accent)",
                  opacity: 1 - overviewOpacity,
                  cursor: "pointer",
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setWaitingMenu({ x: event.clientX, y: event.clientY, terminalId });
                }}
              >
                ✉ {(heldMail[terminalId] ? t.wire_waiting_held_badge : t.wire_waiting_badge).replace("{n}", String(items.length))}
              </button>
            );
          })}
        </div>
      )}

      {/* The first words of each message, beside the node it is arriving at,
          for as long as its dot is on the wire. */}
      {labelLayout.visible && overviewOpacity < 1 && (
        <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
          {Object.values(flights).map((flight) => {
            if (!flight.preview) return null;
            const source = rectByKey.get(endpointKey(flight.source));
            const target = rectByKey.get(endpointKey(flight.target));
            if (!source || !target) return null;
            const [, arrive] = facingAnchors(source, target);
            const failed = flight.status === "failed";
            // Beside the end of the wire, outside the node it arrives at:
            // never over the node it is talking to, nor over the last stretch
            // of wire where its dot lands.
            const gap = 10;
            const shift: Record<typeof arrive.side, string> = {
              left: `translate(calc(-100% - ${gap}px), calc(-100% - ${gap}px))`,
              right: `translate(${gap}px, calc(-100% - ${gap}px))`,
              top: `translate(${gap}px, calc(-100% - ${gap}px))`,
              bottom: `translate(${gap}px, ${gap}px)`,
            };
            return (
              <div
                key={`flight-preview:${flight.requestId}`}
                className="tc-wire-preview absolute rounded-md border"
                style={{
                  left: viewport.x + arrive.x * viewport.scale,
                  top: viewport.y + arrive.y * viewport.scale,
                  transform: shift[arrive.side],
                  maxWidth: 260,
                  padding: "3px 8px",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontFamily: '"Geist Mono", monospace',
                  fontSize: 11,
                  lineHeight: 1.3,
                  background: "var(--surface)",
                  borderColor: failed ? "var(--red)" : "color-mix(in srgb, var(--accent) 45%, var(--border))",
                  color: failed ? "var(--red)" : "var(--text-secondary)",
                  boxShadow: "0 2px 8px rgb(0 0 0 / 0.3)",
                  opacity: 1 - overviewOpacity,
                }}
              >
                {flight.preview}
              </div>
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
          <WirePanel
            key={typeMenuTarget.connection.id}
            x={typeMenuTarget.x}
            y={typeMenuTarget.y}
            connection={typeMenuTarget.connection}
            fromName={describeEndpoint(typeMenuTarget.connection.from, labelContext)}
            toName={describeEndpoint(typeMenuTarget.connection.to, labelContext)}
            recent={
              recentByPair[
                connectionEventPairKey(typeMenuTarget.connection.from, typeMenuTarget.connection.to)
              ] ?? []
            }
            nameOf={(endpoint) => describeEndpoint(endpoint, labelContext)}
            onClose={() => setTypeMenu(null)}
          />
        </div>
      )}

      {waitingMenu && (
        <div style={{ pointerEvents: "auto" }}>
          <ContextMenu
            x={waitingMenu.x}
            y={waitingMenu.y}
            items={[
              {
                label: t.wire_waiting_deliver,
                onClick: () => void window.tacit.wires.flushWaiting(waitingMenu.terminalId),
              },
              { type: "separator" },
              {
                label: t.wire_waiting_discard,
                danger: true,
                onClick: () => void window.tacit.wires.discardWaiting(waitingMenu.terminalId),
              },
            ]}
            onClose={() => setWaitingMenu(null)}
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
                label: t.connection_open_panel,
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
