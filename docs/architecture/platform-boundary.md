# Platform boundary: Electron now, portable where it's cheap

Decided 26 Sep 2026, after reviewing a proposal to put Tacit's React code
behind a "TACIT Platform API" and keep Tauri as an option. This records what we
found in the code, what we're doing, and what we deliberately aren't.

## The rule

Every system capability (files, processes, terminals, windows, browsers,
network, OS integration) reaches React through **`window.tacit`**, the typed
preload API. React and product code never import `electron`, `ipcRenderer`,
Node built-ins (`fs`, `child_process`, `path`, `os`), or anything that only
runs in the main process.

When adding a capability, ask:

> Can this live behind `window.tacit` without leaking Electron or Node into
> the React / product layer?

If yes, build it that way. If the answer seems to be no, say so and discuss it
before building.

And on the main-process side, every IPC handler follows **least privilege**:
it does one narrow thing, checks that the call comes from the app's own window,
validates its arguments, and never accepts an arbitrary path or command when a
scoped one will do.

## What already holds (verified 26 Sep)

- Renderer isolation is Electron's recommended setup: `contextIsolation: true`,
  `nodeIntegration: false`, sandboxed; a strict CSP (`script-src 'self'`).
- No file under `src/` imports Electron or Node.
- The platform API exists: `window.tacit.*`, about 40 namespaces (`fs`,
  `terminal`, `git`, `browser`, …), declared in `electron/preload.ts` and typed
  in `src/types/index.ts`. That **is** the platform contract; there is no need
  for a separate `@tacit/platform` package or extra adapter layers.

## Follow-up work

Improvements to this boundary are tracked in the project's issue tracker
rather than listed here, so this page stays a description of the rule. When
one lands, update "What already holds" above.

## Deliberately not doing

- **Rust** only where a measurement shows a bottleneck. The one real
  performance problem so far, terminal lag, was an algorithm bug in JavaScript.
- **Tauri** is not on the roadmap. The React UI is already portable; the
  hard-to-port parts are browser nodes (`<webview>`) and the Node main process
  (`main.ts`, PTYs, telemetry, the MCP bridge), and an interface layer wouldn't
  make those portable. Re-evaluate only with evidence: bundle size, memory,
  startup time, or a product need.
- No big-bang refactor. Improve the boundary where we touch code anyway.
