import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TermCanvasInstance = "prod" | "dev";

/**
 * Data lived in ~/.termcanvas before the app was named Tacit. Everything the
 * user has — canvases, snapshots, pins, the decision record, the manager
 * tenure log — is in there, so the rename moves it rather than starting empty
 * beside it.
 *
 * A rename, not a copy: two directories both looking authoritative is how you
 * end up editing one and reading the other. If the new directory already
 * exists the old one is left untouched, since something has clearly already
 * been written under the new name and silently merging is worse than leaving
 * both.
 */
const LEGACY_DIR_NAME: Record<TermCanvasInstance, string> = {
  prod: ".termcanvas",
  dev: ".termcanvas-dev",
};

const migrated = new Set<string>();

function migrateLegacyDataDir(instance: TermCanvasInstance, target: string) {
  if (migrated.has(target)) return;
  migrated.add(target);
  const legacy = path.join(os.homedir(), LEGACY_DIR_NAME[instance]);
  try {
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
    fs.renameSync(legacy, target);
    console.log(`[Tacit] moved ${legacy} → ${target}`);
  } catch (err) {
    // Losing the migration means starting with an empty canvas, which is
    // recoverable by hand. Throwing here would mean the app doesn't start.
    console.warn("[Tacit] could not move the legacy data directory:", err);
  }
}

function normalizeInstance(value: string | undefined): TermCanvasInstance | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "prod" || normalized === "production") return "prod";
  if (normalized === "dev" || normalized === "development") return "dev";
  return null;
}

export function getTermCanvasDataDir(instance: TermCanvasInstance): string {
  const dir = path.join(
    os.homedir(),
    instance === "dev" ? ".tacit-dev" : ".tacit",
  );
  // Runs here rather than at a startup hook because callers read this through
  // module-level constants, which are evaluated before any startup code gets a
  // chance to run. Guarded so it costs one existsSync per process.
  migrateLegacyDataDir(instance, dir);
  return dir;
}

export function resolveTermCanvasInstance(
  env: Record<string, string | undefined> = process.env,
): TermCanvasInstance {
  return normalizeInstance(env.TERMCANVAS_INSTANCE) ?? "prod";
}

export function resolveTermCanvasPortFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.TERMCANVAS_PORT_FILE?.trim();
  if (explicit) return explicit;
  return path.join(
    getTermCanvasDataDir(resolveTermCanvasInstance(env)),
    "port",
  );
}
