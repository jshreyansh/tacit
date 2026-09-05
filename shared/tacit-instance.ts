import os from "node:os";
import path from "node:path";

export type TacitInstance = "prod" | "dev";

function normalizeInstance(value: string | undefined): TacitInstance | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "prod" || normalized === "production") return "prod";
  if (normalized === "dev" || normalized === "development") return "dev";
  return null;
}

export function getTacitDataDir(instance: TacitInstance): string {
  return path.join(os.homedir(), instance === "dev" ? ".tacit-dev" : ".tacit");
}

export function resolveTacitInstance(
  env: Record<string, string | undefined> = process.env,
): TacitInstance {
  return normalizeInstance(env.TACIT_INSTANCE) ?? "prod";
}

export function resolveTacitPortFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.TACIT_PORT_FILE?.trim();
  if (explicit) return explicit;
  return path.join(
    getTacitDataDir(resolveTacitInstance(env)),
    "port",
  );
}
