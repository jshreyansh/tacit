import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import fs from "fs";
import path from "path";
import { build as esbuild, context as esbuildCtx, type Plugin as EsbuildPlugin } from "esbuild";
import { ensureCliLauncher } from "./electron/cli-launchers";

/**
 * `entry` is the app's own preload; `guest` is the observer injected into pages
 * loaded in browser nodes. They are built the same way but are emphatically not
 * the same thing — the guest runs inside pages the user is logged into and
 * exposes no bridge at all (electron/browser-observer-preload.ts).
 */
function buildPreload(entry: string, outfile: string): Plugin {
  const opts = {
    entryPoints: [entry],
    outfile,
    format: "cjs" as const,
    platform: "node" as const,
    bundle: true,
    external: ["electron"],
  };
  return {
    name: `build-preload:${path.basename(outfile)}`,
    async buildStart() {
      if (this.meta.watchMode) {
        const ctx = await esbuildCtx(opts);
        await ctx.watch();
      } else {
        await esbuild(opts);
      }
    },
  };
}

/** esbuild plugin: after write, create the platform-appropriate CLI launcher. */
function cliSymlinkPlugin(outfile: string): EsbuildPlugin {
  const jsPath = path.resolve(outfile);
  return {
    name: "cli-symlink",
    setup(build) {
      build.onEnd(() => {
        ensureCliLauncher(jsPath);
      });
    },
  };
}

function buildCli(): Plugin {
  const outfile = "dist-cli/tacit.js";
  const opts = {
    entryPoints: ["cli/termcanvas.ts"],
    outfile,
    format: "esm" as const,
    platform: "node" as const,
    bundle: true,
    banner: { js: "#!/usr/bin/env node" },
    plugins: [cliSymlinkPlugin(outfile)],
  };
  return {
    name: "build-cli",
    async buildStart() {
      if (this.meta.watchMode) {
        const ctx = await esbuildCtx(opts);
        await ctx.watch();
      } else {
        await esbuild(opts);
      }
    },
  };
}

function buildHydra(): Plugin {
  const outfile = "dist-cli/hydra.js";
  const opts = {
    entryPoints: ["hydra/src/cli.ts"],
    outfile,
    format: "esm" as const,
    platform: "node" as const,
    bundle: true,
    banner: { js: "#!/usr/bin/env node" },
    plugins: [cliSymlinkPlugin(outfile)],
  };
  return {
    name: "build-hydra",
    async buildStart() {
      if (this.meta.watchMode) {
        const ctx = await esbuildCtx(opts);
        await ctx.watch();
      } else {
        await esbuild(opts);
      }
    },
  };
}

function buildBrowse(): Plugin {
  const outfile = "dist-cli/browse.js";
  const opts = {
    entryPoints: ["browse/src/cli.ts"],
    outfile,
    format: "esm" as const,
    platform: "node" as const,
    bundle: true,
    banner: { js: "#!/usr/bin/env node" },
    external: ["playwright"],
    plugins: [cliSymlinkPlugin(outfile)],
  };
  return {
    name: "build-browse",
    async buildStart() {
      if (this.meta.watchMode) {
        const ctx = await esbuildCtx(opts);
        await ctx.watch();
      } else {
        await esbuild(opts);
      }
    },
  };
}

/**
 * The termcanvas-bridge MCP server. It has its own `pnpm build` in
 * termcanvas-bridge/build.ts, but nothing invoked it from the root build, so a
 * clean checkout packaged an app whose bridge binary didn't exist — and
 * main.ts's getTermcanvasBridgeCliPath() fails soft, leaving every Claude
 * terminal with no termcanvas-bridge tools and no error. Building it here, in
 * the same place as the CLIs, means `pnpm build` alone is enough for
 * electron-builder to find everything it copies.
 *
 * No cliSymlinkPlugin: this is never on PATH, it's spawned by absolute path.
 * Nothing external either — see the note in termcanvas-bridge/build.ts.
 */
function buildTermcanvasBridge(): Plugin {
  const opts = {
    entryPoints: ["termcanvas-bridge/src/cli.ts"],
    outfile: "termcanvas-bridge/dist/termcanvas-bridge.js",
    format: "esm" as const,
    platform: "node" as const,
    bundle: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  };
  return {
    name: "build-termcanvas-bridge",
    async buildStart() {
      if (this.meta.watchMode) {
        const ctx = await esbuildCtx(opts);
        await ctx.watch();
      } else {
        await esbuild(opts);
      }
    },
  };
}

function buildAgentShims(): Plugin {
  const shimNames = ["codex", "claude"] as const;
  const buildOptions = shimNames.map((name) => {
    const outfile = `dist-cli/agent-shims/${name}.js`;
    return {
      entryPoints: [`cli/agent-shims/${name}.ts`],
      outfile,
      format: "esm" as const,
      platform: "node" as const,
      bundle: true,
      banner: { js: "#!/usr/bin/env node" },
      plugins: [cliSymlinkPlugin(outfile)],
    };
  });

  return {
    name: "build-agent-shims",
    async buildStart() {
      fs.mkdirSync("dist-cli/agent-shims", { recursive: true });
      if (this.meta.watchMode) {
        for (const opts of buildOptions) {
          const ctx = await esbuildCtx(opts);
          await ctx.watch();
        }
      } else {
        await Promise.all(buildOptions.map((opts) => esbuild(opts)));
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    buildPreload("electron/preload.ts", "dist-electron/preload.cjs"),
    buildPreload(
      "electron/browser-observer-preload.ts",
      "dist-electron/browser-observer-preload.cjs",
    ),
    buildCli(),
    buildHydra(),
    buildBrowse(),
    buildTermcanvasBridge(),
    buildAgentShims(),
    electron([
      {
        entry: "electron/main.ts",
        vite: {
          define: {
            "process.env.VITE_SUPABASE_URL": JSON.stringify(
              process.env.VITE_SUPABASE_URL ?? "",
            ),
            "process.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(
              process.env.VITE_SUPABASE_ANON_KEY ?? "",
            ),
          },
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["node-pty", "adm-zip", "@anthropic-ai/sdk"],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Pre-bundling @wterm/* would move the modules into .vite/deps, breaking
  // the `new URL("../wasm/...", import.meta.url)` lookup the ghostty core
  // uses to find its WASM blob. Keep them as-is so the relative URL stays
  // valid against node_modules.
  optimizeDeps: {
    exclude: ["@wterm/core", "@wterm/dom", "@wterm/ghostty", "@wterm/react"],
  },
  base: "./",
  // Hydra writes worktrees, dispatch state, and result.json under
  // .hydra/ + .worktrees/ at runtime. The dev server's chokidar
  // watcher would otherwise see those writes, decide a "source file"
  // changed, and trigger a full renderer reload (visible as a
  // Cmd+R-style flash whenever a child Claude is dispatched). The
  // .gitignore covers git but not Vite — explicit ignore here.
  server: {
    watch: {
      ignored: [
        "**/.hydra/**",
        "**/.worktrees/**",
        "**/.hydra-result-*.md",
        "**/.hydra-task-*.md",
      ],
    },
  },
  build: {
    outDir: "dist",
  },
});
