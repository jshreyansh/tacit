import type { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";

const registry = new Map<
  string,
  { xterm: Terminal; serialize: SerializeAddon }
>();

export function registerTerminal(
  id: string,
  xterm: Terminal,
  serialize: SerializeAddon,
) {
  registry.set(id, { xterm, serialize });
}

export function unregisterTerminal(id: string) {
  registry.delete(id);
}

function refreshViewport(xterm: Terminal) {
  const lastRow = Math.max(0, xterm.rows - 1);
  xterm.refresh(0, lastRow);
}

export function refreshRegisteredTerminalViewports(id?: string) {
  if (id) {
    const entry = registry.get(id);
    if (!entry) return;
    refreshViewport(entry.xterm);
    return;
  }

  for (const entry of registry.values()) {
    refreshViewport(entry.xterm);
  }
}

/**
 * Where the terminal's viewport currently sits inside its buffer, or null when
 * no live renderer is registered for that id. Used by the canvas wheel router
 * to decide whether a scroll gesture still has scrollback to travel.
 */
export function getTerminalScrollPosition(
  id: string,
): { viewportY: number; baseY: number } | null {
  const entry = registry.get(id);
  if (!entry) return null;
  const buffer = entry.xterm.buffer.active;
  return { viewportY: buffer.viewportY, baseY: buffer.baseY };
}

export function serializeTerminal(id: string): string | null {
  const entry = registry.get(id);
  if (!entry) return null;
  return entry.serialize.serialize();
}

export function serializeAllTerminals(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, entry] of registry) {
    try {
      result[id] = entry.serialize.serialize();
    } catch {
    }
  }
  return result;
}
