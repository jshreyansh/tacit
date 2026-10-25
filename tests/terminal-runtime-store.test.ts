import test from "node:test";
import assert from "node:assert/strict";

function installRuntimeGlobals() {
  const storage = new Map<string, string>();
  const navigator = {
    language: "en-US",
    userAgent: "node-test",
    clipboard: {
      writeText: async () => {},
    },
  };
  const target = new EventTarget();
  const mockWindow = Object.assign(target, {
    navigator,
    tacit: undefined as unknown,
  }) as Window & { tacit: unknown };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      clear() {
        storage.clear();
      },
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: mockWindow,
  });

  return mockWindow;
}

function createTerminal() {
  return {
    id: "terminal-1",
    title: "Terminal",
    type: "shell" as const,
    minimized: false,
    focused: true,
    ptyId: 42,
    status: "running" as const,
    span: { cols: 1, rows: 1 },
  };
}

function seedProjectState(
  useProjectStore: typeof import("../src/stores/projectStore.ts").useProjectStore,
  terminal = createTerminal(),
) {
  useProjectStore.setState({
    focusedProjectId: "project-1",
    focusedWorktreeId: "worktree-1",
    projects: [
      {
        id: "project-1",
        name: "Project One",
        path: "/tmp/project-1",
        position: { x: 0, y: 0 },
        collapsed: false,
        zIndex: 0,
        worktrees: [
          {
            id: "worktree-1",
            name: "main",
            path: "/tmp/project-1",
            position: { x: 0, y: 0 },
            collapsed: false,
            terminals: [terminal],
          },
        ],
      },
    ],
  });
}

function createFakeContainer() {
  const node = {
    children: [] as Array<ReturnType<typeof createFakeContainer>>,
    parentElement: null as ReturnType<typeof createFakeContainer> | null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child: ReturnType<typeof createFakeContainer>) {
      child.parentElement?.removeChild(child);
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    removeChild(child: ReturnType<typeof createFakeContainer>) {
      this.children = this.children.filter((entry) => entry !== child);
      if (child.parentElement === this) {
        child.parentElement = null;
      }
      return child;
    },
  };

  return node;
}

function createMockXterm() {
  const stats = {
    blurCalls: 0,
    disposeCalls: 0,
    fitCalls: 0,
    focusCalls: 0,
    inputBindingDisposeCalls: 0,
    loadAddonCalls: 0,
    refreshCalls: 0,
    resizeBindingDisposeCalls: 0,
    selectAllCalls: 0,
    selectionBindingDisposeCalls: 0,
    selectionPointerCleanupCalls: 0,
    selectionSubscriptions: 0,
  };

  const xterm = {
    cols: 80,
    rows: 24,
    options: {},
    blur() {
      stats.blurCalls += 1;
    },
    dispose() {
      stats.disposeCalls += 1;
    },
    focus() {
      stats.focusCalls += 1;
    },
    getSelection() {
      return "";
    },
    loadAddon() {
      stats.loadAddonCalls += 1;
    },
    onData() {
      return {
        dispose() {
          stats.inputBindingDisposeCalls += 1;
        },
      };
    },
    onResize() {
      return {
        dispose() {
          stats.resizeBindingDisposeCalls += 1;
        },
      };
    },
    onSelectionChange() {
      stats.selectionSubscriptions += 1;
      return {
        dispose() {
          stats.selectionBindingDisposeCalls += 1;
        },
      };
    },
    refresh() {
      stats.refreshCalls += 1;
    },
    selectAll() {
      stats.selectAllCalls += 1;
    },
    scrollToBottom() {},
    write() {},
  };

  const fitAddon = {
    fit() {
      stats.fitCalls += 1;
    },
  };

  return { fitAddon, stats, xterm };
}

test("destroyTerminalRuntime clears live pty ids from runtime overlay state", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    destroyTerminalRuntime,
    ensureTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousState = useProjectStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    mockWindow.tacit = {
      terminal: {
        destroy: async () => {},
      },
    };

    destroyTerminalRuntime("terminal-1");

    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.ptyId,
      null,
    );
  } finally {
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousState);
  }
});

test("projectStore runtime actions update overlay state without mutating the scene tree", async () => {
  installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    resolveTerminalWithRuntimeState,
    useTerminalRuntimeStateStore,
  } = await import("../src/stores/terminalRuntimeStateStore.ts");
  const previousState = useProjectStore.getState();

  try {
    useProjectStore.setState({
      focusedProjectId: "project-1",
      focusedWorktreeId: "worktree-1",
      projects: [
        {
          id: "project-1",
          name: "Project One",
          path: "/tmp/project-1",
          position: { x: 0, y: 0 },
          collapsed: false,
          zIndex: 0,
          worktrees: [
            {
              id: "worktree-1",
              name: "main",
              path: "/tmp/project-1",
              position: { x: 0, y: 0 },
              collapsed: false,
              terminals: [
                {
                  id: "terminal-1",
                  title: "Terminal",
                  type: "shell",
                  minimized: false,
                  focused: true,
                  ptyId: null,
                  status: "idle",
                  span: { cols: 1, rows: 1 },
                },
              ],
            },
          ],
        },
      ],
    });

    const store = useProjectStore.getState();
    store.updateTerminalPtyId("project-1", "worktree-1", "terminal-1", 42);
    store.updateTerminalStatus("project-1", "worktree-1", "terminal-1", "running");
    store.updateTerminalSessionId(
      "project-1",
      "worktree-1",
      "terminal-1",
      "session-live",
    );

    const rawTerminal =
      useProjectStore.getState().projects[0].worktrees[0].terminals[0];
    const liveTerminal = resolveTerminalWithRuntimeState(rawTerminal);

    assert.equal(rawTerminal.ptyId, null);
    assert.equal(rawTerminal.status, "idle");
    assert.equal(rawTerminal.sessionId, undefined);
    assert.equal(liveTerminal.ptyId, 42);
    assert.equal(liveTerminal.status, "running");
    assert.equal(liveTerminal.sessionId, "session-live");
    assert.deepEqual(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"],
      {
        ptyId: 42,
        status: "running",
        sessionId: "session-live",
      },
    );
  } finally {
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousState);
  }
});

test("parked runtimes keep the live xterm, dispose live bindings, reuse the host, and clear parked hosts on destroy", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { registerTerminal } = await import("../src/terminal/terminalRegistry.ts");
  const {
    attachTerminalContainer,
    destroyAllTerminalRuntimes,
    destroyTerminalRuntime,
    detachTerminalContainer,
    ensureTerminalRuntime,
    getTerminalRuntime,
    serializeAllTerminalRuntimeBuffers,
    setTerminalRuntimeMode,
    useTerminalRuntimeStore,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousState = useProjectStore.getState();
  const resizeCalls: Array<{ cols: number; ptyId: number; rows: number }> = [];

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    mockWindow.tacit = {
      terminal: {
        destroy: async () => {},
        input() {},
        resize(ptyId: number, cols: number, rows: number) {
          resizeCalls.push({ cols, ptyId, rows });
        },
      },
    };

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const host = createFakeContainer();
    const liveContainer = createFakeContainer();
    const parkedContainer = createFakeContainer();
    const visibleContainer = createFakeContainer();
    const { fitAddon, stats, xterm } = createMockXterm();
    const serializeAddon = {
      serialize() {
        return "live buffer";
      },
    };

    liveContainer.appendChild(host);
    runtime.attachedContainer = liveContainer as unknown as HTMLDivElement;
    runtime.fitAddon = fitAddon as unknown as typeof runtime.fitAddon;
    runtime.hostElement = host as unknown as HTMLDivElement;
    runtime.inputDisposable = {
      dispose() {
        stats.inputBindingDisposeCalls += 1;
      },
    };
    runtime.previewAnsi = "preview fallback";
    runtime.resizeDisposable = {
      dispose() {
        stats.resizeBindingDisposeCalls += 1;
      },
    };
    runtime.selectionDisposable = {
      dispose() {
        stats.selectionBindingDisposeCalls += 1;
      },
    } as typeof runtime.selectionDisposable;
    runtime.selectionPointerCleanup = () => {
      stats.selectionPointerCleanupCalls += 1;
    };
    runtime.serializeAddon = serializeAddon as typeof runtime.serializeAddon;
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    registerTerminal(
      "terminal-1",
      runtime.xterm as NonNullable<typeof runtime.xterm>,
      serializeAddon as NonNullable<typeof runtime.serializeAddon>,
    );

    setTerminalRuntimeMode("terminal-1", "parked");

    assert.equal(useTerminalRuntimeStore.getState().terminals["terminal-1"]?.mode, "parked");
    assert.equal(runtime.xterm, xterm);
    assert.equal(stats.blurCalls, 1);
    assert.equal(stats.disposeCalls, 0);
    assert.equal(stats.inputBindingDisposeCalls, 1);
    assert.equal(stats.resizeBindingDisposeCalls, 1);
    assert.equal(stats.selectionBindingDisposeCalls, 1);
    assert.equal(stats.selectionPointerCleanupCalls, 1);
    assert.equal(runtime.selectionDisposable, null);
    assert.equal(runtime.selectionPointerCleanup, null);
    assert.equal(host.parentElement, null);
    assert.equal(serializeAllTerminalRuntimeBuffers()["terminal-1"], "live buffer");

    setTerminalRuntimeMode("terminal-1", "live");
    attachTerminalContainer("terminal-1", visibleContainer as unknown as HTMLDivElement);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runtime.xterm, xterm);
    assert.equal(host.parentElement, visibleContainer);
    assert.equal(stats.disposeCalls, 0);
    assert.equal(stats.selectionSubscriptions, 1);
    assert.ok(runtime.selectionDisposable);
    assert.equal(typeof runtime.selectionPointerCleanup, "function");
    assert.equal(stats.fitCalls >= 1, true);
    assert.deepEqual(resizeCalls.at(-1), {
      cols: 80,
      ptyId: 42,
      rows: 24,
    });

    detachTerminalContainer("terminal-1");
    assert.equal(host.parentElement, null);

    parkedContainer.appendChild(host);
    destroyTerminalRuntime("terminal-1");

    assert.equal(stats.disposeCalls, 1);
    assert.equal(host.parentElement, null);
    assert.equal(runtime.hostElement, null);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousState);
  }
});

test("parked runtimes apply font preference updates without fitting against the parking host", async () => {
  const mockWindow = installRuntimeGlobals();
  const { buildFontFamily } = await import("../src/terminal/fontRegistry.ts");
  const { usePreferencesStore } = await import("../src/stores/preferencesStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
    setTerminalRuntimeMode,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const previousPreferencesState = usePreferencesStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);
    mockWindow.tacit = {
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
      session: {
        onTurnComplete() {
          return () => {};
        },
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const { fitAddon, stats, xterm } = createMockXterm();
    runtime.fitAddon = fitAddon as unknown as typeof runtime.fitAddon;
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    setTerminalRuntimeMode("terminal-1", "parked");
    usePreferencesStore.getState().setTerminalFontSize(18);
    usePreferencesStore.getState().setTerminalFontFamily("jetbrains-mono");

    assert.equal(runtime.mode, "parked");
    assert.equal(stats.fitCalls, 0);
    assert.equal(runtime.xterm?.options.fontSize, 18);
    assert.equal(runtime.xterm?.options.fontFamily, buildFontFamily("jetbrains-mono"));
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
    usePreferencesStore.setState(previousPreferencesState);
  }
});

test("terminal renderer preference can release and reacquire WebGL on a live runtime", async () => {
  const mockWindow = installRuntimeGlobals();
  const { usePreferencesStore } = await import("../src/stores/preferencesStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { releaseWebGL } = await import("../src/terminal/webglContextPool.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const previousPreferencesState = usePreferencesStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);
    mockWindow.tacit = {
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
      session: {
        onTurnComplete() {
          return () => {};
        },
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const { stats, xterm } = createMockXterm();
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    usePreferencesStore.getState().setTerminalRenderer("dom");
    usePreferencesStore.getState().setTerminalRenderer("webgl");
    assert.equal(stats.loadAddonCalls, 1);

    usePreferencesStore.getState().setTerminalRenderer("dom");
    usePreferencesStore.getState().setTerminalRenderer("webgl");
    assert.equal(stats.loadAddonCalls, 2);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
    usePreferencesStore.setState(previousPreferencesState);
    releaseWebGL("terminal-1");
  }
});

test("resetWebGL recreates the addon and refreshes the terminal viewport", async () => {
  installRuntimeGlobals();
  const { acquireWebGL, releaseWebGL, resetWebGL } = await import("../src/terminal/webglContextPool.ts");
  const { stats, xterm } = createMockXterm();

  try {
    assert.equal(acquireWebGL("terminal-1", xterm as never), true);
    assert.equal(stats.loadAddonCalls, 1);

    resetWebGL("terminal-1", "test_reset");

    assert.equal(stats.loadAddonCalls, 2);
    assert.equal(stats.refreshCalls, 1);
  } finally {
    releaseWebGL("terminal-1");
  }
});

test("acquireWebGL warns users to switch renderers when WebGL is unavailable", async () => {
  installRuntimeGlobals();
  const { useLocaleStore } = await import("../src/stores/localeStore.ts");
  const { useNotificationStore } = await import("../src/stores/notificationStore.ts");
  const { acquireWebGL, releaseWebGL } = await import("../src/terminal/webglContextPool.ts");
  const previousLocaleState = useLocaleStore.getState();
  const previousNotificationState = useNotificationStore.getState();
  let notified: { message: string; type: "error" | "info" | "warn" } | null = null;

  try {
    useLocaleStore.setState({ locale: "en" });
    useNotificationStore.setState({
      notifications: [],
      notify: (type, message) => {
        notified = { type, message };
      },
    });

    const xterm = {
      cols: 80,
      rows: 24,
      loadAddon() {
        throw new Error("WebGL unsupported");
      },
    };

    assert.equal(acquireWebGL("terminal-1", xterm as never), false);
    assert.deepEqual(notified, {
      type: "warn",
      message:
        "WebGL terminal rendering is unavailable. Switch to DOM in Settings > Appearance.",
    });
  } finally {
    releaseWebGL("terminal-1");
    useLocaleStore.setState(previousLocaleState);
    useNotificationStore.setState(previousNotificationState);
  }
});

test("starting a parked runtime does not fit or resize the hidden terminal host", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
    setTerminalRuntimeMode,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const resizeCalls: Array<{ cols: number; ptyId: number; rows: number }> = [];
  let createCalls = 0;

  destroyAllTerminalRuntimes();

  try {
    const terminal = {
      ...createTerminal(),
      ptyId: null,
    };
    seedProjectState(useProjectStore, terminal);

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal,
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const host = createFakeContainer();
    const liveContainer = createFakeContainer();
    const { fitAddon, stats, xterm } = createMockXterm();
    liveContainer.appendChild(host);
    runtime.attachedContainer = liveContainer as unknown as HTMLDivElement;
    runtime.fitAddon = fitAddon as unknown as typeof runtime.fitAddon;
    runtime.hostElement = host as unknown as HTMLDivElement;
    runtime.serializeAddon = {
      serialize() {
        return "live buffer";
      },
    } as typeof runtime.serializeAddon;
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    setTerminalRuntimeMode("terminal-1", "live");
    setTerminalRuntimeMode("terminal-1", "parked");

    mockWindow.tacit = {
      session: {
        onTurnComplete() {
          return () => {};
        },
      },
      terminal: {
        create: async () => {
          createCalls += 1;
          return 100 + createCalls;
        },
        destroy: async () => {},
        input() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize(ptyId: number, cols: number, rows: number) {
          resizeCalls.push({ cols, ptyId, rows });
        },
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal,
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(runtime.mode, "parked");
    assert.equal(runtime.attachedContainer, null);
    assert.equal(runtime.ptyId, 101);
    assert.equal(stats.fitCalls, 0);
    assert.deepEqual(resizeCalls, []);
    assert.equal(runtime.inputDisposable, null);
    assert.equal(runtime.resizeDisposable, null);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
  }
});

test("selectAllTerminalRuntime selects the focused xterm buffer", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
    selectAllTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousState = useProjectStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);
    mockWindow.tacit = {
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
      session: {
        onTurnComplete() {
          return () => {};
        },
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const { stats, xterm } = createMockXterm();
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    assert.equal(selectAllTerminalRuntime("terminal-1"), true);
    assert.equal(stats.selectAllCalls, 1);
    assert.equal(selectAllTerminalRuntime("missing-terminal"), false);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousState);
  }
});

test("focusTerminalRuntime focuses without refresh", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useCanvasStore } = await import("../src/stores/canvasStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    focusTerminalRuntime,
    getTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const previousCanvasState = useCanvasStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);
    useCanvasStore.setState({
      isAnimating: false,
      viewport: { x: 0, y: 0, scale: 0.6 },
    });

    mockWindow.tacit = {
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
      session: {
        onTurnComplete() {
          return () => {};
        },
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const { stats, xterm } = createMockXterm();
    runtime.rendererMode = "webgl";
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    assert.equal(focusTerminalRuntime("terminal-1"), true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(stats.focusCalls, 1);
    assert.equal(stats.refreshCalls, 0);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
    useCanvasStore.setState({
      isAnimating: previousCanvasState.isAnimating,
      viewport: previousCanvasState.viewport,
    });
  }
});

test("reattaching a parked runtime reacquires WebGL after the pool evicts it", async () => {
  const mockWindow = installRuntimeGlobals();
  const { usePreferencesStore } = await import("../src/stores/preferencesStore.ts");
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { acquireWebGL, releaseWebGL } = await import("../src/terminal/webglContextPool.ts");
  const {
    attachTerminalContainer,
    destroyAllTerminalRuntimes,
    destroyTerminalRuntime,
    ensureTerminalRuntime,
    getTerminalRuntime,
    setTerminalRuntimeMode,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousState = useProjectStore.getState();
  const previousPreferencesState = usePreferencesStore.getState();

  destroyAllTerminalRuntimes();

  try {
    usePreferencesStore.getState().setTerminalRenderer("webgl");
    seedProjectState(useProjectStore);

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    mockWindow.tacit = {
      terminal: {
        destroy: async () => {},
        input() {},
        resize() {},
      },
    };

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const host = createFakeContainer();
    const liveContainer = createFakeContainer();
    const visibleContainer = createFakeContainer();
    const { fitAddon, stats, xterm } = createMockXterm();
    const serializeAddon = {
      serialize() {
        return "live buffer";
      },
    };

    liveContainer.appendChild(host);
    runtime.attachedContainer = liveContainer as unknown as HTMLDivElement;
    runtime.fitAddon = fitAddon as unknown as typeof runtime.fitAddon;
    runtime.hostElement = host as unknown as HTMLDivElement;
    runtime.serializeAddon = serializeAddon as typeof runtime.serializeAddon;
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    assert.equal(
      acquireWebGL(
        "terminal-1",
        runtime.xterm as NonNullable<typeof runtime.xterm>,
      ),
      true,
    );
    assert.equal(stats.loadAddonCalls, 1);

    setTerminalRuntimeMode("terminal-1", "parked");
    releaseWebGL("terminal-1");
    setTerminalRuntimeMode("terminal-1", "live");
    attachTerminalContainer("terminal-1", visibleContainer as unknown as HTMLDivElement);

    assert.equal(host.parentElement, visibleContainer);
    assert.equal(stats.loadAddonCalls, 2);

    destroyTerminalRuntime("terminal-1");
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousState);
    usePreferencesStore.setState(previousPreferencesState);
    releaseWebGL("terminal-1");
  }
});

test("a tile that attaches while the workdesk view's tab has the terminal gets it back only when the tab lets go", async () => {
  // A terminal added from the workdesk view's tab: the tab borrows the view,
  // then the canvas tile mounts and attaches. The tile used to take the view,
  // leaving the tab blank.
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    attachTerminalContainer,
    borrowTerminalView,
    destroyAllTerminalRuntimes,
    detachTerminalContainer,
    ensureTerminalRuntime,
    getTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousState = useProjectStore.getState();

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore);
    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });
    mockWindow.tacit = {
      terminal: {
        destroy: async () => {},
        input() {},
        resize() {},
      },
    };

    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    if (!runtime) {
      return;
    }

    const host = createFakeContainer();
    const { fitAddon, xterm } = createMockXterm();
    runtime.fitAddon = fitAddon as unknown as typeof runtime.fitAddon;
    runtime.hostElement = host as unknown as HTMLDivElement;
    runtime.xterm = xterm as unknown as typeof runtime.xterm;

    const tab = Object.assign(createFakeContainer(), { isConnected: true });
    const tile = Object.assign(createFakeContainer(), { isConnected: true });

    const giveBack = borrowTerminalView("terminal-1", tab as unknown as HTMLDivElement);
    assert.ok(giveBack);
    attachTerminalContainer("terminal-1", tile as unknown as HTMLDivElement);
    assert.equal(host.parentElement, tab, "the tab keeps the view while it's open");

    giveBack?.();
    assert.equal(host.parentElement, tile, "closing the tab hands the view to the tile");

    // The tile unmounting while the tab has the view: nowhere to go back to.
    const again = borrowTerminalView("terminal-1", tab as unknown as HTMLDivElement);
    detachTerminalContainer("terminal-1", { reason: "test_tile_unmounted" });
    assert.equal(host.parentElement, tab, "a tile letting go doesn't take the view from the tab");
    again?.();
    assert.notEqual(host.parentElement, tab);
    assert.notEqual(host.parentElement, tile);
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousState);
  }
});

test("manual terminal viewport refresh redraws registered xterms immediately", async () => {
  const {
    registerTerminal,
    refreshRegisteredTerminalViewports,
    unregisterTerminal,
  } = await import("../src/terminal/terminalRegistry.ts");
  const first = createMockXterm();
  const second = createMockXterm();
  const serializeAddon = {
    serialize() {
      return "live buffer";
    },
  };

  try {
    registerTerminal(
      "terminal-1",
      first.xterm as unknown as import("@xterm/xterm").Terminal,
      serializeAddon as unknown as import("@xterm/addon-serialize").SerializeAddon,
    );
    registerTerminal(
      "terminal-2",
      second.xterm as unknown as import("@xterm/xterm").Terminal,
      serializeAddon as unknown as import("@xterm/addon-serialize").SerializeAddon,
    );

    refreshRegisteredTerminalViewports("terminal-1");
    assert.equal(first.stats.refreshCalls, 1);
    assert.equal(second.stats.refreshCalls, 0);

    refreshRegisteredTerminalViewports();
    assert.equal(first.stats.refreshCalls, 2);
    assert.equal(second.stats.refreshCalls, 1);

    refreshRegisteredTerminalViewports("missing-terminal");
    assert.equal(first.stats.refreshCalls, 2);
    assert.equal(second.stats.refreshCalls, 1);
  } finally {
    unregisterTerminal("terminal-1");
    unregisterTerminal("terminal-2");
  }
});

test("codex SessionStart hook cancels fallback polling and preserves the exact session", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  let sessionStartListener: ((
    payload: {
      terminalId: string;
      sessionId: string;
      transcriptPath: string | null;
      cwd: string | null;
    },
  ) => void) | null = null;
  let findCodexCalls = 0;
  const watchCalls: Array<{
    cwd: string;
    sessionId: string;
    type: string;
  }> = [];
  const attachCalls: Array<{
    confidence: string;
    cwd: string;
    provider: string;
    sessionId: string;
    terminalId: string;
  }> = [];

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      ptyId: null,
      status: "idle",
      title: "codex",
      type: "codex",
    });

    mockWindow.tacit = {
      hooks: {
        getHealth: async () => ({
          eventsReceived: 0,
          lastEventAt: null,
          parseErrors: 0,
          socketPath: null,
        }),
        getSocketPath: async () => null,
        onSessionStarted(
          callback: (payload: {
            terminalId: string;
            sessionId: string;
            transcriptPath: string | null;
            cwd: string | null;
          }) => void,
        ) {
          sessionStartListener = callback;
          return () => {
            if (sessionStartListener === callback) {
              sessionStartListener = null;
            }
          };
        },
        onStopFailure() {
          return () => {};
        },
        onTurnComplete() {
          return () => {};
        },
      },
      session: {
        findCodex: async () => {
          findCodexCalls += 1;
          return { confidence: "medium", sessionId: "wrong-session" };
        },
        getBypassState: async () => false,
        getCodexLatest: async () => "baseline-session",
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async (type: string, sessionId: string, cwd: string) => {
          watchCalls.push({ cwd, sessionId, type });
          return { ok: true };
        },
      },
      telemetry: {
        attachSession: async (input: {
          confidence: string;
          cwd: string;
          provider: string;
          sessionId: string;
          terminalId: string;
        }) => {
          attachCalls.push(input);
          return { ok: true, sessionFile: `/tmp/${input.sessionId}.jsonl` };
        },
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged() {
          return () => {};
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      sessionStartListener,
      "codex runtime should register a SessionStart hook listener",
    );

    sessionStartListener?.({
      cwd: "/tmp/project-1",
      sessionId: "correct-session",
      terminalId: "terminal-1",
      transcriptPath: "/tmp/correct-session.jsonl",
    });

    await new Promise((resolve) => setTimeout(resolve, 650));

    assert.equal(findCodexCalls, 0);
    assert.deepEqual(watchCalls, [
      {
        cwd: "/tmp/project-1",
        sessionId: "correct-session",
        type: "codex",
      },
    ]);
    assert.deepEqual(attachCalls, [
      {
        confidence: "strong",
        cwd: "/tmp/project-1",
        provider: "codex",
        sessionId: "correct-session",
        terminalId: "terminal-1",
      },
    ]);
    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.sessionId,
      "correct-session",
    );
  } finally {
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousProjectState);
  }
});

test("a Codex launched without a prompt times its session from the first Enter, not from launch", async (t) => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const findCodexCalls: Array<{ startedAt?: string; createdSince?: string }> = [];
  let latestReads = 0;
  let typed: ((data: string) => void) | null = null;

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      ptyId: null,
      status: "idle",
      title: "codex",
      type: "codex",
    });

    mockWindow.tacit = {
      hooks: {
        onSessionStarted() {
          return () => {};
        },
        onStopFailure() {
          return () => {};
        },
        onTurnComplete() {
          return () => {};
        },
      },
      session: {
        findCodex: async (_cwd: string, startedAt?: string, createdSince?: string) => {
          findCodexCalls.push({ startedAt, createdSince });
          return { confidence: "medium", sessionId: "this-codex" };
        },
        getBypassState: async () => false,
        getCodexLatest: async () => {
          latestReads += 1;
          return "baseline-session";
        },
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async () => ({ ok: true }),
      },
      telemetry: {
        attachSession: async () => ({ ok: true, sessionFile: null }),
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged() {
          return () => {};
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    // Every timer is fake from before launch, so one started at launch runs out here too.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const flush = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 500) {
        t.mock.timers.tick(500);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });
    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    const { xterm } = createMockXterm();
    runtime.xterm = {
      ...xterm,
      onData(callback: (data: string) => void) {
        typed = callback;
        return { dispose() {} };
      },
    } as unknown as typeof runtime.xterm;
    runtime.attachedContainer = createFakeContainer() as unknown as HTMLDivElement;

    await flush(500);
    assert.ok(typed, "the runtime should listen for typing once the pty is up");
    assert.equal(latestReads, 1, "Codex's newest thread is read before it starts");

    // Nobody types for a minute: Codex has no session, and nothing is timed.
    await flush(60_000);
    assert.deepEqual(findCodexCalls, []);
    assert.equal(runtime.hookFallbackTimer, null);

    typed!("hi\r");
    const enterAt = new Date().toISOString();
    await flush(29_500);
    assert.deepEqual(findCodexCalls, [], "the hook still has its 30s");
    await flush(1_500);

    assert.deepEqual(findCodexCalls[0], { startedAt: enterAt, createdSince: enterAt });
    assert.equal(latestReads, 1, "the baseline is the one read before launch");
    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.sessionId,
      "this-codex",
    );
    assert.equal(runtime.onSubmitCaptureSession, null, "found, so Enter stops restarting the clock");
  } finally {
    t.mock.timers.reset();
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousProjectState);
  }
});

test("a Claude waiting on its folder question isn't timed until Enter, then is searched for by its launch", async (t) => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    getTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const findClaudeCalls: Array<string | undefined> = [];
  let typed: ((data: string) => void) | null = null;

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      ptyId: null,
      status: "idle",
      title: "claude",
      type: "claude",
    });

    mockWindow.tacit = {
      hooks: {
        onSessionStarted() {
          return () => {};
        },
        onStopFailure() {
          return () => {};
        },
        onTurnComplete() {
          return () => {};
        },
      },
      session: {
        findClaude: async (_cwd: string, startedAt?: string) => {
          findClaudeCalls.push(startedAt);
          return { confidence: "strong", sessionId: "this-claude" };
        },
        getBypassState: async () => false,
        getPermissionMode: async () => null,
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async () => ({ ok: true }),
      },
      telemetry: {
        attachSession: async () => ({ ok: true, sessionFile: null }),
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged() {
          return () => {};
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        getPid: async () => 4242,
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    // Every timer is fake from before launch, so one started at launch runs out here too.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const flush = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 500) {
        t.mock.timers.tick(500);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
    };

    const launchedBefore = Date.now();
    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });
    const runtime = getTerminalRuntime("terminal-1");
    assert.ok(runtime);
    const { xterm } = createMockXterm();
    runtime.xterm = {
      ...xterm,
      onData(callback: (data: string) => void) {
        typed = callback;
        return { dispose() {} };
      },
    } as unknown as typeof runtime.xterm;
    runtime.attachedContainer = createFakeContainer() as unknown as HTMLDivElement;

    await flush(500);
    assert.ok(typed, "the runtime should listen for typing once the pty is up");
    const launchedAfter = Date.now();

    // Claude asks whether to trust the folder; no answer for two minutes.
    await flush(120_000);
    assert.deepEqual(findClaudeCalls, []);

    typed!("\r");
    await flush(29_500);
    assert.deepEqual(findClaudeCalls, [], "the hook still has its 30s");
    await flush(6_000);

    assert.ok(findClaudeCalls.length > 0, "the fallback searches once the clock runs out");
    const anchoredAt = new Date(findClaudeCalls[0]!).getTime();
    assert.ok(
      anchoredAt >= launchedBefore && anchoredAt <= launchedAfter,
      "Claude is matched by when it started, not by the Enter",
    );
    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.sessionId,
      "this-claude",
    );
  } finally {
    t.mock.timers.reset();
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousProjectState);
  }
});

test("wuu polling attaches the discovered session to telemetry", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const watchCalls: Array<{
    cwd: string;
    sessionId: string;
    type: string;
  }> = [];
  const attachCalls: Array<{
    confidence: string;
    cwd: string;
    provider: string;
    sessionId: string;
    terminalId: string;
  }> = [];
  let findWuuCalls = 0;

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      ptyId: null,
      status: "idle",
      title: "wuu",
      type: "wuu",
    });

    mockWindow.tacit = {
      session: {
        findWuu: async () => {
          findWuuCalls += 1;
          return {
            confidence: "medium",
            filePath: "/tmp/project-1/.wuu/sessions/wuu-session.jsonl",
            sessionId: "wuu-session",
          };
        },
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async (type: string, sessionId: string, cwd: string) => {
          watchCalls.push({ cwd, sessionId, type });
          return { ok: true };
        },
      },
      telemetry: {
        attachSession: async (input: {
          confidence: string;
          cwd: string;
          provider: string;
          sessionId: string;
          terminalId: string;
        }) => {
          attachCalls.push(input);
          return { ok: true, sessionFile: `/tmp/${input.sessionId}.jsonl` };
        },
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged() {
          return () => {};
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.ok(findWuuCalls > 0);
    assert.deepEqual(watchCalls, [
      {
        cwd: "/tmp/project-1",
        sessionId: "wuu-session",
        type: "wuu",
      },
    ]);
    assert.deepEqual(attachCalls, [
      {
        confidence: "medium",
        cwd: "/tmp/project-1",
        provider: "wuu",
        sessionId: "wuu-session",
        terminalId: "terminal-1",
      },
    ]);
    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.sessionId,
      "wuu-session",
    );
  } finally {
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousProjectState);
  }
});

test("opencode polling attaches the discovered session to telemetry", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const { useTerminalRuntimeStateStore } = await import(
    "../src/stores/terminalRuntimeStateStore.ts"
  );
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  const watchCalls: Array<{
    cwd: string;
    sessionId: string;
    type: string;
  }> = [];
  const attachCalls: Array<{
    confidence: string;
    cwd: string;
    provider: string;
    sessionId: string;
    terminalId: string;
  }> = [];
  let findOpenCodeCalls = 0;

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      ptyId: null,
      status: "idle",
      title: "opencode",
      type: "opencode",
    });

    mockWindow.tacit = {
      session: {
        findOpenCode: async () => {
          findOpenCodeCalls += 1;
          return {
            confidence: "medium",
            filePath: "/tmp/opencode.db",
            sessionId: "ses_opencode",
          };
        },
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async (type: string, sessionId: string, cwd: string) => {
          watchCalls.push({ cwd, sessionId, type });
          return { ok: true };
        },
      },
      telemetry: {
        attachSession: async (input: {
          confidence: string;
          cwd: string;
          provider: string;
          sessionId: string;
          terminalId: string;
        }) => {
          attachCalls.push(input);
          return { ok: true, sessionFile: "/tmp/opencode.db" };
        },
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged() {
          return () => {};
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.ok(findOpenCodeCalls > 0);
    assert.deepEqual(watchCalls, [
      {
        cwd: "/tmp/project-1",
        sessionId: "ses_opencode",
        type: "opencode",
      },
    ]);
    assert.deepEqual(attachCalls, [
      {
        confidence: "medium",
        cwd: "/tmp/project-1",
        provider: "opencode",
        sessionId: "ses_opencode",
        terminalId: "terminal-1",
      },
    ]);
    assert.equal(
      useTerminalRuntimeStateStore.getState().terminals["terminal-1"]?.sessionId,
      "ses_opencode",
    );
  } finally {
    destroyAllTerminalRuntimes();
    useTerminalRuntimeStateStore.getState().reset();
    useProjectStore.setState(previousProjectState);
  }
});

test("push telemetry updates replace a live terminal's first_user_prompt when the session changes", async () => {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const {
    destroyAllTerminalRuntimes,
    ensureTerminalRuntime,
    useTerminalRuntimeStore,
  } = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  let snapshotListener:
    | ((payload: { terminalId: string; snapshot: Record<string, unknown> }) => void)
    | null = null;

  destroyAllTerminalRuntimes();

  try {
    seedProjectState(useProjectStore, {
      ...createTerminal(),
      title: "codex",
      type: "codex",
    });

    mockWindow.tacit = {
      hooks: {
        onSessionStarted() {
          return () => {};
        },
        onStopFailure() {
          return () => {};
        },
        onTurnComplete() {
          return () => {};
        },
      },
      session: {
        getBypassState: async () => false,
        getCodexLatest: async () => "baseline-session",
        onTurnComplete() {
          return () => {};
        },
        unwatch: async () => {},
        watch: async () => ({ ok: true }),
      },
      telemetry: {
        attachSession: async () => ({ ok: true, sessionFile: null }),
        detachSession: async () => {},
        getTerminal: async () => null,
        onSnapshotChanged(
          callback: (payload: {
            terminalId: string;
            snapshot: Record<string, unknown>;
          }) => void,
        ) {
          snapshotListener = callback;
          return () => {
            if (snapshotListener === callback) {
              snapshotListener = null;
            }
          };
        },
      },
      terminal: {
        create: async () => 42,
        destroy: async () => {},
        input() {},
        notifyThemeChanged() {},
        onExit() {
          return () => {};
        },
        onOutput() {
          return () => {};
        },
        resize() {},
      },
    };

    ensureTerminalRuntime({
      projectId: "project-1",
      terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
      worktreeId: "worktree-1",
      worktreePath: "/tmp/project-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(snapshotListener, "runtime should subscribe to telemetry push updates");

    snapshotListener?.({
      terminalId: "terminal-1",
      snapshot: {
        terminal_id: "terminal-1",
        worktree_path: "/tmp/project-1",
        provider: "codex",
        session_attached: true,
        session_attach_confidence: "strong",
        session_id: "session-old",
        session_file: "/tmp/session-old.jsonl",
        first_user_prompt: "旧会话标题",
        turn_state: "turn_complete",
        pty_alive: true,
        descendant_processes: [],
        active_tool_calls: 0,
        task_status: "idle",
        task_status_source: "turn_state",
        result_exists: false,
        derived_status: "idle",
      },
    });

    assert.equal(
      useTerminalRuntimeStore.getState().terminals["terminal-1"]?.telemetry
        ?.first_user_prompt,
      "旧会话标题",
    );

    snapshotListener?.({
      terminalId: "terminal-1",
      snapshot: {
        terminal_id: "terminal-1",
        worktree_path: "/tmp/project-1",
        provider: "codex",
        session_attached: true,
        session_attach_confidence: "strong",
        session_id: "session-new",
        session_file: "/tmp/session-new.jsonl",
        first_user_prompt: "新会话标题",
        turn_state: "turn_complete",
        pty_alive: true,
        descendant_processes: [],
        active_tool_calls: 0,
        task_status: "idle",
        task_status_source: "turn_state",
        result_exists: false,
        derived_status: "idle",
      },
    });

    const telemetry =
      useTerminalRuntimeStore.getState().terminals["terminal-1"]?.telemetry;
    assert.equal(telemetry?.session_id, "session-new");
    assert.equal(telemetry?.session_file, "/tmp/session-new.jsonl");
    assert.equal(telemetry?.first_user_prompt, "新会话标题");
  } finally {
    destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
  }
});

async function runtimeSpawningInto(terminalExtra: Record<string, unknown>) {
  const mockWindow = installRuntimeGlobals();
  const { useProjectStore } = await import("../src/stores/projectStore.ts");
  const store = await import("../src/terminal/terminalRuntimeStore.ts");
  const previousProjectState = useProjectStore.getState();
  store.destroyAllTerminalRuntimes();
  const created: Array<{ cols?: number; rows?: number }> = [];
  const resized: Array<{ cols: number; rows: number }> = [];
  seedProjectState(useProjectStore, {
    ...createTerminal(),
    focused: false,
    ptyId: null,
    status: "idle",
    ...terminalExtra,
  } as ReturnType<typeof createTerminal>);
  mockWindow.tacit = {
    terminal: {
      create: async (options: { cols?: number; rows?: number }) => {
        created.push({ cols: options.cols, rows: options.rows });
        return 42;
      },
      destroy: async () => {},
      input() {},
      onExit() {
        return () => {};
      },
      onOutput() {
        return () => {};
      },
      resize(_ptyId: number, cols: number, rows: number) {
        resized.push({ cols, rows });
      },
    },
    session: {
      onTurnComplete() {
        return () => {};
      },
    },
  };
  store.ensureTerminalRuntime({
    projectId: "project-1",
    terminal: useProjectStore.getState().projects[0].worktrees[0].terminals[0],
    worktreeId: "worktree-1",
    worktreePath: "/tmp/project-1",
  });
  const runtime = store.getTerminalRuntime("terminal-1")!;
  const spawned = async () => {
    for (let i = 0; i < 300 && runtime.ptyId === null; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(runtime.ptyId, 42, "the process started");
  };
  const savedSize = () => useProjectStore.getState().projects[0].worktrees[0].terminals[0].ptySize;
  const cleanup = () => {
    store.destroyAllTerminalRuntimes();
    useProjectStore.setState(previousProjectState);
  };
  return { runtime, store, created, resized, spawned, savedSize, cleanup };
}

test("a restored terminal whose tile isn't measured yet starts at the size it last had, not 80×24 (SHR-95)", async () => {
  const t = await runtimeSpawningInto({ ptySize: { cols: 131, rows: 58 } });
  try {
    await t.spawned();
    assert.deepEqual(t.created, [{ cols: 131, rows: 58 }]);
  } finally {
    t.cleanup();
  }
});

test("a tile on screen is measured before its process starts; that size is used and kept for next time (SHR-95)", async () => {
  const t = await runtimeSpawningInto({ ptySize: { cols: 131, rows: 58 } });
  try {
    // The tile attached before the staggered spawn ran.
    t.runtime.attachedContainer = createFakeContainer() as unknown as HTMLDivElement;
    t.runtime.fitAddon = { fit() {}, proposeDimensions: () => ({ cols: 150, rows: 40 }) } as unknown as typeof t.runtime.fitAddon;
    await t.spawned();
    assert.deepEqual(t.created, [{ cols: 150, rows: 40 }]);
    assert.deepEqual(t.savedSize(), { cols: 150, rows: 40 });
  } finally {
    t.cleanup();
  }
});

test("a terminal never measured and never sized starts at main's default", async () => {
  const t = await runtimeSpawningInto({});
  try {
    await t.spawned();
    assert.deepEqual(t.created, [{ cols: undefined, rows: undefined }]);
  } finally {
    t.cleanup();
  }
});

test("dragging a tile refits it every frame but tells the process twice: as the drag starts and when it settles (SHR-96)", async () => {
  const t = await runtimeSpawningInto({ ptySize: { cols: 120, rows: 40 } });
  try {
    await t.spawned();
    const { fitAddon, stats, xterm } = createMockXterm();
    xterm.cols = 120;
    xterm.rows = 40;
    t.runtime.attachedContainer = createFakeContainer() as unknown as HTMLDivElement;
    t.runtime.fitAddon = fitAddon as unknown as typeof t.runtime.fitAddon;
    t.runtime.xterm = xterm as unknown as typeof t.runtime.xterm;
    for (let frame = 1; frame <= 30; frame++) {
      xterm.rows = 40 + frame;
      t.store.fitTerminalRuntime("terminal-1");
      await new Promise((r) => setTimeout(r, 8));
    }
    assert.equal(stats.fitCalls, 30, "the tile follows every frame");
    assert.deepEqual(t.resized, [{ cols: 120, rows: 41 }]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(t.resized, [
      { cols: 120, rows: 41 },
      { cols: 120, rows: 70 },
    ]);
    assert.deepEqual(t.savedSize(), { cols: 120, rows: 70 });
  } finally {
    t.cleanup();
  }
});
