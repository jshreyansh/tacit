# Runtime surfaces and ownership

Tacit ships two execution surfaces from one repository. They intentionally share domain code, but they do not own the same lifecycle.

## Desktop runtime

The Electron process owns the local interactive application: windows, canvas state, embedded browser views, PTYs, local session discovery, desktop telemetry, updates, and the loopback control API. Renderer code communicates with this process through the preload IPC boundary. The desktop loopback API is authenticated with the per-launch token written to the local port file.

Desktop entry points live primarily under `electron/`, `src/`, and `cli/`. Validate this surface with `pnpm typecheck`, `pnpm test:security`, `pnpm test`, and `pnpm build`.

## Headless runtime

The headless process owns remote/server operation without Electron windows: authenticated HTTP control, project and worktree state, PTY workers, workflows, telemetry, artifacts, webhooks, and shutdown. It has its own container and persistence lifecycle. Deployment authentication comes from `TERMCANVAS_API_TOKEN`, not the desktop per-launch token.

Headless entry points live primarily under `headless-runtime/`, `server/`, and the shared Hydra runtime. Validate this surface with `pnpm typecheck:headless` and the headless tests included in `pnpm test`.

## Shared boundary

Code under `shared/`, selected services under `electron/`, and `hydra/src/` may be consumed by both surfaces. Shared modules must not assume that a browser window, Electron IPC, or a desktop filesystem layout exists. Surface-specific adapters should provide those capabilities at the edge.

CI treats both type surfaces and the complete test/build path as one release gate. A change is not healthy if the desktop app compiles while the headless runtime is broken, or vice versa.
