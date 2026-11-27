import { create } from "zustand";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { wireEndsOf } from "../canvas/wireEnds";

/**
 * The window's half of agents driving browser tiles
 * (electron/browser-service.ts): who drives each tile, for the bar on it;
 * which browsers a terminal may use; and keeping a driven tile drawn when it's
 * off screen or behind the grid, since a hidden page drops input.
 */
interface DrivingState {
  byCard: Record<string, { driver: string | null; held: "user" | "stopped" | null }>;
}
export const useBrowserDrivingStore = create<DrivingState>(() => ({ byCard: {} }));

let started = false;
export function startBrowserDriving(): () => void {
  if (started || !window.tacit?.browser?.onDriver) return () => {};
  started = true;
  const off = window.tacit.browser.onDriver(({ cardId, driver, held }) => {
    useBrowserDrivingStore.setState((s) => ({ byCard: { ...s.byCard, [cardId]: { driver, held } } }));
  });
  return () => {
    started = false;
    off();
  };
}

/** Every browser a terminal is wired to, newest wire first, with what's on it. */
export function browserBindingsForTerminal(terminalId: string) {
  const cards = useBrowserCardStore.getState().cards;
  return wireEndsOf("terminal", terminalId)
    .filter((end) => end.kind === "browser" && end.can.includes("read") && cards[end.id])
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((end, i, all) => all.findIndex((x) => x.id === end.id) === i)
    .map((end) => ({ browserId: end.id, access: end.can.includes("drive") ? ("drive" as const) : ("read" as const), title: cards[end.id].title ?? "", url: cards[end.id].url ?? "" }));
}

/** The tile's outer element: what's moved to keep it drawn. */
function cardElement(cardId: string): HTMLElement | null {
  const wv = getBrowserWebview(cardId);
  return (wv?.closest("[data-browser-card]") as HTMLElement | null) ?? null;
}

/**
 * Keeps a tile drawn while an agent drives it. When it's off screen, or the
 * grid hides it, its element is placed inside the window, nearly transparent
 * and behind everything: Chromium then draws it and takes input, and the
 * person sees nothing move. Its place on the canvas doesn't change.
 */
export function wakeBrowserTile(cardId: string): boolean {
  const el = cardElement(cardId);
  if (!el) return false;
  if (el.dataset.awake === "1") return true;
  const r = el.getBoundingClientRect();
  const onScreen = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden";
  if (onScreen) return true;
  // How far the canvas scales it, so the move lands it on screen.
  const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
  el.style.setProperty("--tc-awake-x", `${(-r.left + 24) / (scale || 1)}px`);
  el.style.setProperty("--tc-awake-y", `${(-r.top + 24) / (scale || 1)}px`);
  el.dataset.awake = "1";
  return true;
}

export function sleepBrowserTile(cardId: string): void {
  const el = cardElement(cardId);
  if (!el || el.dataset.awake !== "1") return;
  delete el.dataset.awake;
  el.style.removeProperty("--tc-awake-x");
  el.style.removeProperty("--tc-awake-y");
}
