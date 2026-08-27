import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type OnMove,
  type NodeMouseHandler,
  type OnNodeDrag,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  addProjectFromDirectoryPath,
  clearSceneFocusAndSelection,
  promptAndAddProjectToScene,
} from "./sceneCommands";
import { CanvasDragoverCue } from "./CanvasDragoverCue";
import { CanvasEmptyState } from "../components/CanvasEmptyState";
import { useCanvasDragOver } from "./useCanvasDragOver";
import { getStashedTerminalIds } from "./sceneState";
import { useProjectStore } from "../stores/projectStore";
import { useCanvasStore } from "../stores/canvasStore";
import { usePinStore } from "../stores/pinStore";
import { useDrawingStore } from "../stores/drawingStore";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useSidebarDragStore } from "../stores/sidebarDragStore";
import {
  PANEL_TRANSITION_DURATION_MS,
  PANEL_TRANSITION_EASING_CSS,
} from "../utils/panelAnimation";
import { useT } from "../i18n/useT";
import { FamilyTreeOverlay } from "../components/FamilyTreeOverlay";
import { FocusCaretOverlay } from "../components/FocusCaretOverlay";
import { BoxSelectOverlay } from "./BoxSelectOverlay";
import { LayerErrorBoundary } from "../components/LayerErrorBoundary";
import { CanvasCardLayer } from "./CanvasCardLayer";
import { DrawingLayer } from "./DrawingLayer";
import { PetOverlay } from "../pet/PetOverlay";
import { useBoxSelect } from "../hooks/useBoxSelect";
import { useTrackpadSwipeFocus } from "./trackpadSwipeFocus";
import {
  resolveTerminalWheelConsumer,
  scrollRoomFromScrollElement,
  scrollRoomFromXtermBuffer,
  type TerminalScrollRoom,
} from "./terminalWheelRouting";
import { getTerminalScrollPosition } from "../terminal/terminalRegistry";
import {
  publishTerminalGeometry,
  unpublishTerminalGeometry,
} from "../terminal/terminalGeometryRegistry";
import { resolveTerminalMountMode } from "../terminal/terminalRuntimePolicy";
import {
  destroyTerminalRuntime,
  setTerminalRuntimeMode,
  updateTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { fromFlowViewport, toFlowViewport } from "./viewportAdapter";
import { buildCanvasFlowNodes, buildPinFlowNodes } from "./nodeProjection";
import { xyflowNodeTypes, type CanvasFlowNode } from "./xyflowNodes";
import {
  getCanvasLeftInset,
  getVisibleCanvasWorldRect,
  rectIntersectsCanvasViewport,
} from "./viewportBounds";
import { clampScale, zoomAtClientPoint } from "./viewportZoom";
import { useBrowserCardStore } from "../stores/browserCardStore";
import {
  collectFocusableNodes,
  closestFocusableNode,
  focusableNodeKey,
  type FocusableNode,
} from "./focusableNodes";
import { flyToBounds } from "../utils/panToTerminal";
import { createSwipeDetector } from "./swipeDetector";
import { resolveCollisions } from "./collisionResolver";
import { WorktreeLabelLayer } from "./WorktreeLabelLayer";
import { ConnectionLayer } from "./ConnectionLayer";
import { SpatialWaypointsLayer } from "./SpatialWaypointsLayer";
import { ContextMenu } from "../components/ContextMenu";
import { createTerminalInScene } from "../actions/terminalSceneActions";
import { addBrowserCardToScene } from "../actions/sceneCardActions";
import { createNoteInScene, updatePinInScene } from "../actions/scenePinActions";
import type { TerminalType, Pin } from "../types";

const EMPTY_EDGES: never[] = [];
const WHEEL_ZOOM_SENSITIVITY = 0.005;
const SNAP_GRID: [number, number] = [10, 10];
const CONTEXT_MENU_TERMINAL_TYPES: { label: string; type: TerminalType }[] = [
  { label: "New Shell", type: "shell" },
  { label: "New Claude", type: "claude" },
  { label: "New Codex", type: "codex" },
  { label: "New Gemini", type: "gemini" },
  { label: "New Lazygit", type: "lazygit" },
];
// Canvas opacity only does anything on mac, where the window is created
// transparent (electron/main.ts createWindow). Elsewhere the window is
// opaque, so applying alpha here would just fade to black.
const IS_MAC = (window.termcanvas?.app.platform ?? "darwin") === "darwin";

function normalizeWheelDelta(event: {
  deltaMode: number;
  deltaY: number;
}): number {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY * 16;
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY * window.innerHeight;
    default:
      return event.deltaY;
  }
}

/**
 * Build a stable cache key for the terminal layout.
 * In the flat canvas model, each terminal's own position and size
 * determines the layout (no project/worktree container offsets).
 */
function buildLayoutKey(
  projects: ReturnType<typeof useProjectStore.getState>["projects"],
) {
  return projects
    .map((project) =>
      [
        project.id,
        project.worktrees
          .map((worktree) =>
            [
              worktree.id,
              worktree.terminals
                .map(
                  (t) =>
                    `${t.id}:${t.x},${t.y},${t.width}x${t.height}:${t.stashed ? 1 : 0}:${t.minimized ? 1 : 0}`,
                )
                .join(","),
            ].join(":"),
          )
          .join(";"),
      ].join("|"),
    )
    .join("||");
}

/** Same rebuild-avoidance idea as buildLayoutKey, for note (pin) nodes:
 * only x/y/w/h changes should force the node array to rebuild — a body/title
 * edit changes the Pin object's identity in the store but shouldn't. */
function buildPinLayoutKey(pins: Pin[]): string {
  return pins
    .filter((pin) => pin.x != null && pin.y != null)
    .map((pin) => `${pin.id}:${pin.x},${pin.y},${pin.w ?? ""}x${pin.h ?? ""}`)
    .join(",");
}

function TerminalRuntimeLayer({
  projects,
  viewport,
  rightPanelCollapsed,
  rightPanelWidth,
  leftPanelCollapsed,
  leftPanelWidth,
  taskDrawerOpen,
}: {
  projects: ReturnType<typeof useProjectStore.getState>["projects"];
  viewport: ReturnType<typeof useCanvasStore.getState>["viewport"];
  rightPanelCollapsed: boolean;
  rightPanelWidth: number;
  leftPanelCollapsed: boolean;
  leftPanelWidth: number;
  taskDrawerOpen: boolean;
}) {
  const managedTerminalIdsRef = useRef<Set<string>>(new Set());
  const publishedTerminalIdsRef = useRef<Set<string>>(new Set());

  const runtimeMetas = useMemo(
    () =>
      projects.flatMap((project) =>
        project.worktrees.flatMap((worktree) =>
          worktree.terminals.map((terminal) => ({
            projectId: project.id,
            terminal,
            worktreeId: worktree.id,
            worktreePath: worktree.path,
          })),
        ),
      ),
    [projects],
  );

  // Flat terminal entries — no project/worktree offset calculation needed
  const terminalEntries = useMemo(
    () =>
      projects.flatMap((project) =>
        project.worktrees.flatMap((worktree) =>
          worktree.terminals
            .filter((t) => !t.stashed)
            .map((terminal) => ({
              absoluteRect: {
                x: terminal.x,
                y: terminal.y,
                w: terminal.width,
                h: terminal.height,
              },
              project,
              terminal,
              worktree,
            })),
        ),
      ),
    [projects],
  );

  useEffect(() => {
    const nextTerminalIds = new Set<string>();

    for (const meta of runtimeMetas) {
      nextTerminalIds.add(meta.terminal.id);
      updateTerminalRuntime(meta);
    }

    const stashedIds = getStashedTerminalIds(projects);
    for (const terminalId of managedTerminalIdsRef.current) {
      if (!nextTerminalIds.has(terminalId) && !stashedIds.has(terminalId)) {
        destroyTerminalRuntime(terminalId, {
          caller: "TerminalRuntimeLayer.runtimeMetasEffect",
          reason: "terminal_removed_from_runtime_metas",
        });
      }
    }

    managedTerminalIdsRef.current = nextTerminalIds;
  }, [runtimeMetas]);

  useEffect(() => {
    const nextTerminalIds = new Set<string>();

    for (const entry of terminalEntries) {
      nextTerminalIds.add(entry.terminal.id);
      publishTerminalGeometry({
        h: entry.absoluteRect.h,
        projectId: entry.project.id,
        terminalId: entry.terminal.id,
        worktreeId: entry.worktree.id,
        w: entry.absoluteRect.w,
        x: entry.absoluteRect.x,
        y: entry.absoluteRect.y,
      });
    }

    for (const terminalId of publishedTerminalIdsRef.current) {
      if (!nextTerminalIds.has(terminalId)) {
        unpublishTerminalGeometry(terminalId);
      }
    }

    publishedTerminalIdsRef.current = nextTerminalIds;
  }, [terminalEntries]);

  useEffect(() => {
    const visibleEntryIds = new Set(
      terminalEntries.map((entry) => entry.terminal.id),
    );

    for (const project of projects) {
      for (const worktree of project.worktrees) {
        for (const terminal of worktree.terminals) {
          if (!visibleEntryIds.has(terminal.id)) {
            setTerminalRuntimeMode(terminal.id, "parked", {
              caller: "TerminalRuntimeLayer.visibilityEffect",
              reason: "terminal_missing_from_visible_entries",
            });
          }
        }
      }
    }

    for (const entry of terminalEntries) {
      const visible = rectIntersectsCanvasViewport(
        entry.absoluteRect,
        viewport,
        rightPanelCollapsed,
        leftPanelCollapsed,
        leftPanelWidth,
        rightPanelWidth,
        taskDrawerOpen,
      );
      setTerminalRuntimeMode(
        entry.terminal.id,
        resolveTerminalMountMode({
          focused: entry.terminal.focused,
          visible,
        }),
        {
          caller: "TerminalRuntimeLayer.visibilityEffect",
          detail: {
            visible,
          },
          reason: "viewport_visibility_recomputed",
        },
      );
    }
  }, [
    leftPanelCollapsed,
    leftPanelWidth,
    projects,
    rightPanelCollapsed,
    rightPanelWidth,
    taskDrawerOpen,
    terminalEntries,
    viewport,
  ]);

  useEffect(
    () => () => {
      for (const terminalId of managedTerminalIdsRef.current) {
        destroyTerminalRuntime(terminalId, {
          caller: "TerminalRuntimeLayer.cleanup",
          reason: "terminal_runtime_layer_unmount",
        });
      }

      for (const terminalId of publishedTerminalIdsRef.current) {
        unpublishTerminalGeometry(terminalId);
      }
    },
    [],
  );

  return null;
}

function XyFlowCanvasInner() {
  const t = useT();
  const viewport = useCanvasStore((state) => state.viewport);
  const isAnimating = useCanvasStore((state) => state.isAnimating);
  const rightPanelCollapsed = useCanvasStore(
    (state) => state.rightPanelCollapsed,
  );
  const leftPanelCollapsed = useCanvasStore(
    (state) => state.leftPanelCollapsed,
  );
  const leftPanelWidth = useCanvasStore((state) => state.leftPanelWidth);
  const rightPanelWidth = useCanvasStore((state) => state.rightPanelWidth);
  const taskDrawerOpen = usePinStore(
    (state) => state.openProjectPath !== null,
  );
  const pinsByProject = usePinStore((state) => state.pinsByProject);
  const projects = useProjectStore((state) => state.projects);
  const drawingEnabled = usePreferencesStore((state) => state.drawingEnabled);
  const petEnabled = usePreferencesStore((state) => state.petEnabled);
  const activityHeatmapEnabled = usePreferencesStore(
    (state) => state.activityHeatmapEnabled,
  );
  const animationBlur = usePreferencesStore((state) => state.animationBlur);
  const canvasOpacity = usePreferencesStore((state) => state.canvasOpacity);
  const canvasBackgroundImage = usePreferencesStore(
    (state) => state.canvasBackgroundImage,
  );
  const drawingTool = useDrawingStore((state) => state.tool);
  const canvasTool = useCanvasToolStore((state) => state.tool);
  const spaceHeld = useCanvasToolStore((state) => state.spaceHeld);
  const { handleMouseDown: handleBoxSelectMouseDown } = useBoxSelect();
  const layoutKey = useMemo(() => buildLayoutKey(projects), [projects]);
  const allPins = useMemo(
    () => Object.values(pinsByProject).flat(),
    [pinsByProject],
  );
  const pinLayoutKey = useMemo(() => buildPinLayoutKey(allPins), [allPins]);
  const leftOffset = getCanvasLeftInset(
    leftPanelCollapsed,
    leftPanelWidth,
    taskDrawerOpen,
  );
  const sidebarDragging = useSidebarDragStore((s) => s.active);
  const isDrawing = drawingEnabled && drawingTool !== "select";
  const isPanMode = canvasTool === "hand" || spaceHeld;
  const [isPanning, setIsPanning] = useState(false);
  const previousAnimatingRef = useRef(isAnimating);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  useTrackpadSwipeFocus(canvasContainerRef);

  const focusMode = useCanvasStore((state) => state.focusMode);
  const browserCardMap = useBrowserCardStore((state) => state.cards);
  const focusSwipeDetectorRef = useRef(createSwipeDetector());
  const previousFocusableListRef = useRef<FocusableNode[]>([]);

  const reactFlow = useReactFlow();
  const [contextMenu, setContextMenu] = useState<{
    clientX: number;
    clientY: number;
    flowX: number;
    flowY: number;
  } | null>(null);

  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const flow = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setContextMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        flowX: flow.x,
        flowY: flow.y,
      });
    },
    [reactFlow],
  );

  const handleContextMenuPick = useCallback(
    (type: TerminalType) => {
      if (!contextMenu) return;
      const {
        focusedProjectId,
        focusedWorktreeId,
        projects: currentProjects,
      } = useProjectStore.getState();
      let projectId = focusedProjectId;
      let worktreeId = focusedWorktreeId;
      if (!projectId || !worktreeId) {
        const fallbackProject = currentProjects[0];
        const fallbackWorktree = fallbackProject?.worktrees[0];
        if (!fallbackProject || !fallbackWorktree) {
          return;
        }
        projectId = fallbackProject.id;
        worktreeId = fallbackWorktree.id;
      }
      createTerminalInScene({
        projectId,
        worktreeId,
        type,
        position: { x: contextMenu.flowX, y: contextMenu.flowY },
      });
    },
    [contextMenu],
  );

  const handleAddBrowserFromMenu = useCallback(() => {
    if (!contextMenu) return;
    addBrowserCardToScene({ x: contextMenu.flowX, y: contextMenu.flowY });
  }, [contextMenu]);

  const handleAddNoteFromMenu = useCallback(() => {
    if (!contextMenu) return;
    const { focusedProjectId, projects: currentProjects } =
      useProjectStore.getState();
    const project =
      currentProjects.find((p) => p.id === focusedProjectId) ??
      currentProjects[0];
    if (!project) return;
    void createNoteInScene(project.path, {
      x: contextMenu.flowX,
      y: contextMenu.flowY,
    });
  }, [contextMenu]);

  const projectedNodes = useMemo(
    () => [...buildCanvasFlowNodes(projects), ...buildPinFlowNodes(allPins)],
    [layoutKey, pinLayoutKey],
  );
  const [nodes, setNodes, onNodesChange] =
    useNodesState<CanvasFlowNode>(projectedNodes);

  useEffect(() => {
    setNodes(projectedNodes);
  }, [projectedNodes, setNodes]);

  useEffect(
    () => () => {
      useCanvasStore.getState().registerViewportAdapter(null);
    },
    [],
  );

  const focusableList = useMemo(
    () => collectFocusableNodes(nodes, browserCardMap),
    [nodes, browserCardMap],
  );

  const goToOffset = useCallback(
    (direction: 1 | -1) => {
      const state = useCanvasStore.getState();
      if (!state.focusMode.active) return;
      const list = focusableList;
      if (list.length === 0) return;
      const currentIndex = list.findIndex(
        (n) => focusableNodeKey(n.kind, n.id) === state.focusMode.currentKey,
      );
      const nextIndex = Math.min(
        Math.max(currentIndex + direction, 0),
        list.length - 1,
      );
      if (nextIndex === currentIndex) return;
      const target = list[nextIndex];
      flyToBounds(target.x, target.y, target.w, target.h);
      state.setFocusModeCurrentKey(focusableNodeKey(target.kind, target.id));
    },
    [focusableList],
  );

  // Resolve the entry node on activation, follow node create/delete while
  // focused, and exit gracefully if the canvas becomes empty — the only
  // ways `focusMode.currentKey` should change outside of an explicit swipe.
  useEffect(() => {
    if (!focusMode.active) {
      previousFocusableListRef.current = focusableList;
      return;
    }

    if (focusableList.length === 0) {
      useCanvasStore.getState().exitFocusMode();
      previousFocusableListRef.current = focusableList;
      return;
    }

    const currentStillExists =
      focusMode.currentKey !== null &&
      focusableList.some(
        (n) => focusableNodeKey(n.kind, n.id) === focusMode.currentKey,
      );

    if (focusMode.currentKey === null) {
      const visibleRect = getVisibleCanvasWorldRect(
        viewport,
        rightPanelCollapsed,
        leftPanelCollapsed,
        leftPanelWidth,
        rightPanelWidth,
        taskDrawerOpen,
      );
      const centerPoint = {
        x: visibleRect.x + visibleRect.w / 2,
        y: visibleRect.y + visibleRect.h / 2,
      };
      const closest = closestFocusableNode(focusableList, centerPoint);
      if (closest) {
        flyToBounds(closest.x, closest.y, closest.w, closest.h);
        useCanvasStore
          .getState()
          .setFocusModeCurrentKey(focusableNodeKey(closest.kind, closest.id));
      }
    } else if (!currentStillExists) {
      const previousList = previousFocusableListRef.current;
      const previousIndex = previousList.findIndex(
        (n) => focusableNodeKey(n.kind, n.id) === focusMode.currentKey,
      );
      const fallbackIndex = Math.min(
        Math.max(previousIndex, 0),
        focusableList.length - 1,
      );
      const fallback = focusableList[fallbackIndex];
      if (fallback) {
        flyToBounds(fallback.x, fallback.y, fallback.w, fallback.h);
        useCanvasStore
          .getState()
          .setFocusModeCurrentKey(
            focusableNodeKey(fallback.kind, fallback.id),
          );
      }
    } else if (
      previousFocusableListRef.current.length > 0 &&
      focusableList.length > previousFocusableListRef.current.length
    ) {
      const previousKeys = new Set(
        previousFocusableListRef.current.map((n) =>
          focusableNodeKey(n.kind, n.id),
        ),
      );
      const created = focusableList.find(
        (n) => !previousKeys.has(focusableNodeKey(n.kind, n.id)),
      );
      if (created) {
        flyToBounds(created.x, created.y, created.w, created.h);
        useCanvasStore
          .getState()
          .setFocusModeCurrentKey(focusableNodeKey(created.kind, created.id));
      }
    }

    previousFocusableListRef.current = focusableList;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusableList, focusMode.active, focusMode.currentKey]);

  useEffect(() => {
    if (!focusMode.active) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToOffset(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToOffset(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusMode.active, goToOffset]);

  const handleInit = useCallback(
    (reactFlow: ReactFlowInstance<CanvasFlowNode>) => {
      useCanvasStore.getState().registerViewportAdapter({
        setViewport: (nextViewport, options) => {
          void reactFlow.setViewport(
            {
              x: nextViewport.x,
              y: nextViewport.y,
              zoom: nextViewport.scale,
            },
            options,
          );
        },
        getViewport: () => {
          const current = reactFlow.getViewport();
          return fromFlowViewport(current);
        },
      });
      useCanvasStore
        .getState()
        .syncViewportFromRenderer(fromFlowViewport(reactFlow.getViewport()));
    },
    [],
  );

  const handleMove = useCallback<OnMove>(
    (_event, nextViewport) => {
      const vp = fromFlowViewport(nextViewport);
      const snapped = {
        x: Math.round(vp.x),
        y: Math.round(vp.y),
        scale: vp.scale,
      };

      // Snap viewport translation to integer pixels during pan. When the
      // transform has fractional coordinates, 1px borders / background dots /
      // text edges render across sub-pixel boundaries and snap between pixel
      // grids frame-to-frame. This produces the "stutter" and eye-strain the
      // user describes as "low grid adhesion". Rounding forces the GPU
      // compositor to align to physical pixels, eliminating the jitter.
      if (snapped.x !== vp.x || snapped.y !== vp.y) {
        reactFlow.setViewport(
          { x: snapped.x, y: snapped.y, zoom: snapped.scale },
          { duration: 0 },
        );
      }

      useCanvasStore.getState().syncViewportFromRenderer(snapped);
    },
    [reactFlow],
  );

  const handleMoveEnd = useCallback<OnMove>((_event, nextViewport) => {
    const vp = fromFlowViewport(nextViewport);
    const snapped = {
      x: Math.round(vp.x),
      y: Math.round(vp.y),
      scale: vp.scale,
    };
    useCanvasStore.getState().commitViewportFromRenderer(snapped);
  }, []);

  const handlePaneClick = useCallback(() => {
    clearSceneFocusAndSelection();
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<CanvasFlowNode>>(
    (_event, node) => {
      // Space-held panning is a transient override on top of whatever
      // tool is active — a click that lands while Space is down is the
      // tail of a pan gesture, so suppress the activate. Persistent
      // Hand mode is different: clicking a terminal there is the user's
      // way of getting *into* a terminal without leaving Hand. Without
      // this distinction the now-default Hand tool can't focus a
      // worktree by clicking, which made the canvas feel inert.
      if (spaceHeld) return;
      if (node.type !== "terminal") return;
      const { projectId, worktreeId } = node.data;
      useProjectStore.getState().setFocusedWorktree(projectId, worktreeId);
    },
    [spaceHeld],
  );

  const handleNodeDragStart = useCallback<OnNodeDrag<CanvasFlowNode>>(() => {
    // No-op in flat canvas — no bringToFront needed
  }, []);

  const handleNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>(
    (_event, node) => {
      if (node.type === "pin") {
        const { pinId, projectPath } = node.data;
        const snappedX = Math.round(node.position.x / SNAP_GRID[0]) * SNAP_GRID[0];
        const snappedY = Math.round(node.position.y / SNAP_GRID[1]) * SNAP_GRID[1];
        updatePinInScene(projectPath, pinId, { x: snappedX, y: snappedY });
        return;
      }

      // Write terminal position back to store
      const { projectId, worktreeId, terminalId } = node.data;
      const snappedX =
        Math.round(node.position.x / SNAP_GRID[0]) * SNAP_GRID[0];
      const snappedY =
        Math.round(node.position.y / SNAP_GRID[1]) * SNAP_GRID[1];
      useProjectStore
        .getState()
        .updateTerminalPosition(
          projectId,
          worktreeId,
          terminalId,
          snappedX,
          snappedY,
        );

      // Resolve collisions after drag
      const allProjects = useProjectStore.getState().projects;
      const allRects = allProjects.flatMap((p) =>
        p.worktrees.flatMap((w) =>
          w.terminals
            .filter((t) => !t.stashed)
            .map((t) => ({
              id: t.id,
              x: t.id === terminalId ? snappedX : t.x,
              y: t.id === terminalId ? snappedY : t.y,
              width: t.width,
              height: t.height,
            })),
        ),
      );
      const resolved = resolveCollisions(allRects, 8, terminalId);
      const updatePos = useProjectStore.getState().updateTerminalPosition;
      for (const rect of resolved) {
        if (rect.id === terminalId) continue;
        const original = allRects.find((r) => r.id === rect.id);
        if (original && (original.x !== rect.x || original.y !== rect.y)) {
          for (const p of allProjects) {
            for (const w of p.worktrees) {
              if (w.terminals.some((t) => t.id === rect.id)) {
                updatePos(p.id, w.id, rect.id, rect.x, rect.y);
              }
            }
          }
        }
      }
    },
    [],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        return;
      }

      const file = files[0];
      const dirPath = window.termcanvas.fs.getFilePath(file);
      if (!dirPath) {
        return;
      }

      await addProjectFromDirectoryPath(dirPath, t);
    },
    [t],
  );

  const { state: dragOverState, handlers: dragOverHandlers } =
    useCanvasDragOver({ onDrop: handleDrop });

  const handleAddProject = useCallback(async () => {
    await promptAndAddProjectToScene(t);
  }, [t]);

  // Terminal renderers mount into one of these hosts: the xterm engine into
  // `.tc-xterm-host`, the wterm engine into `.tc-wterm-host`. Both have to be
  // recognised here — a host this selector misses can never receive a wheel
  // event, because the capture-phase handler below swallows everything it does
  // not explicitly hand off.
  const resolveWheelConsumerForEvent = useCallback((event: WheelEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return "canvas" as const;
    }

    const host = target.closest(".tc-xterm-host, .tc-wterm-host");
    const tile = host?.closest("[data-handoff-terminal-id]");
    if (!host || !tile) {
      return "canvas" as const;
    }

    const terminalId = tile.getAttribute("data-handoff-terminal-id");
    const bufferPosition = terminalId
      ? getTerminalScrollPosition(terminalId)
      : null;

    let room: TerminalScrollRoom | null = null;
    if (bufferPosition) {
      room = scrollRoomFromXtermBuffer(bufferPosition);
    } else if (host instanceof HTMLElement) {
      // wterm renders into a plain DOM scroll container rather than an xterm
      // buffer, so its remaining travel comes off the element itself.
      room = scrollRoomFromScrollElement(host);
    }

    return resolveTerminalWheelConsumer({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      overTerminal: true,
      terminalFocused: tile.getAttribute("data-focused") === "true",
      room,
    });
  }, []);

  const handleWheelCapture = useCallback(
    (event: WheelEvent) => {
      if (useCanvasStore.getState().focusMode.active) {
        // Focus view owns the wheel entirely: pinch/pan do nothing, only a
        // quick 2-finger horizontal flick pages to the next/previous node.
        // Only exempt genuinely vertical-dominant gestures (real scrollback
        // intent) to the terminal under the cursor — a horizontal swipe
        // must always reach the pager below, even while the cursor sits on
        // top of the focused node's content (which it will, immediately
        // after the very first page, since focus view zooms that node to
        // fill the screen). Gating only on vertical/horizontal dominance,
        // not on hovering, is what keeps back-to-back swipes working
        // without needing to nudge the cursor between them.
        const isVerticalDominant =
          Math.abs(event.deltaY) >= Math.abs(event.deltaX);
        if (
          isVerticalDominant &&
          resolveWheelConsumerForEvent(event) === "terminal"
        ) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const { triggered, direction } =
          focusSwipeDetectorRef.current.handleWheel(event);
        if (triggered && direction) {
          goToOffset(direction);
        }
        return;
      }

      const isPinch = event.ctrlKey || event.metaKey;

      // Pinch (Cmd/Ctrl + wheel, or trackpad pinch which Chromium
      // synthesises as ctrlKey=true): always zoom canvas, regardless of
      // cursor position. Terminal has no zoom concept.
      if (isPinch) {
        event.preventDefault();
        event.stopPropagation();

        const delta = normalizeWheelDelta(event);
        if (Math.abs(delta) < 0.001) {
          return;
        }

        const scaleFactor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
        const nextViewport = zoomAtClientPoint({
          clientX: event.clientX,
          clientY: event.clientY,
          leftPanelCollapsed,
          leftPanelWidth,
          taskDrawerOpen,
          nextScale: clampScale(viewport.scale * scaleFactor),
          viewport,
        });

        useCanvasStore.getState().setViewport(nextViewport);
        return;
      }

      // Non-pinch wheel: this handler owns ALL canvas pan, since React Flow's
      // panOnScroll is disabled. The exception is a terminal under the cursor
      // that can consume the gesture as scrollback — the focused tile always
      // can, an unfocused one only while it still has buffer left to travel in
      // that direction, after which the gesture chains on to the camera.
      // See terminalWheelRouting.ts for the full rule.
      if (resolveWheelConsumerForEvent(event) === "terminal") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Read viewport fresh from the store, not from the closure.
      // Wheel events fire 60+/s; closure-captured viewport stays stale
      // until React re-renders, so multiple in-flight events would all
      // base off the same old position and overwrite each other.
      const current = useCanvasStore.getState().viewport;
      // 0.5 matches React Flow's panOnScrollSpeed default. Keeps the
      // pan speed consistent with what users were used to before this
      // change, and is what handleMove's snap was tuned for.
      const PAN_SPEED = 0.5;
      useCanvasStore.getState().setViewport({
        ...current,
        x: Math.round(current.x - event.deltaX * PAN_SPEED),
        y: Math.round(current.y - event.deltaY * PAN_SPEED),
      });
    },
    [
      leftPanelCollapsed,
      leftPanelWidth,
      taskDrawerOpen,
      viewport,
      goToOffset,
      resolveWheelConsumerForEvent,
    ],
  );

  // Attached as a real native listener (not JSX onWheelCapture) because
  // React registers onWheel/onWheelCapture as passive by default, which
  // silently no-ops preventDefault() — fine for plain pan/zoom (nothing
  // else competes for the gesture) but fatal for focus view's swipe-to-
  // page, which must actually suppress the browser/OS's native 2-finger
  // "swipe = back/forward navigation" gesture it's repurposing. Mirrors
  // trackpadSwipeFocus.ts's own listener for the same reason.
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheelCapture, {
      passive: false,
      capture: true,
    });
    return () => {
      container.removeEventListener("wheel", handleWheelCapture, {
        capture: true,
      });
    };
  }, [handleWheelCapture]);

  const handleContainerMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isPanMode && event.button === 0) {
        setIsPanning(true);
      }
      handleBoxSelectMouseDown(event);
    },
    [handleBoxSelectMouseDown, isPanMode],
  );

  useEffect(() => {
    if (!isPanning) return;
    const stop = () => setIsPanning(false);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [isPanning]);

  // isPanning takes precedence over isPanMode for the cursor: if the
  // user holds Space, presses the mouse, then releases Space before
  // mouseup, the gesture is still in flight and the cursor must keep
  // saying "grabbing". Without this, the cursor snaps back to default
  // mid-drag.
  const cursorClass = isDrawing
    ? "cursor-crosshair"
    : isPanning
      ? "cursor-grabbing"
      : isPanMode
        ? "cursor-grab"
        : "";

  // Cursors set on the outer div lose to the `cursor: text !important`
  // rule that .tc-xterm-host / .xterm enforces inside terminal tiles.
  // Toggle body classes that the matching CSS overrides target so the
  // pan cursor wins everywhere on the canvas, not just over empty
  // pane.
  useEffect(() => {
    const body = document.body;
    body.classList.toggle("tc-canvas-pan-mode", isPanMode || isPanning);
    body.classList.toggle("tc-canvas-pan-grabbing", isPanning);
    return () => {
      body.classList.remove("tc-canvas-pan-mode");
      body.classList.remove("tc-canvas-pan-grabbing");
    };
  }, [isPanMode, isPanning]);

  const canvasBgStyle: React.CSSProperties = {
    ...(IS_MAC && canvasOpacity < 100
      ? {
          backgroundColor: `color-mix(in srgb, var(--bg) ${canvasOpacity}%, transparent)`,
        }
      : {}),
    // A user-picked background image sits above the opacity tint (which
    // exists to fade the canvas to the desktop behind a transparent
    // window) — the two features aren't meant to combine, an image
    // means there's no "desktop showing through" to fade to.
    ...(canvasBackgroundImage
      ? {
          backgroundImage: `url("${canvasBackgroundImage}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }
      : {}),
  };

  return (
    <div
      ref={canvasContainerRef}
      className={`fixed top-0 right-0 bottom-0 overflow-hidden canvas-bg ${cursorClass}`}
      data-activity-heatmap={activityHeatmapEnabled ? "true" : undefined}
      style={{
        left: leftOffset,
        transition: sidebarDragging
          ? undefined
          : `left ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}`,
        ...canvasBgStyle,
      }}
      onMouseDownCapture={handleContainerMouseDown}
      onDragEnter={dragOverHandlers.onDragEnter}
      onDragOver={dragOverHandlers.onDragOver}
      onDragLeave={dragOverHandlers.onDragLeave}
      onDrop={dragOverHandlers.onDrop}
    >
      <TerminalRuntimeLayer
        projects={projects}
        viewport={viewport}
        rightPanelCollapsed={rightPanelCollapsed}
        rightPanelWidth={rightPanelWidth}
        leftPanelCollapsed={leftPanelCollapsed}
        leftPanelWidth={leftPanelWidth}
        taskDrawerOpen={taskDrawerOpen}
      />
      <ReactFlow
        className="tc-xyflow"
        style={{
          willChange: isAnimating ? "transform" : undefined,
          filter:
            animationBlur > 0 && isAnimating
              ? `blur(${animationBlur}px)`
              : "none",
          transition: animationBlur > 0 ? "filter 0.15s ease" : "none",
        }}
        defaultViewport={toFlowViewport(viewport)}
        nodes={nodes}
        edges={EMPTY_EDGES}
        nodeTypes={xyflowNodeTypes}
        onInit={handleInit}
        onNodesChange={onNodesChange}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        nodesConnectable={false}
        nodesDraggable={!isPanMode && !focusMode.active}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        selectNodesOnDrag={false}
        // In Hand mode (or Space-held), left+middle both pan. In Move
        // mode, only middle-button pans — the left button is reserved
        // for marquee on empty canvas (handled by useBoxSelect) and
        // node drag (handled by React Flow's nodesDraggable).
        panOnDrag={isPanMode ? [0, 1] : [1]}
        snapToGrid
        snapGrid={SNAP_GRID}
        zoomOnScroll={false}
        zoomOnPinch={false}
        minZoom={0.1}
        maxZoom={2}
        // Runtime park/live policy already downshifts offscreen terminals to
        // preview mode. Letting React Flow also cull offscreen nodes causes
        // TerminalTile remount churn during viewport animation and focus
        // cycling, which in turn destabilizes xterm/WebGL lifecycle.
        preventScrolling
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={2} color="var(--border)" />
      </ReactFlow>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.clientX}
          y={contextMenu.clientY}
          items={[
            {
              label: t.canvas_empty_action,
              onClick: () => {
                void handleAddProject();
              },
            },
            { type: "separator" },
            ...CONTEXT_MENU_TERMINAL_TYPES.map(({ label, type }) => ({
              label,
              onClick: () => handleContextMenuPick(type),
            })),
            {
              label: "New Browser",
              onClick: handleAddBrowserFromMenu,
            },
            {
              label: "New Note",
              onClick: handleAddNoteFromMenu,
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* One boundary per overlay, not one around the group: sharing a
          boundary would mean a crash in any of them takes out all of them,
          which is the same failure mode at a smaller scale. The terminals
          themselves are NOT wrapped here — they live in TerminalRuntimeLayer
          above, and a boundary around that would unmount live PTY views. */}
      <LayerErrorBoundary name="Selection">
        <BoxSelectOverlay />
      </LayerErrorBoundary>
      <LayerErrorBoundary name="Browser cards">
        <CanvasCardLayer />
      </LayerErrorBoundary>
      <LayerErrorBoundary name="Connections">
        <ConnectionLayer />
      </LayerErrorBoundary>
      {drawingEnabled && (
        <LayerErrorBoundary name="Drawings">
          <DrawingLayer />
        </LayerErrorBoundary>
      )}
      {petEnabled && (
        <LayerErrorBoundary name="Pet">
          <PetOverlay />
        </LayerErrorBoundary>
      )}

      <LayerErrorBoundary name="Worktree labels">
        <WorktreeLabelLayer />
      </LayerErrorBoundary>

      <LayerErrorBoundary name="Waypoints">
        <SpatialWaypointsLayer />
      </LayerErrorBoundary>

      <LayerErrorBoundary name="Agent tree">
        <FamilyTreeOverlay />
      </LayerErrorBoundary>

      <CanvasDragoverCue
        active={dragOverState.isDragOver}
        showChip={
          dragOverState.isDragOver &&
          dragOverState.isFolderDrop &&
          projects.length > 0
        }
      />

      {projects.length === 0 && (
        <CanvasEmptyState isDragOver={dragOverState.isDragOver} />
      )}
    </div>
  );
}

export function XyFlowCanvas() {
  return (
    <ReactFlowProvider>
      <XyFlowCanvasInner />
      <FocusCaretOverlay />
    </ReactFlowProvider>
  );
}
