import { useEffect } from "react";
import { CanvasRoot } from "./canvas/CanvasRoot";
import { addProjectFromDirectoryPath } from "./canvas/sceneCommands";
import { Toolbar } from "./toolbar/Toolbar";
import { BottomToolbar } from "./toolbar/BottomToolbar";
import { AddNodeDock } from "./toolbar/AddNodeDock";
import { WorkspaceManagerPill } from "./toolbar/WorkspaceManagerPill";
import { NotificationToast } from "./components/NotificationToast";
import { useNotificationStore } from "./stores/notificationStore";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { FileEditorDrawer } from "./components/FileEditorDrawer";
import { PinDetailDrawer } from "./components/PinDetailDrawer";
import { initUpdaterListeners } from "./stores/updaterStore";
import { ComposerBar } from "./components/ComposerBar";
import { HandoffDragChip } from "./components/HandoffDragChip";
import { usePreferencesStore, hydrateApiKey } from "./stores/preferencesStore";
import { DrawingPanel } from "./toolbar/DrawingPanel";
import { ShortcutHints } from "./components/ShortcutHints";
import { DiscoveryCue } from "./components/DiscoveryCue";
import { StatusDigest } from "./components/StatusDigest";
import { CompletionGlow } from "./components/CompletionGlow";
import { initSessionStoreIPC } from "./stores/sessionStore";
import {
  initBridgeActivityIPC,
  initCanvasBridgeEventIPC,
} from "./stores/bridgeActivityStore";
import { SearchModal } from "./components/SearchModal";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { UsageOverlay } from "./components/UsageOverlay";
import { SessionsOverlay } from "./components/SessionsOverlay";
import {
  closeTerminalInScene,
  createTerminalInScene,
  updateTerminalCustomTitleInScene,
} from "./actions/terminalSceneActions";
import { useProjectStore, generateId } from "./stores/projectStore";
import { useBrowserCardStore } from "./stores/browserCardStore";
import {
  addBrowserCardToScene,
  addPopupBrowserCardToScene,
  updateBrowserCardInScene,
  removeBrowserCardFromScene,
} from "./actions/sceneCardActions";
import { findBrowserCardByWebContentsId } from "./canvas/browserWebviewRegistry";
import {
  openBrowserNodeFind,
  resetBrowserNodeZoom,
  stepBrowserNodeZoom,
} from "./browser/browserNodeCommands";
import {
  downloadDoneNotice,
  downloadStartedNotice,
} from "./browser/downloadNotice";
import { useConnectionStore, connectionsInvolving } from "./stores/connectionStore";
import { findTerminal, getLivePtyId } from "./actions/terminalLookup";
import { BrowserController, resolveBrowserNodeBinding } from "./browser/browserController";
import {
  checkAgentActionOnCard,
  decideSpawnProfile,
  listAgentBrowserProfiles,
} from "./browser/agentBrowserProfiles";
import { installReplyDelivery } from "./browser/chatReplyDelivery";
import { legacyWebviewBrowserAdapter } from "./browser/legacyWebviewBrowserAdapter";
import { connectedTabBrowserAdapter } from "./browser/connectedTabBrowserAdapter";
import { usePinStore } from "./stores/pinStore";
import {
  useCanvasRegistryStore,
  getActiveCanvas,
  getWorkspaceManagerTerminalId,
} from "./stores/canvasRegistryStore";
import { createNoteInScene, updatePinInScene } from "./actions/scenePinActions";
import {
  createConnectionInScene,
  wireSpawnedBrowser,
} from "./actions/sceneConnectionActions";
import type { ConnectionEndpoint } from "./stores/connectionStore";
import type { TerminalType } from "./types";
import { addScannedProjectAndFocus } from "./projects/projectCreation";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePinPreloader } from "./hooks/usePinPreloader";
import { useT } from "./i18n/useT";
import { loadAllDownloadedFonts } from "./terminal/fontLoader";
import { startAutoSummaryWatcher } from "./terminal/summaryScheduler";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { startAutoSaveScheduler } from "./stores/autoSaveScheduler";
import {
  readWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  snapshotState,
  snapshotStateWithRefresh,
  type SkipRestoreSnapshot,
} from "./snapshotState";
import { appendSnapshotToHistory } from "./snapshotHistory";
import { recordDecision, setCaptureCanvas } from "./capture";
import { recordTopologyCheckpoint } from "./captureTopology";
import { SnapshotHistoryModal } from "./components/SnapshotHistoryModal";
import { useSnapshotHistoryStore } from "./stores/snapshotHistoryStore";
import { Hub } from "./components/Hub";
import { CanvasManagerModal } from "./components/CanvasManagerModal";
import { IdentityManagerModal } from "./components/IdentityManagerModal";
import { AgentProfilePromptModal } from "./components/AgentProfilePromptModal";
import { updateWindowTitle } from "./titleHelper";
import { resolveTerminalWithRuntimeState } from "./stores/terminalRuntimeStateStore";
import { logSlowRendererPath } from "./utils/devPerf";
import { selectAllTerminalRuntime } from "./terminal/terminalRuntimeStore";
import { performContextualSelectAll } from "./utils/contextualSelectAll";

// The canvas opacity/blur preference (Settings > Appearance) needs the real
// window to show through, which means every opaque layer stacked above it
// has to get out of the way — not just CanvasRoot's own background. This
// root div is one of those layers: Toolbar/LeftPanel/RightPanel/CanvasRoot
// already tile the full viewport with their own opaque backgrounds, so
// dropping this one is safe on mac and never visible on other platforms.
const IS_MAC = (window.termcanvas?.app.platform ?? "darwin") === "darwin";
const browserController = new BrowserController();
browserController.register(legacyWebviewBrowserAdapter);
browserController.register(connectedTabBrowserAdapter);

function isSkipRestoreSnapshot(
  snapshot: ReturnType<typeof readWorkspaceSnapshot>,
): snapshot is SkipRestoreSnapshot {
  return !!snapshot && "skipRestore" in snapshot;
}

function selectFocusedTerminalBuffer(): boolean {
  const { projects } = useProjectStore.getState();
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (terminal.focused) {
          return selectAllTerminalRuntime(terminal.id);
        }
      }
    }
  }

  return false;
}

function useWorktreeWatcher() {
  const projectCount = useProjectStore((s) => s.projects.length);

  useEffect(() => {
    if (!window.termcanvas || projectCount === 0) return;

    const inFlight = new Set<string>();
    const pending = new Set<string>();
    const latestSeqByPath = new Map<string, number>();
    let disposed = false;

    const scheduleRescan = (projectPath: string) => {
      if (inFlight.has(projectPath)) {
        pending.add(projectPath);
        return;
      }

      inFlight.add(projectPath);
      const seq = (latestSeqByPath.get(projectPath) ?? 0) + 1;
      latestSeqByPath.set(projectPath, seq);

      void window.termcanvas.project
        .rescanWorktrees(projectPath)
        .then((worktrees) => {
          if (disposed) return;
          if (latestSeqByPath.get(projectPath) !== seq) return;
          useProjectStore.getState().syncWorktrees(projectPath, worktrees);
        })
        .catch((err) => {
          if (!disposed) {
            console.error(
              `[useWorktreeWatcher] failed to rescan ${projectPath}:`,
              err,
            );
          }
        })
        .finally(() => {
          inFlight.delete(projectPath);
          if (!disposed && pending.delete(projectPath)) {
            scheduleRescan(projectPath);
          }
        });
    };

    const rescanAll = () => {
      const { projects } = useProjectStore.getState();
      for (const p of projects) {
        scheduleRescan(p.path);
      }
    };

    rescanAll();
    // Poll every 5s — simple, reliable, cross-platform
    const interval = setInterval(rescanAll, 5000);
    window.addEventListener("focus", rescanAll);

    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", rescanAll);
    };
  }, [projectCount]);
}

function useStatePersistence() {
  useEffect(() => {
    if (!window.termcanvas) return;
    window.termcanvas.state
      .load()
      .then((saved) => {
        const restored = readWorkspaceSnapshot(saved);
        if (!restored) return;
        if (isSkipRestoreSnapshot(restored)) {
          window.termcanvas.state.save({ skipRestore: false });
          return;
        }
        restoreWorkspaceSnapshot(restored);
        useWorkspaceStore.getState().setWorkspacePath(null);
        useWorkspaceStore.getState().markClean();
      })
      .catch((err) => {
        console.error("[useStatePersistence] failed to load state:", err);
      });
  }, []);
}

function useAutoSave() {
  useEffect(() => {
    if (!window.termcanvas) return;

    const saveSnapshot = async () => {
      const startedAt = performance.now();
      try {
        await window.termcanvas.state.save(snapshotState());
        useWorkspaceStore.setState((state) => ({
          ...state,
          lastSavedAt: Date.now(),
        }));
        // Throttled history capture rides on the autosave heartbeat — see
        // MIN_HISTORY_INTERVAL_MS in snapshotHistory.ts. Awaiting the autosave
        // first guarantees state.json and the history slot agree.
        void appendSnapshotToHistory();
        // Same heartbeat, its own (longer) throttle — see captureTopology.ts.
        recordTopologyCheckpoint();
      } catch (err) {
        console.error("[useAutoSave] failed to save recovery snapshot:", err);
      } finally {
        logSlowRendererPath("App.autoSaveSnapshot", startedAt, {
          thresholdMs: 20,
        });
      }
    };

    const scheduler = startAutoSaveScheduler({
      source: useWorkspaceStore,
      save: () => {
        void saveSnapshot();
      },
    });

    // Closes the gap where a quit shortly after a change loses that change
    // even on a clean quit — see requestFinalFlushAndWait in
    // electron/main.ts's "will-quit" handler, which pushes this event and
    // waits (with a timeout) for the ack below before destroying any PTYs.
    const unsubscribeFlush = window.termcanvas.state.onFlushBeforeQuit(() => {
      scheduler.cancelPendingSave();
      // Uses the refreshing variant (not plain saveSnapshot/snapshotState)
      // per its own doc comment: close-time saves should re-read live
      // Claude session state from disk first, so a /resume switch or
      // permission-mode change from moments ago is actually captured, not
      // just whatever was already cached at the last debounced autosave.
      snapshotStateWithRefresh()
        .then((snap) => window.termcanvas.state.save(snap))
        .then(() => {
          useWorkspaceStore.setState((state) => ({
            ...state,
            lastSavedAt: Date.now(),
          }));
        })
        .catch((err) => {
          console.error("[useAutoSave] failed to flush before quit:", err);
        })
        .finally(() => window.termcanvas.state.notifyFlushComplete());
    });

    return () => {
      scheduler.stop();
      unsubscribeFlush();
    };
  }, []);
}

function useWorkspaceOpen() {
  useEffect(() => {
    const handler = (e: Event) => {
      const { dirty } = useWorkspaceStore.getState();
      if (dirty && !window.confirm("Unsaved changes will be lost. Continue?")) {
        return;
      }

      const raw = (e as CustomEvent<string>).detail;
      try {
        const restored = readWorkspaceSnapshot(raw);
        if (!restored || isSkipRestoreSnapshot(restored)) {
          return;
        }
        restoreWorkspaceSnapshot(restored);
        useWorkspaceStore.getState().setWorkspacePath(null);
        useWorkspaceStore.getState().markClean();
      } catch (err) {
        console.error(
          "[useWorkspaceOpen] failed to parse workspace file:",
          err,
        );
      }
    };
    window.addEventListener("termcanvas:open-workspace", handler);
    return () =>
      window.removeEventListener("termcanvas:open-workspace", handler);
  }, []);
}


export function App() {
  useWorktreeWatcher();
  usePinPreloader();
  useStatePersistence();
  useAutoSave();
  useWorkspaceOpen();
  useKeyboardShortcuts();
  const t = useT();
  const composerEnabled = usePreferencesStore((s) => s.composerEnabled);
  const globalSearchEnabled = usePreferencesStore((s) => s.globalSearchEnabled);
  const drawingEnabled = usePreferencesStore((s) => s.drawingEnabled);
  const summaryEnabled = usePreferencesStore((s) => s.summaryEnabled);
  const completionGlowEnabled = usePreferencesStore(
    (s) => s.completionGlowEnabled,
  );

  useEffect(() => {
    if (!summaryEnabled) return;
    return startAutoSummaryWatcher();
  }, [summaryEnabled]);

  useEffect(() => initUpdaterListeners(), []);
  // Keeps main's view of the active canvas current, so prompt entries — which
  // arrive from the hook socket in main, not here — get attributed to the right
  // canvas. Subscribing rather than reading once: switching canvases has to
  // move subsequent entries with it.
  useEffect(() => {
    setCaptureCanvas(useCanvasRegistryStore.getState().activeCanvasId);
    return useCanvasRegistryStore.subscribe((state, prev) => {
      if (state.activeCanvasId !== prev.activeCanvasId) {
        setCaptureCanvas(state.activeCanvasId);
      }
    });
  }, []);
  useEffect(() => {
    void useSnapshotHistoryStore.getState().refresh();
  }, []);
  useEffect(() => {
    void hydrateApiKey();
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.sessions) return;
    return initSessionStoreIPC();
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.browser?.onBridgeCall) return;
    return initBridgeActivityIPC();
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.browser?.onCanvasBridgeEvent) return;
    return initCanvasBridgeEventIPC();
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.browser?.onExternalAuthRedirect) return;
    return window.termcanvas.browser.onExternalAuthRedirect(({ url }) => {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        // keep raw url as fallback
      }
      useNotificationStore
        .getState()
        .notify(
          "info",
          `Opened ${host} in your browser to sign in — the embedded browser can't complete Google/Microsoft-style sign-in.`,
        );
    });
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.browser?.onPopupRequested) return;
    return window.termcanvas.browser.onPopupRequested(
      ({ url, profileId, sourceWebContentsId }) => {
        const sourceCardId =
          findBrowserCardByWebContentsId(sourceWebContentsId) ?? null;
        const source = sourceCardId
          ? useBrowserCardStore.getState().cards[sourceCardId]
          : undefined;
        // Offset from the opener so the new tile is visibly related to it and
        // does not land exactly on top, the way a stacked window would.
        const position = source
          ? { x: source.x + 48, y: source.y + 48 }
          : undefined;
        addPopupBrowserCardToScene({ url, identityId: profileId, sourceCardId, position });
      },
    );
  }, []);
  // The half of ⌘F / ⌘± that the renderer can never see for itself: once the
  // user clicks into a page, its keys go to the guest and stop there. Main
  // recognises the four chords and sends the name back; matching it to a tile
  // is the same webContents-id lookup the popup path uses.
  useEffect(() => {
    if (!window.termcanvas?.browser?.onGuestShortcut) return;
    return window.termcanvas.browser.onGuestShortcut(
      ({ shortcut, sourceWebContentsId }) => {
        const cardId = findBrowserCardByWebContentsId(sourceWebContentsId);
        if (!cardId) return;
        if (shortcut === "find") openBrowserNodeFind(cardId);
        else if (shortcut === "zoom-in") stepBrowserNodeZoom(cardId, "in");
        else if (shortcut === "zoom-out") stepBrowserNodeZoom(cardId, "out");
        else resetBrowserNodeZoom(cardId);
      },
    );
  }, []);
  // A `sends-replies-to` wire fires here: the agent finishes, its answer is
  // typed into the chat page at the other end and submitted, and that is the
  // whole interaction — nothing reads the response back.
  useEffect(() => installReplyDelivery(), []);
  useEffect(() => {
    if (!window.termcanvas?.browser?.onDownloadEvent) return;
    return window.termcanvas.browser.onDownloadEvent((event) => {
      const notice =
        event.phase === "started"
          ? downloadStartedNotice(event.filename)
          : downloadDoneNotice(event.outcome ?? "interrupted", event.filename);
      if (notice) {
        // "Show in Finder" goes back through main by token — the renderer is
        // never given the path, so it cannot end up in state or a snapshot.
        const token = event.revealToken;
        const action = token
          ? {
              label: "Show in Finder",
              run: () => { void window.termcanvas?.browser?.revealDownload?.(token); },
            }
          : undefined;
        useNotificationStore.getState().notify(notice.type, notice.message, action);
      }
      if (event.phase !== "done" || event.outcome !== "completed") return;
      // A file the user now has is a choice point, not activity: it is the
      // one thing from a browsing session that outlives the session. Recorded
      // only when it can be attributed to a node — an entry with no node to
      // hang off joins to nothing.
      const cardId =
        event.sourceWebContentsId === null
          ? undefined
          : findBrowserCardByWebContentsId(event.sourceWebContentsId);
      if (!cardId) return;
      const card = useBrowserCardStore.getState().cards[cardId];
      recordDecision({
        kind: "browser_action",
        node: `browser:${cardId}`,
        action: "download",
        backend: "managed",
        by: "user",
        ok: true,
        url: event.url,
        ...(card ? { profile: card.identityId } : {}),
      });
    });
  }, []);
  useEffect(() => {
    if (!window.termcanvas?.menu) return;
    const removeOpenFolderListener = window.termcanvas.menu.onOpenFolder(
      async (dirPath: string) => {
        await addProjectFromDirectoryPath(dirPath, t);
      },
    );
    const removeSelectAllListener = window.termcanvas.menu.onSelectAll(() => {
      performContextualSelectAll(
        document.activeElement,
        selectFocusedTerminalBuffer,
      );
    });

    return () => {
      removeOpenFolderListener();
      removeSelectAllListener();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    loadAllDownloadedFonts();
  }, []);

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe(() => updateWindowTitle());
    updateWindowTitle();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const api = {
      getProjects: () => {
        const { projects } = useProjectStore.getState();
        return JSON.parse(
          JSON.stringify(
            projects.map((p: any) => ({
              id: p.id,
              name: p.name,
              path: p.path,
              collapsed: p.collapsed,
              worktrees: p.worktrees.map((w: any) => ({
                id: w.id,
                name: w.name,
                path: w.path,
                terminals: w.terminals.map((t: any) => {
                  const liveTerminal = resolveTerminalWithRuntimeState(t);
                  return {
                    id: liveTerminal.id,
                    title: liveTerminal.title,
                    customTitle: liveTerminal.customTitle,
                    starred: liveTerminal.starred,
                    type: liveTerminal.type,
                    status: liveTerminal.status,
                    ptyId: liveTerminal.ptyId,
                    width: liveTerminal.width,
                    height: liveTerminal.height,
                    parentTerminalId: liveTerminal.parentTerminalId,
                  };
                }),
              })),
            })),
          ),
        );
      },

      addProject: (projectData: any) => {
        useProjectStore.getState().addProject(projectData);
        return true;
      },

      removeProject: (projectId: string) => {
        useProjectStore.getState().removeProject(projectId);
        return true;
      },

      addTerminal: (
        projectId: string,
        worktreeId: string,
        type: string,
        prompt?: string,
        autoApprove?: boolean,
        parentTerminalId?: string | null,
      ) => {
        const terminal = createTerminalInScene({
          projectId,
          worktreeId,
          type: type as any,
          initialPrompt: prompt,
          autoApprove,
          origin: "agent",
          parentTerminalId: parentTerminalId ?? undefined,
        });
        return JSON.parse(JSON.stringify(terminal));
      },

      removeTerminal: (
        projectId: string,
        worktreeId: string,
        terminalId: string,
      ) => {
        closeTerminalInScene(projectId, worktreeId, terminalId);
        return true;
      },

      syncWorktrees: (projectPath: string, worktrees: any[]) => {
        useProjectStore.getState().syncWorktrees(projectPath, worktrees);
        return true;
      },

      getTerminal: (terminalId: string) => {
        const { projects } = useProjectStore.getState();
        for (const p of projects) {
          for (const w of p.worktrees) {
            const t = w.terminals.find((t: any) => t.id === terminalId);
            if (t) {
              const liveTerminal = resolveTerminalWithRuntimeState(t);
              return JSON.parse(
                JSON.stringify({
                  id: liveTerminal.id,
                  title: liveTerminal.title,
                  customTitle: liveTerminal.customTitle,
                  starred: liveTerminal.starred,
                  type: liveTerminal.type,
                  status: liveTerminal.status,
                  ptyId: liveTerminal.ptyId,
                  width: liveTerminal.width,
                  height: liveTerminal.height,
                  parentTerminalId: liveTerminal.parentTerminalId,
                  projectId: p.id,
                  worktreeId: w.id,
                  worktreePath: w.path,
                }),
              );
            }
          }
        }
        return null;
      },

      setCustomTitle: (terminalId: string, customTitle: string) => {
        const { projects } = useProjectStore.getState();
        for (const p of projects) {
          for (const w of p.worktrees) {
            const t = w.terminals.find((t) => t.id === terminalId);
            if (t) {
              updateTerminalCustomTitleInScene(
                p.id,
                w.id,
                terminalId,
                customTitle,
              );
              return true;
            }
          }
        }
        throw new Error("Terminal not found");
      },

      listBrowserCards: () => {
        return JSON.parse(
          JSON.stringify(Object.values(useBrowserCardStore.getState().cards)),
        );
      },

      addBrowserCard: (url: string, x?: number, y?: number) => {
        const position =
          typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
        return addBrowserCardToScene(position, url);
      },

      updateBrowserCard: (id: string, patch: Record<string, unknown>) => {
        if (!useBrowserCardStore.getState().cards[id]) {
          throw new Error(`Browser card not found: ${id}`);
        }
        updateBrowserCardInScene(id, patch);
        return true;
      },

      removeBrowserCard: (id: string) => {
        if (!useBrowserCardStore.getState().cards[id]) {
          throw new Error(`Browser card not found: ${id}`);
        }
        removeBrowserCardFromScene(id);
        return true;
      },

      // Backs the termcanvas-bridge MCP server's gating check
      // (termcanvas-bridge/src/mcp-server.ts): a terminal's browser tools stay inert until this
      // resolves to a real id. "Most recently connected wins" if a terminal
      // somehow ends up wired to more than one browser tile.
      getBrowserBindingForTerminal: (terminalId: string) => {
        const connections = connectionsInvolving(
          useConnectionStore.getState().connections,
          "terminal",
          terminalId,
        );
        let mostRecent: { id: string; createdAt: number } | null = null;
        for (const connection of connections) {
          const other =
            connection.from.kind === "browser" ? connection.from : connection.to;
          if (other.kind !== "browser") continue;
          if (!mostRecent || connection.createdAt > mostRecent.createdAt) {
            mostRecent = { id: other.id, createdAt: connection.createdAt };
          }
        }
        return { browserId: mostRecent?.id ?? null };
      },

      // Backs the remember MCP tool (termcanvas-bridge/src/mcp-server.ts via
      // electron/api-server.ts's /terminal/:id/remember route). Returns the
      // exact same worktree.path string src/components/RightPanel/
      // MemoryContent.tsx already uses to call window.termcanvas.memory.*
      // — not a re-derived path — so a note written for this terminal lands
      // in the same memory directory the Memory tab is already watching.
      getWorktreePathForTerminal: (terminalId: string) => {
        const found = findTerminal(terminalId);
        return { worktreePath: found?.worktree.path ?? null };
      },

      // Backs the emit_event MCP tool (termcanvas-bridge/src/mcp-server.ts via
      // electron/api-server.ts's /node/:kind/:id/emit route). Unlike
      // getBrowserBindingForTerminal above (which deliberately picks only
      // the most-recently-connected browser for the narrower drive tools),
      // this fans out to *every* connected endpoint — the actual
      // graph-not-point-to-point behavior emit_event is for.
      getConnectionsForNode: (kind: ConnectionEndpoint["kind"], id: string) => {
        const connections = connectionsInvolving(
          useConnectionStore.getState().connections,
          kind,
          id,
        );
        return connections.map((connection) => {
          const other =
            connection.from.kind === kind && connection.from.id === id
              ? connection.to
              : connection.from;
          if (other.kind === "terminal") {
            const found = findTerminal(other.id);
            return {
              kind: "terminal" as const,
              id: other.id,
              ptyId: getLivePtyId(other.id),
              terminalType: found?.terminal.type ?? null,
              worktreePath: found?.worktree.path ?? null,
            };
          }
          if (other.kind === "note") {
            // Reported so callers can see the note is connected, but it has
            // no reaction — nodeEmit (electron/api-server.ts) skips notes
            // rather than treating them as a drivable endpoint.
            return { kind: "note" as const, id: other.id };
          }
          return { kind: "browser" as const, id: other.id };
        });
      },

      // Backs the workspace-manager query tools (list_nodes/get_node_state/
      // get_workspace_summary in termcanvas-bridge/src/mcp-server.ts via
      // electron/api-server.ts). Flat across all three node kinds — no
      // project/worktree nesting — since the PM reasons about the canvas as
      // one flat space, same as focusableNodes.ts's collector does for
      // focus view. Pins without x/y (list/drawer-only, never placed on the
      // canvas) are excluded, same as focusableNodes.ts excludes them.
      listWorkspaceNodes: () => {
        const nodes: Array<{
          kind: "terminal" | "browser" | "pin";
          id: string;
          x: number;
          y: number;
          w: number;
          h: number;
          type: string | null;
          status: string | null;
          title: string | null;
        }> = [];

        const { projects } = useProjectStore.getState();
        for (const project of projects) {
          for (const worktree of project.worktrees) {
            for (const terminal of worktree.terminals) {
              if (terminal.stashed) continue;
              const live = resolveTerminalWithRuntimeState(terminal);
              nodes.push({
                kind: "terminal",
                id: live.id,
                x: live.x,
                y: live.y,
                w: live.width,
                h: live.height,
                type: live.type,
                status: live.status,
                title: live.customTitle || live.title || null,
              });
            }
          }
        }

        const { cards } = useBrowserCardStore.getState();
        for (const card of Object.values(cards)) {
          nodes.push({
            kind: "browser",
            id: card.id,
            x: card.x,
            y: card.y,
            w: card.w,
            h: card.h,
            type: null,
            status: null,
            title: card.title || card.url || null,
          });
        }

        const { pinsByProject } = usePinStore.getState();
        for (const pin of Object.values(pinsByProject).flat()) {
          if (pin.x == null || pin.y == null) continue;
          nodes.push({
            kind: "pin",
            id: pin.id,
            x: pin.x,
            y: pin.y,
            w: pin.w ?? 280,
            h: pin.h ?? 220,
            type: null,
            status: pin.status,
            title: pin.title || null,
          });
        }

        return JSON.parse(JSON.stringify(nodes));
      },

      getNodeState: (kind: "terminal" | "browser" | "pin", id: string) => {
        if (kind === "terminal") {
          const found = findTerminal(id);
          if (!found) return null;
          const live = resolveTerminalWithRuntimeState(found.terminal);
          return JSON.parse(
            JSON.stringify({
              kind: "terminal",
              id: live.id,
              type: live.type,
              status: live.status,
              title: live.customTitle || live.title || null,
              x: live.x,
              y: live.y,
              w: live.width,
              h: live.height,
              worktreePath: found.worktree.path,
            }),
          );
        }
        if (kind === "browser") {
          const card = useBrowserCardStore.getState().cards[id];
          if (!card) return null;
          return JSON.parse(JSON.stringify(card));
        }
        if (kind === "pin") {
          const { pinsByProject } = usePinStore.getState();
          const pin = Object.values(pinsByProject)
            .flat()
            .find((p) => p.id === id);
          if (!pin) return null;
          return JSON.parse(JSON.stringify(pin));
        }
        return null;
      },

      getWorkspaceLiveSummary: () => {
        const { projects } = useProjectStore.getState();
        let terminalCount = 0;
        const statusCounts: Record<string, number> = {};
        for (const project of projects) {
          for (const worktree of project.worktrees) {
            for (const terminal of worktree.terminals) {
              if (terminal.stashed) continue;
              terminalCount++;
              const live = resolveTerminalWithRuntimeState(terminal);
              statusCounts[live.status] = (statusCounts[live.status] ?? 0) + 1;
            }
          }
        }
        const browserCount = Object.keys(
          useBrowserCardStore.getState().cards,
        ).length;
        const pinCount = Object.values(usePinStore.getState().pinsByProject)
          .flat()
          .filter((p) => p.x != null && p.y != null).length;
        const connectionCount = useConnectionStore.getState().connections.length;
        return {
          terminalCount,
          browserCount,
          pinCount,
          connectionCount,
          statusCounts,
        };
      },

      // Live gating check for PM-only routes — compares against the
      // *active* canvas's assignment (see docs/workspace_project_manager.md:
      // Phase 1 scopes "workspace" to the active canvas, not true
      // simultaneous multi-canvas). Checked fresh per call, not cached.
      isWorkspaceManager: (terminalId: string) => {
        return getWorkspaceManagerTerminalId() === terminalId;
      },

      getActiveCanvasId: () => getActiveCanvas().id,

      setWorkspaceManager: (terminalId: string | null) => {
        const canvasId = getActiveCanvas().id;
        // Recording lives inside the store action — see the note there. Doing
        // it here as well would double-log every assignment made this way.
        useCanvasRegistryStore.getState().setWorkspaceManager(canvasId, terminalId);
        return { canvasId, terminalId };
      },

      // Backs the spawn_terminal MCP tool. requesterTerminalId (always the
      // PM itself, per the gating check in electron/api-server.ts) becomes
      // parentTerminalId, which drives auto-placement (pickPlacement in
      // terminalPlacement.ts anchors next to a parent) and, via
      // createTerminalInScene, the spawn-origin connection back to the PM.
      // connectTo is an additional, optional wire to some *other* node —
      // omit it for a plain spawn; the parent link is automatic.
      spawnTerminal: (opts: {
        requesterTerminalId: string;
        type?: string;
        prompt?: string;
        position?: { x: number; y: number };
        connectTo?: ConnectionEndpoint;
      }) => {
        const found = findTerminal(opts.requesterTerminalId);
        if (!found) return { ok: false, reason: "requester terminal not found" };
        const terminal = createTerminalInScene({
          projectId: found.project.id,
          worktreeId: found.worktree.id,
          type: (opts.type as TerminalType | undefined) ?? "shell",
          initialPrompt: opts.prompt,
          origin: "agent",
          parentTerminalId: opts.requesterTerminalId,
          position: opts.position,
        });
        // No recordDecision here: createTerminalInScene already recorded the
        // spawn, so doing it again would double-count every delegation.
        if (opts.connectTo) {
          createConnectionInScene(
            { kind: "terminal", id: terminal.id },
            opts.connectTo,
            { by: `terminal:${opts.requesterTerminalId}` },
          );
        }
        return { ok: true, id: terminal.id, x: terminal.x, y: terminal.y };
      },

      // Backs the list_browser_profiles MCP tool. Withheld profiles are
      // absent, not marked — a name an agent can read is a name it can use.
      listAgentBrowserProfiles: () => ({
        profiles: listAgentBrowserProfiles(),
      }),

      // Backs the spawn_browser MCP tool.
      spawnBrowser: async (opts: {
        requesterTerminalId: string;
        url: string;
        position?: { x: number; y: number };
        connectTo?: ConnectionEndpoint;
        profile?: string;
      }) => {
        // Which identity an agent works as is a permission decision, so it is
        // resolved before anything is created and the answer is reported back.
        // This used to inherit whatever profile the *user* was last working
        // as, silently — which is how an agent opened a signed-out page and
        // said nothing about it.
        // Awaited: when the canvas has no default yet this opens the prompt
        // and waits for the answer, rather than refusing and leaving the agent
        // to ask the same question again in its own terminal.
        const decision = await decideSpawnProfile({
          requesterTerminalId: opts.requesterTerminalId,
          profile: opts.profile,
        });
        if (!decision.ok) {
          // No node is created. A browser on the wrong identity is worse than
          // no browser: the agent can re-call once it knows which to use.
          return {
            ok: false,
            code: decision.code,
            reason: decision.message,
            ...(decision.choices ? { choices: decision.choices } : {}),
          };
        }
        // addBrowserCardToScene records the spawn itself — passing the
        // requester is what makes it read as the agent's rather than yours.
        const id = addBrowserCardToScene(
          opts.position,
          opts.url,
          `terminal:${opts.requesterTerminalId}`,
          decision.profileId,
        );
        if (opts.connectTo) {
          createConnectionInScene({ kind: "browser", id }, opts.connectTo, {
            origin: "spawn",
            by: `terminal:${opts.requesterTerminalId}`,
          });
        } else {
          // No explicit target means "for me" — wire it straight to the
          // agent that asked, so the browser_* drive tools work immediately
          // instead of returning "Not wired to a browser yet" until a
          // separate connect_nodes call lands. Replaces that agent's
          // previous browser wire; see wireSpawnedBrowser.
          wireSpawnedBrowser(opts.requesterTerminalId, id);
        }
        return {
          ok: true,
          id,
          profile: {
            id: decision.profileId,
            name: decision.profileName,
            reason: decision.reason,
            isGuest: decision.isGuest,
            ...(decision.overrodeCanvasDefault
              ? { overrodeCanvasDefault: decision.overrodeCanvasDefault }
              : {}),
          },
          note: decision.summary,
        };
      },

      spawnNote: async (opts: {
        requesterTerminalId: string;
        body: string;
        position?: { x: number; y: number };
      }) => {
        const found = findTerminal(opts.requesterTerminalId);
        if (!found) return { ok: false, reason: "requester terminal not found" };
        const pin = await createNoteInScene(found.project.path, opts.position);
        updatePinInScene(found.project.path, pin.id, { body: opts.body });
        recordDecision({
          kind: "spawn",
          node: `note:${pin.id}`,
          by: `terminal:${opts.requesterTerminalId}`,
          parent: `terminal:${opts.requesterTerminalId}`,
        });
        // Notes are connectable purely so their provenance is visible — a
        // note wire grants nothing, and nodeEmit (electron/api-server.ts)
        // deliberately applies no reaction to a note target.
        createConnectionInScene(
          { kind: "terminal", id: opts.requesterTerminalId },
          { kind: "note", id: pin.id },
          { origin: "spawn", by: `terminal:${opts.requesterTerminalId}` },
        );
        return { ok: true, id: pin.id };
      },

      // Backs the connect_nodes MCP tool. A manual wire is a real capability
      // grant, not just a drawn line: it is what browser-bridge resolves
      // terminal→browser control from, and what emit_event fans out along.
      connectNodes: (
        source: ConnectionEndpoint,
        target: ConnectionEndpoint,
        requesterTerminalId?: string,
      ) => {
        const id = createConnectionInScene(source, target, {
          by: requesterTerminalId ? `terminal:${requesterTerminalId}` : "user",
        });
        return { ok: id !== null, id };
      },

      // Provider-neutral browser control. Existing cards resolve to the
      // managed legacy-webview adapter; connected tabs use another adapter.
      driveBrowserCard: async (
        id: string,
        action: string,
        params: Record<string, unknown> = {},
        actor: string = "system",
      ) => {
        const card = useBrowserCardStore.getState().cards[id];
        if (!card) throw new Error(`Browser card not found: ${id}`);
        // Re-checked here, on every single action, rather than once when the
        // node was spawned: revoking a profile has to stop a task that is
        // already running, and a permission decided minutes ago is worth
        // nothing by then. The node is never closed — the user tightened a
        // permission, they did not ask to lose the page.
        const permission = checkAgentActionOnCard(id);
        if (!permission.allowed) {
          recordDecision({
            kind: "browser_action",
            node: `browser:${id}`,
            action,
            backend: resolveBrowserNodeBinding(card).kind,
            by: actor,
            ok: false,
            error: `${permission.code}: ${permission.message}`,
          });
          throw new Error(`${permission.code}: ${permission.message}`);
        }
        const result = await browserController.execute(card, action, params);
        recordDecision({
          kind: "browser_action",
          node: `browser:${id}`,
          action,
          backend: result.backend,
          by: actor,
          ok: result.ok,
          ...(typeof params.url === "string" ? { url: params.url } : {}),
          ...(!result.ok ? { error: result.error.message } : {}),
        });
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }
        // Preserve the existing HTTP/MCP response shape during migration.
        return result.data;
      },
    };

    (window as any).__tcApi = api;
    return () => {
      delete (window as any).__tcApi;
    };
  }, []);

  return (
    <div
      className={`h-screen w-screen overflow-hidden text-[var(--text-primary)] ${
        IS_MAC ? "" : "bg-[var(--bg)]"
      }`}
    >
      <Toolbar />
      <LeftPanel />
      <RightPanel />
      <CanvasRoot />
      <BottomToolbar />
      <AddNodeDock />
      <WorkspaceManagerPill />
      {drawingEnabled && <DrawingPanel />}
      {completionGlowEnabled && <CompletionGlow />}
      <ShortcutHints />
      <DiscoveryCue />
      <StatusDigest />
      {composerEnabled && <ComposerBar />}
      <HandoffDragChip />
      <NotificationToast />
      {globalSearchEnabled && <SearchModal />}
      <CommandPalette />
      <SnapshotHistoryModal />
      <UsageOverlay />
      <SessionsOverlay />
      <FileEditorDrawer />
      <PinDetailDrawer />
      <Hub />
      <CanvasManagerModal />
      <IdentityManagerModal />
      <AgentProfilePromptModal />
    </div>
  );
}
