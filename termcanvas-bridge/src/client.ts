import fs from "node:fs";
import { resolveTermCanvasPortFile } from "../../shared/termcanvas-instance.ts";

/**
 * Every spawned terminal already gets TERMCANVAS_TERMINAL_ID and (usually)
 * TERMCANVAS_PORT_FILE in its environment — see electron/pty-launch.ts's
 * buildLaunchSpec. This mirrors cli/termcanvas.ts's own port-file discovery
 * so this MCP server (run via cli/agent-shims/run.ts's --mcp-config
 * injection) talks to whichever Tacit instance actually spawned it.
 */
function resolveConnection(): { baseUrl: string; authToken: string } {
  const envUrl = process.env.TERMCANVAS_URL?.trim();
  if (envUrl) {
    return {
      baseUrl: envUrl.replace(/\/$/, ""),
      authToken: process.env.TERMCANVAS_API_TOKEN?.trim() ?? "",
    };
  }

  const portFile = resolveTermCanvasPortFile(process.env);
  const raw = fs.readFileSync(portFile, "utf-8").trim();
  const [portText, , authToken = ""] = raw.split("\n");
  const port = parseInt(portText, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid port in ${portFile}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, authToken };
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { baseUrl, authToken } = resolveConnection();
  if (!authToken) {
    throw new Error("Tacit API credentials are unavailable");
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tacit API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export function getTerminalId(): string | null {
  return process.env.TERMCANVAS_TERMINAL_ID?.trim() || null;
}
