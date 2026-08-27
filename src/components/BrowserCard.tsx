/// <reference types="electron" />

import { useEffect, useRef, useCallback, useState } from "react";
import {
  removeBrowserCardFromScene,
  updateBrowserCardInScene,
} from "../actions/sceneCardActions";
import { activateCardInScene } from "../actions/sceneSelectionActions";
import {
  type BrowserCardData,
} from "../stores/browserCardStore";
import { useCardLayoutStore } from "../stores/cardLayoutStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useSelectionStore } from "../stores/selectionStore";
import { useIdentityStore, partitionForIdentity } from "../stores/identityStore";
import { managedBrowserBinding } from "../../shared/browser-controller";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { useT } from "../i18n/useT";
import {
  registerBrowserWebview,
  unregisterBrowserWebview,
} from "../canvas/browserWebviewRegistry";
import { recordDecision } from "../capture";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
          preload?: string;
        },
        HTMLElement
      >;
    }
  }
}

interface Props {
  card: BrowserCardData;
}

export function BrowserCard({ card }: Props) {
  const connectedBinding = card.backend?.kind === "connected-tab" ? card.backend : null;
  const { register, unregister } = useCardLayoutStore();
  const [urlInput, setUrlInput] = useState(card.url);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const cardId = `browser:${card.id}`;
  const isSelected = useSelectionStore((state) =>
    state.selectedItems.some(
      (item) => item.type === "card" && item.cardId === cardId,
    ),
  );

  useEffect(() => {
    register(cardId, { x: card.x, y: card.y, w: card.w, h: card.h });
    return () => unregister(cardId);
  }, [card.h, card.w, card.x, card.y, cardId, register, unregister]);

  const [loadError, setLoadError] = useState<string | null>(null);

  const t = useT();
  const identities = useIdentityStore((s) => s.identities);
  const currentIdentity = identities[card.identityId];
  const [identityMenuOpen, setIdentityMenuOpen] = useState(false);
  const identityMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!identityMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        identityMenuRef.current &&
        !identityMenuRef.current.contains(e.target as Node)
      ) {
        setIdentityMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [identityMenuOpen]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    registerBrowserWebview(card.id, wv);
    return () => unregisterBrowserWebview(card.id);
  }, [card.id]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onTitle = (e: Electron.PageTitleUpdatedEvent) => {
      updateBrowserCardInScene(card.id, { title: e.title });
    };
    const onNavigate = ((e: Event & { url: string }) => {
      setUrlInput(e.url);
      setLoadError(null);
      updateBrowserCardInScene(card.id, { url: e.url });
      recordDecision({
        kind: "browser_action",
        node: `browser:${card.id}`,
        action: "navigate",
        backend: "managed",
        by: "system",
        ok: true,
        url: e.url,
        // Names the activity stream holding what was clicked and read on this
        // page, so the two tiers of the record can be joined without either
        // one carrying the other's contents.
        profile: card.identityId,
      });
    }) as EventListener;
    const onFailLoad = ((e: Event & {
      errorCode: number;
      errorDescription: string;
      isMainFrame: boolean;
    }) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      setLoadError(e.errorDescription);
    }) as EventListener;
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("did-navigate-in-page", onNavigate);
    wv.addEventListener("did-fail-load", onFailLoad);
    return () => {
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
      wv.removeEventListener("did-fail-load", onFailLoad);
    };
  }, [card.id]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = useCanvasStore.getState().viewport.scale;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: card.x,
        origY: card.y,
      };
      const handleMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        updateBrowserCardInScene(card.id, {
          x: dragRef.current.origX + (ev.clientX - dragRef.current.startX) / scale,
          y: dragRef.current.origY + (ev.clientY - dragRef.current.startY) / scale,
        });
      };
      const handleUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [card.id, card.x, card.y],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = useCanvasStore.getState().viewport.scale;
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: card.w,
        origH: card.h,
      };
      const handleMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return;
        const nextW = Math.max(400, resizeRef.current.origW + (ev.clientX - resizeRef.current.startX) / scale);
        const nextH = Math.max(200, resizeRef.current.origH + (ev.clientY - resizeRef.current.startY) / scale);
        updateBrowserCardInScene(card.id, { w: nextW, h: nextH });
      };
      const handleUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [card.id, card.w, card.h],
  );

  const runConnectedAction = useCallback(async (
    action: "navigate" | "back" | "forward" | "reload",
    params: Record<string, unknown> = {},
  ) => {
    if (!connectedBinding) return;
    setLoadError(null);
    try {
      const result = await window.termcanvas.browserConnection.execute({
        bindingId: connectedBinding.tabBindingId,
        action,
        params,
      });
      if (result && typeof result === "object") {
        const next = result as { url?: unknown; title?: unknown };
        const patch: Partial<BrowserCardData> = {};
        if (typeof next.url === "string") {
          patch.url = next.url;
          setUrlInput(next.url);
        }
        if (typeof next.title === "string") patch.title = next.title;
        if (Object.keys(patch).length) updateBrowserCardInScene(card.id, patch);
      }
      recordDecision({
        kind: "browser_action",
        node: `browser:${card.id}`,
        action,
        backend: "connected-tab",
        by: "user",
        ok: true,
        ...(typeof params.url === "string" ? { url: params.url } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connected browser action failed";
      setLoadError(message);
      recordDecision({
        kind: "browser_action",
        node: `browser:${card.id}`,
        action,
        backend: "connected-tab",
        by: "user",
        ok: false,
        ...(typeof params.url === "string" ? { url: params.url } : {}),
        error: message,
      });
    }
  }, [card.id, connectedBinding]);

  const handleUrlSubmit = () => {
    let url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    updateBrowserCardInScene(card.id, { url });
    setUrlInput(url);
    if (connectedBinding) void runConnectedAction("navigate", { url });
  };

  return (
    <div
      data-scene-box-select-block
      data-connect-kind="browser"
      data-connect-id={card.id}
      className="absolute rounded-lg border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
      style={{
        left: card.x,
        top: card.y,
        width: card.w,
        height: card.h,
        boxShadow: "var(--shadow-elev-1)",
        outline: isSelected ? "2px solid var(--accent)" : undefined,
        outlineOffset: isSelected ? -2 : undefined,
      }}
      // Bubble phase, not capture: a capture-phase stop here would block
      // the event from ever reaching descendants' own onMouseDown
      // handlers (header drag-start, corner resize-start) — this way
      // those run first, and this only stops it from reaching the
      // canvas's box-select listener afterward (which in any case
      // already ignores this card independently via the
      // data-scene-box-select-block attribute above).
      onMouseDown={(e) => {
        e.stopPropagation();
        activateCardInScene(cardId);
      }}
      // Lets ConnectionLayer light this card's wires from the browser end, the
      // same way hovering a terminal tile lights its own. Without it a
      // hand-drawn terminal↔browser wire only highlights from one side.
      onMouseEnter={() => {
        window.dispatchEvent(
          new CustomEvent("termcanvas:node-hover", {
            detail: { kind: "browser", id: card.id },
          }),
        );
      }}
      onMouseLeave={() => {
        window.dispatchEvent(
          new CustomEvent("termcanvas:node-hover", { detail: null }),
        );
      }}
    >
      <div
        className="flex-none flex items-center gap-1.5 px-2 py-1.5 bg-[var(--bg)] border-b border-[var(--border)] cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleDragStart}
      >
        <button
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => connectedBinding ? void runConnectedAction("back") : webviewRef.current?.goBack()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => connectedBinding ? void runConnectedAction("forward") : webviewRef.current?.goForward()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => connectedBinding ? void runConnectedAction("reload") : webviewRef.current?.reload()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1.5 6a4.5 4.5 0 1 1 1 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1.5 10.5V6H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <input
          className="tc-meta tc-mono flex-1 min-w-0 px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] outline-none focus:border-[var(--text-secondary)]"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleUrlSubmit();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />

        <div className="relative" ref={identityMenuRef}>
          <button
            type="button"
            className="tc-meta px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] max-w-[100px] truncate"
            title={connectedBinding ? "Connected system-browser profile" : t.browser_identity_picker_title}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { if (!connectedBinding) setIdentityMenuOpen((v) => !v); }}
          >
            {connectedBinding
              ? `${connectedBinding.browser} · ${connectedBinding.profileLabel}`
              : currentIdentity?.name ?? t.browser_identity_unknown}
          </button>
          {identityMenuOpen && !connectedBinding && (
            <div
              className="absolute right-0 top-full mt-1 w-[160px] max-h-52 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] shadow-lg z-20 tc-enter-fade-quick"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {Object.values(identities).map((identity) => (
                <button
                  key={identity.id}
                  type="button"
                  className={`w-full text-left px-2.5 py-1.5 tc-meta truncate transition-colors duration-quick ${
                    identity.id === card.identityId
                      ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  }`}
                  onClick={() => {
                    updateBrowserCardInScene(card.id, {
                      identityId: identity.id,
                      backend: managedBrowserBinding(identity.id),
                    });
                    setIdentityMenuOpen(false);
                  }}
                >
                  {identity.name}
                </button>
              ))}
              <div className="border-t border-[var(--border)]">
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 tc-meta text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors duration-quick"
                  onClick={() => {
                    setIdentityMenuOpen(false);
                    useIdentityManagerStore.getState().openManager();
                  }}
                >
                  {t.browser_identity_manage}
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => removeBrowserCardFromScene(card.id)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {connectedBinding ? (
          <div className="h-full flex flex-col items-center justify-center px-8 text-center bg-[var(--bg)]">
            <div
              className="mb-3 h-2.5 w-2.5 rounded-full"
              style={{
                background: loadError ? "var(--red)" : "var(--green)",
                boxShadow: loadError
                  ? "0 0 14px color-mix(in srgb, var(--red) 55%, transparent)"
                  : "0 0 14px color-mix(in srgb, var(--green) 55%, transparent)",
              }}
            />
            <p className="tc-body-sm text-[var(--text-primary)]">
              {loadError ? "Connected tab is unavailable" : "Connected to your system browser"}
            </p>
            <p className="tc-caption mt-1 max-w-[360px] text-[var(--text-muted)]">
              {loadError
                ? loadError
                : `This canvas node controls only the tab you approved. The authenticated page remains visible in ${connectedBinding.browser}.`}
            </p>
            <p className="tc-meta tc-mono mt-3 max-w-full truncate text-[var(--text-secondary)]">{card.title}</p>
          </div>
        ) : <webview
          // Electron only honors `partition` at first mount — changing it
          // on a live element does not re-partition it — so keying on the
          // identity forces a remount when the user switches identities.
          key={card.identityId}
          ref={webviewRef as React.Ref<HTMLElement>}
          src={card.url}
          partition={partitionForIdentity(card.identityId)}
          allowpopups
          className="w-full h-full"
          style={{ border: "none" }}
        />}
        {!connectedBinding && loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--surface)] text-[var(--text-muted)]">
            <p className="tc-body-sm mb-2">Failed to load page</p>
            <p className="tc-caption mb-3 max-w-[300px] text-center">{loadError}</p>
            <button
              className="tc-meta px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--bg)] transition-colors"
              onClick={() => { setLoadError(null); webviewRef.current?.reload(); }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={handleResizeStart}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="absolute bottom-0.5 right-0.5 text-[var(--text-faint)]">
          <path d="M9 1L1 9M9 5L5 9M9 8L8 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
