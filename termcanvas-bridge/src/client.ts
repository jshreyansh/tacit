import fs from "node:fs";
import { resolveTermCanvasPortFile } from "../../shared/termcanvas-instance.ts";

/**
 * Every spawned terminal already gets TERMCANVAS_TERMINAL_ID and (usually)
 * TERMCANVAS_PORT_FILE in its environment — see electron/pty-launch.ts's
 * buildLaunchSpec. This mirrors cli/termcanvas.ts's own port-file discovery
 * so this MCP server (run via cli/agent-shims/run.ts's --mcp-config
 * injection) talks to whichever TermCanvas instance actually spawned it.
 */
function resolveBaseUrl(): string {
  const envUrl = process.env.TERMCANVAS_URL?.trim();
  if (envUrl) return envUrl.replace(/\/$/, "");

  const portFile = resolveTermCanvasPortFile(process.env);
  const raw = fs.readFileSync(portFile, "utf-8").trim();
  const port = parseInt(raw.split("\n")[0], 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid port in ${portFile}`);
  }
  return `http://127.0.0.1:${port}`;
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const baseUrl = resolveBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TermCanvas API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export function getTerminalId(): string | null {
  return process.env.TERMCANVAS_TERMINAL_ID?.trim() || null;
}
