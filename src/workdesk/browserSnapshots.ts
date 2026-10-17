import { useEffect, useState } from "react";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";

/**
 * Live pictures of browser pages for the workdesk view: each browser's
 * webview captured every few seconds while the view shows. The page itself
 * stays on the canvas: moving a webview reloads its page.
 */
async function capture(id: string): Promise<string | null> {
  const webview = getBrowserWebview(id);
  // A browser driving a Chrome tab through the extension has no webview here.
  if (!webview) return null;
  try {
    const image = await webview.capturePage();
    return image.isEmpty() ? null : image.toDataURL();
  } catch (error) {
    // Not attached or still loading: no picture this round, the next one tries again.
    console.warn(`[workdesk] couldn't capture browser ${id}:`, error);
    return null;
  }
}

export function useBrowserSnapshots(ids: readonly string[], active: boolean, everyMs: number): Record<string, string> {
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});
  const key = ids.join("|");
  useEffect(() => {
    if (!active || ids.length === 0) return;
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(ids.map(async (id) => [id, await capture(id)] as const));
      if (cancelled) return;
      setSnapshots((prev) => {
        const next: Record<string, string> = {};
        for (const [id, url] of entries) {
          const kept = url ?? prev[id];
          if (kept) next[id] = kept;
        }
        return next;
      });
    };
    void run();
    const timer = window.setInterval(() => void run(), everyMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, active, everyMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return snapshots;
}
