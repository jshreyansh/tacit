import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/tacit-bridge.js",
  banner: { js: "#!/usr/bin/env node" },
  // Nothing is external on purpose. In dev this file resolves its imports
  // through tacit-bridge/node_modules, but the packaged app copies only
  // this one file into Contents/Resources/tacit-bridge (see
  // electron-builder.yml), where no node_modules exists — an external import
  // would throw on startup, and main.ts's buildClaudeTacitBridgeArgs
  // would then hand every Claude terminal an MCP server that dies
  // immediately, silently costing them every tacit-bridge tool.
  // Self-contained is the only shape that behaves the same in both.
});
