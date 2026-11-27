/// <reference types="electron" />

import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { browserConsoleError } from "../canvas/wireRules";
import { updateBrowserCardInScene } from "../actions/sceneCardActions";
import { activateCardInScene } from "../actions/sceneSelectionActions";
import { isInGroup } from "../canvas/canvasSelection";
import { beginCanvasDrag } from "../canvas/canvasDrag";
import { startGroupMove } from "../canvas/groupMove";
import { tileDropped } from "../board/boardMembership";
import {
  type BrowserCardData,
  useBrowserCardStore,
} from "../stores/browserCardStore";
import { useCardLayoutStore } from "../stores/cardLayoutStore";
import { useCanvasStore } from "../stores/canvasStore";
import { TileFarLabelAt, TileMoveSurface } from "../canvas/TileFarChrome";
import { MOVE_ANYWHERE_BELOW } from "../canvas/tileMove";
import { flyToBounds } from "../utils/panToTerminal";
import { useSelectionStore } from "../stores/selectionStore";
import { useIdentityStore, partitionForIdentity } from "../stores/identityStore";
import { isAgentAllowed } from "../types/workspace";
import { isGuestProfile, profileSwatch } from "../browser/profileColor";
import { PickerHeading, PickerPopover } from "../agents/AgentPicker";
import { addressFor, shownAddress, tabAddressFrom } from "../browser/address";
import { managedBrowserBinding } from "../../shared/browser-controller";
import { useIdentityManagerStore } from "../stores/identityManagerStore";
import { useT } from "../i18n/useT";
import {
  registerBrowserWebview,
  unregisterBrowserWebview,
} from "../canvas/browserWebviewRegistry";
import { recordDecision } from "../capture";
import { BrowserFindBar } from "./BrowserFindBar";
import { useBrowserFindStore } from "../stores/browserFindStore";
import {
  DEFAULT_BROWSER_ZOOM,
  clampBrowserZoom,
  formatBrowserZoom,
  isDefaultBrowserZoom,
} from "../browser/pageZoom";
import { resetBrowserNodeZoom } from "../browser/browserNodeCommands";
import { useChromeSyncStore } from "../stores/chromeSyncStore";
import { BrowserNodeMenu, setBrowserNodeMuted } from "../browser/BrowserNodeMenu";
import { keepableFavicon, useBrowserTabState, useBrowserTabStateStore } from "../stores/browserTabStateStore";
import { useBrowserDrivingStore } from "../browser/browserDriving";
import { findTerminal } from "../actions/terminalLookup";
import { TERMINAL_TYPE_CONFIG } from "../terminal/terminalTypeConfig";

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
  /**
   * Laid over the workdesk view's tab at full scale (its layer computes
   * where): this replaces the tile's own place and size, and it can't be
   * dragged or resized there, which would move the tile on the canvas.
   */
  projectedLayout?: React.CSSProperties;
}

export function BrowserCard({ card, projectedLayout }: Props) {
  const zoomedOutScale = useCanvasStore((s) => (s.viewport.scale < MOVE_ANYWHERE_BELOW ? s.viewport.scale : 1));
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

  const cardId = `browser:${card.id}`;
  // One of several selected: pressing it keeps them, so they can be dragged.
  const activateUnlessGrouped = () => {
    if (!isInGroup({ type: "card", cardId })) activateCardInScene(cardId);
  };
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
  const syncingFromChrome = useChromeSyncStore((s) => s.syncing);
  const tab = useBrowserTabState(card.id);
  const onGuestProfile = !connectedBinding && isGuestProfile(card.identityId);
  // Whether there's anywhere to go: a button that does nothing says so.
  const [history, setHistory] = useState({ back: false, forward: false });
  const [identityMenuOpen, setIdentityMenuOpen] = useState(false);
  const identityButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    registerBrowserWebview(card.id, wv);
    return () => {
      unregisterBrowserWebview(card.id);
      // The guest this card's find was running against is gone — either the
      // node closed or the profile switch remounted it. Anything still on
      // screen would be counting matches in a page that no longer exists.
      useBrowserFindStore.getState().detach(card.id);
    };
  }, [card.id, card.identityId]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onTitle = (e: Electron.PageTitleUpdatedEvent) => {
      updateBrowserCardInScene(card.id, { title: e.title });
    };
    // A single navigation fires both `did-navigate` and `did-navigate-in-page`
    // on many pages, and recording each one wrote the same URL to the record
    // twice a second apart. Harmless in itself, but it inflated the record and
    // made a genuine reload indistinguishable from ordinary routing — an agent
    // reading the log misdiagnosed a spontaneous reload because of it.
    let lastRecordedUrl = "";
    let lastRecordedAt = 0;
    const NAVIGATION_DEDUPE_MS = 1_500;

    const onNavigate = ((event: Event & { url: string; isMainFrame?: boolean }) => {
      const url = tabAddressFrom(event);
      if (url === null) return;
      const e = { url };
      try {
        setHistory({ back: wv.canGoBack(), forward: wv.canGoForward() });
      } catch {
        // Detached meanwhile.
      }
      setUrlInput(e.url);
      setLoadError(null);
      updateBrowserCardInScene(card.id, { url: e.url });
      const now = Date.now();
      if (e.url === lastRecordedUrl && now - lastRecordedAt < NAVIGATION_DEDUPE_MS) {
        return;
      }
      lastRecordedUrl = e.url;
      lastRecordedAt = now;
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
    // Chromium counts the matches, we only display them.
    const onFoundInPage = ((e: Event & {
      result: { activeMatchOrdinal: number; matches: number };
    }) => {
      useBrowserFindStore.getState().reportResult(card.id, e.result);
    }) as EventListener;
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("did-navigate-in-page", onNavigate);
    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("found-in-page", onFoundInPage);
    // Errors the page logs, for a rule that tells a wired agent about them
    // (src/canvas/wireRules.ts). Level 3 is console.error.
    const onConsole = ((e: Event & { level: number; message: string; sourceId: string; line: number }) => {
      if (e.level < 3) return;
      const where = e.sourceId ? ` (${e.sourceId}${e.line ? `:${e.line}` : ""})` : "";
      browserConsoleError(card.id, `${e.message}${where}`);
    }) as EventListener;
    wv.addEventListener("console-message", onConsole);
    // What its tab shows, as in a browser: the page's icon, a spinner while
    // it loads, a speaker while it plays sound.
    const tabState = useBrowserTabStateStore.getState();
    const onFavicon = ((e: Event & { favicons: string[] }) => {
      const icon = e.favicons.map(keepableFavicon).find((f): f is string => !!f);
      const current = useBrowserCardStore.getState().cards[card.id]?.favicon;
      if (icon && icon !== current) updateBrowserCardInScene(card.id, { favicon: icon });
    }) as EventListener;
    const onStartLoading = () => tabState.set(card.id, { loading: true });
    const onStopLoading = () => tabState.set(card.id, { loading: false });
    // Electron says when media starts or pauses; whether it's heard is asked.
    const onMedia = () => {
      window.setTimeout(() => {
        try {
          tabState.set(card.id, { audible: wv.isCurrentlyAudible(), muted: wv.isAudioMuted() });
        } catch {
          // Detached meanwhile.
        }
      }, 250);
    };
    wv.addEventListener("page-favicon-updated", onFavicon);
    wv.addEventListener("did-start-loading", onStartLoading);
    wv.addEventListener("did-stop-loading", onStopLoading);
    wv.addEventListener("media-started-playing", onMedia);
    wv.addEventListener("media-paused", onMedia);
    return () => {
      wv.removeEventListener("page-favicon-updated", onFavicon);
      wv.removeEventListener("did-start-loading", onStartLoading);
      wv.removeEventListener("did-stop-loading", onStopLoading);
      wv.removeEventListener("media-started-playing", onMedia);
      wv.removeEventListener("media-paused", onMedia);
      useBrowserTabStateStore.getState().forget(card.id);
      wv.removeEventListener("console-message", onConsole);
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("found-in-page", onFoundInPage);
    };
  }, [card.id, card.identityId]);

  // Page zoom, pushed from the card rather than left on the guest. Electron
  // persists a zoom factor per origin within a session, so two nodes on the
  // same profile and site would otherwise inherit each other's zoom; re-applying
  // this card's own value on every attach and navigation keeps the card the
  // authority on what it shows.
  const pageZoom = clampBrowserZoom(card.pageZoom ?? DEFAULT_BROWSER_ZOOM);
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const apply = () => {
      try {
        wv.setZoomFactor(pageZoom);
      } catch {
        // Throws until the guest attaches; `dom-ready` below is the retry.
      }
    };
    apply();
    wv.addEventListener("dom-ready", apply);
    wv.addEventListener("did-navigate", apply);
    return () => {
      wv.removeEventListener("dom-ready", apply);
      wv.removeEventListener("did-navigate", apply);
    };
  }, [card.id, card.identityId, pageZoom]);

  /**
   * What the guest is *told* to load, as opposed to where it has since gone.
   *
   * A `<webview>`'s `src` is a navigation command, not a display of state: any
   * change to the attribute makes Electron load that URL. `card.url` mean-
   * while tracks where the page actually went, updated from `did-navigate`.
   * Binding one to the other closed a loop — a single-page app routing in
   * place (Gemini opening a conversation on send, say) updated `card.url`,
   * React wrote the new value to `src`, and the guest performed a *full* load
   * of it, destroying the state the page had just built. It read as the page
   * reloading itself the instant you interacted with it.
   *
   * So this is recomputed only when the element is about to be remounted for a
   * profile switch, and never when the page navigates itself. `card.url` is
   * deliberately not a dependency: reading its latest value at remount is the
   * point, reacting to it is the bug.
   */
  const mountUrl = useMemo(
    () => card.url,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card.identityId],
  );

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
      // One of several selected: they all come along.
      const group = isInGroup({ type: "card", cardId: `browser:${card.id}` }) ? startGroupMove(useSelectionStore.getState().selectedItems) : null;
      let by = { x: 0, y: 0 };
      const endDrag = beginCanvasDrag();
      const handleMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        by = { x: (ev.clientX - dragRef.current.startX) / scale, y: (ev.clientY - dragRef.current.startY) / scale };
        if (group) {
          group.shift(by.x, by.y);
          return;
        }
        updateBrowserCardInScene(card.id, {
          x: dragRef.current.origX + by.x,
          y: dragRef.current.origY + by.y,
        });
      };
      const handleUp = () => {
        dragRef.current = null;
        endDrag();
        if (group) group.drop(by.x, by.y);
        else if (by.x !== 0 || by.y !== 0) {
          // Dropped into a board section, or out of one.
          const now = useBrowserCardStore.getState().cards[card.id];
          if (now) tileDropped(`browser:${card.id}`, now);
        }
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [card.id, card.x, card.y],
  );

  const runConnectedAction = useCallback(async (
    action: "navigate" | "back" | "forward" | "reload",
    params: Record<string, unknown> = {},
  ) => {
    if (!connectedBinding) return;
    setLoadError(null);
    try {
      const result = await window.tacit.browserConnection.execute({
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
    const url = addressFor(urlInput);
    if (!url) return;
    updateBrowserCardInScene(card.id, { url });
    setUrlInput(url);
    if (connectedBinding) void runConnectedAction("navigate", { url });
    // Navigation is commanded explicitly rather than by letting `src` follow
    // `card.url`. See `mountUrl` — the attribute is a navigation trigger, so
    // driving it from observed state made pages reload themselves.
    else webviewRef.current?.loadURL(url).catch(() => {
      // A guest that went away mid-navigation; the address bar already shows
      // the attempt, and did-fail-load reports anything the user must see.
    });
  };

  // Zoomed out, the whole card moves it and its name shows above it, as
  // the other tiles do (src/canvas/tileMove.ts). Outside the card, which
  // clips what overflows it.
  const farChrome =
    !projectedLayout && zoomedOutScale < MOVE_ANYWHERE_BELOW ? (
      <div
        className="pointer-events-none absolute"
        data-scene-box-select-block
        data-scene-card={cardId}
        data-scene-card-handle=""
        style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
      >
        <div className="pointer-events-auto">
          <TileFarLabelAt
            zoom={zoomedOutScale}
            width={card.w}
            title={card.title || card.url}
            onPointerDown={(e) => {
              activateUnlessGrouped();
              handleDragStart(e);
            }}
            onOpen={() => flyToBounds(card.x, card.y, card.w, card.h)}
          />
          <TileMoveSurface
            onPointerDown={(e) => {
              activateUnlessGrouped();
              handleDragStart(e);
            }}
            onOpen={() => flyToBounds(card.x, card.y, card.w, card.h)}
          />
        </div>
      </div>
    ) : null;

  return (
    <>
    <div
      data-scene-box-select-block
      data-scene-card={projectedLayout ? undefined : cardId}
      data-connect-kind="browser"
      data-connect-id={card.id}
      data-browser-card={card.id}
      className="absolute rounded-lg border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
      style={
        projectedLayout ?? {
          left: card.x,
          top: card.y,
          width: card.w,
          height: card.h,
          boxShadow: "var(--shadow-elev-1)",
          outline: isSelected ? "2px solid var(--accent)" : undefined,
          outlineOffset: isSelected ? -2 : undefined,
        }
      }
      // Bubble phase, not capture: a capture-phase stop here would block
      // the event from ever reaching descendants' own onMouseDown
      // handlers (header drag-start, corner resize-start) — this way
      // those run first, and this only stops it from reaching the
      // canvas's box-select listener afterward (which in any case
      // already ignores this card independently via the
      // data-scene-box-select-block attribute above).
      onMouseDown={(e) => {
        e.stopPropagation();
        activateUnlessGrouped();
      }}
      // Typing in its address bar, or using its page, is being on this
      // browser too: the page's clicks never reach this window, but its
      // focus does. The grid opens on the browser you're on.
      onFocus={() => {
        if (!isSelected) activateCardInScene(cardId);
      }}
      // Lets ConnectionLayer light this card's wires from the browser end, the
      // same way hovering a terminal tile lights its own. Without it a
      // hand-drawn terminal↔browser wire only highlights from one side.
      onMouseEnter={() => {
        window.dispatchEvent(
          new CustomEvent("tacit:node-hover", {
            detail: { kind: "browser", id: card.id },
          }),
        );
      }}
      onMouseLeave={() => {
        window.dispatchEvent(
          new CustomEvent("tacit:node-hover", { detail: null }),
        );
      }}
    >
      <div
        className="tc-br-head cursor-grab select-none active:cursor-grabbing"
        data-scene-card-handle=""
        onMouseDown={projectedLayout ? undefined : handleDragStart}
      >
        <button type="button" className="tc-br-btn" title={t.browser_back} aria-label={t.browser_back} disabled={!connectedBinding && !history.back} onClick={() => (connectedBinding ? void runConnectedAction("back") : webviewRef.current?.goBack())}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13 8H3.5M7.5 4l-4 4 4 4" />
          </svg>
        </button>
        <button type="button" className="tc-br-btn" title={t.browser_forward} aria-label={t.browser_forward} disabled={!connectedBinding && !history.forward} onClick={() => (connectedBinding ? void runConnectedAction("forward") : webviewRef.current?.goForward())}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8h9.5M8.5 4l4 4-4 4" />
          </svg>
        </button>
        {/* Stop while the page loads, as in a browser; reload otherwise. */}
        {!connectedBinding && tab.loading ? (
          <button type="button" className="tc-br-btn" title={t.browser_stop} aria-label={t.browser_stop} onClick={() => webviewRef.current?.stop()}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        ) : (
          <button type="button" className="tc-br-btn" title={t.browser_reload} aria-label={t.browser_reload} onClick={() => (connectedBinding ? void runConnectedAction("reload") : webviewRef.current?.reload())}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 8a5 5 0 11-1.6-3.7M13 2.5V5h-2.5" />
            </svg>
          </button>
        )}

        {/* The address, and what's true of this page, in one pill. */}
        <div className="tc-br-address">
          <SiteBadge url={card.url} favicon={card.favicon} loading={!connectedBinding && tab.loading} t={t} />
          <AddressField
            url={card.url}
            value={urlInput}
            label={t.browser_address}
            placeholder={t.browser_address_hint}
            onChange={setUrlInput}
            onGo={handleUrlSubmit}
            onLeave={() => setUrlInput(card.url)}
          />
          {!connectedBinding && (tab.audible || tab.muted) && (
            <button type="button" className="tc-br-in" title={tab.muted ? t.browser_menu_unmute : t.browser_menu_mute} aria-label={tab.muted ? t.browser_menu_unmute : t.browser_menu_mute} onClick={() => setBrowserNodeMuted(card.id, !tab.muted)}>
              <SpeakerIcon muted={tab.muted} size={14} />
            </button>
          )}
          {/* Only while zoom is off default: otherwise it is a permanent "100%" on
              every node. Pressing it is the way back. */}
          {!connectedBinding && !isDefaultBrowserZoom(pageZoom) && (
            <button type="button" className="tc-br-in tabular-nums" title={t.browser_zoom_reset} onClick={() => resetBrowserNodeZoom(card.id)}>
              {formatBrowserZoom(pageZoom)}
            </button>
          )}
          {/* Sync from Chrome is in the ⋯ menu; while it runs, this says so,
              since it takes a few seconds. */}
          {!connectedBinding && syncingFromChrome && (
            <span className="tc-br-in" title={t.browser_chrome_sync_running} aria-label={t.browser_chrome_sync_running}>
              <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden="true" />
            </span>
          )}
        </div>

        <>
          {/* Which profile this node is signed in as: its initial in its own
              colour, told apart when zoomed out. Guest is hollow, and says it's
              signed out: the one that must never be mistaken for your account. */}
          <button
            ref={identityButton}
            type="button"
            className="tc-br-profile"
            data-wide={connectedBinding || onGuestProfile ? "" : undefined}
            aria-haspopup={connectedBinding ? undefined : "menu"}
            aria-expanded={connectedBinding ? undefined : identityMenuOpen}
            aria-label={connectedBinding ? `${connectedBinding.browser} ${connectedBinding.profileLabel}` : (currentIdentity?.name ?? t.browser_identity_unknown)}
            title={
              connectedBinding
                ? t.browser_connected_hint
                : onGuestProfile
                  ? t.browser_identity_guest_hint
                  : `${currentIdentity?.name ?? t.browser_identity_unknown}. ${t.browser_identity_picker_title}`
            }
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (!connectedBinding) setIdentityMenuOpen((v) => !v);
            }}
          >
            {!connectedBinding && <ProfileAvatar identityId={card.identityId} name={currentIdentity?.name ?? ""} />}
            {connectedBinding && <span className="truncate">{`${connectedBinding.browser}, ${connectedBinding.profileLabel}`}</span>}
            {onGuestProfile && <span className="truncate">{t.browser_identity_signed_out}</span>}
          </button>
          {identityMenuOpen && !connectedBinding && identityButton.current && (
            <PickerPopover
              anchor={identityButton.current}
              align="right"
              role="menu"
              width={256}
              label={t.browser_identity_picker_title}
              onClose={(refocus) => {
                setIdentityMenuOpen(false);
                if (refocus) identityButton.current?.focus();
              }}
            >
              <PickerHeading>{t.browser_browse_as}</PickerHeading>
              <div className="max-h-[min(372px,52vh)] overflow-y-auto">
                {Object.values(identities).map((identity) => (
                  <button
                    key={identity.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={identity.id === card.identityId}
                    data-pick=""
                    data-first={identity.id === card.identityId ? "" : undefined}
                    className="tc-ap-row"
                    title={isAgentAllowed(identity) ? undefined : t.browser_identity_agent_withheld}
                    onClick={() => {
                      updateBrowserCardInScene(card.id, { identityId: identity.id, backend: managedBrowserBinding(identity.id) });
                      setIdentityMenuOpen(false);
                    }}
                  >
                    <ProfileAvatar identityId={identity.id} name={identity.name} size={24} />
                    <span className="min-w-0 flex-1 truncate">{identity.name}</span>
                    {/* You may open any profile; only agents are held back, so
                        this is a note on the row, not a disabled state. */}
                    {!isAgentAllowed(identity) && <span className="tc-ap-detail shrink-0">{t.browser_identity_agent_withheld_short}</span>}
                    {identity.id === card.identityId && (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                        <path d="M3.5 8.5l3 3 6-7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <div className="tc-ap-rule" />
              <button
                type="button"
                role="menuitem"
                data-pick=""
                className="tc-ap-row"
                onClick={() => {
                  setIdentityMenuOpen(false);
                  useIdentityManagerStore.getState().openManager();
                }}
              >
                {t.browser_identity_manage}
              </button>
            </PickerPopover>
          )}
        </>

        <BrowserNodeMenu cardId={card.id} connected={!!connectedBinding} />

        {!connectedBinding && tab.loading && <span className="tc-br-loading" aria-hidden="true" />}
      </div>

      <div className="flex-1 min-h-0 relative">
        <DrivenBar cardId={card.id} />
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
          src={mountUrl}
          partition={partitionForIdentity(card.identityId)}
          // A string: React drops `true` for an attribute it doesn't know, and
          // without it Chromium blocks every popup before main's handler sees it.
          {...({ allowpopups: "true" } as Record<string, string>)}
          className="w-full h-full"
          style={{ border: "none" }}
        />}
        {!connectedBinding && <BrowserFindBar cardId={card.id} />}
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

    </div>
    {farChrome}
    </>
  );
}

type Dict = ReturnType<typeof useT>;

/**
 * The address: read, it's the site and then the rest, without https:// and
 * www.; pressed, the whole of it selected, to change or copy.
 */
function AddressField({ url, value, label, placeholder, onChange, onGo, onLeave }: { url: string; value: string; label: string; placeholder: string; onChange: (text: string) => void; onGo: () => void; onLeave: () => void }) {
  const [editing, setEditing] = useState(false);
  const shown = shownAddress(url);
  const input = useRef<HTMLInputElement>(null);
  // Pressed and let go, it's edited; pressed and moved, the tile was dragged by it.
  const pressed = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (!editing)
    return (
      <button type="button" className="tc-br-url" aria-label={`${label}: ${url}`} title={url} onMouseDown={(e) => (pressed.current = { x: e.clientX, y: e.clientY })} onClick={(e) => {
          const at = pressed.current;
          pressed.current = null;
          if (!at || Math.hypot(e.clientX - at.x, e.clientY - at.y) < 4) setEditing(true);
        }}>
        {shown.site ? (
          <>
            <span className="text-[var(--text-primary)]">{shown.site}</span>
            {shown.rest}
          </>
        ) : (
          placeholder
        )}
      </button>
    );
  return (
    <input
      ref={input}
      autoFocus
      className="tc-br-url"
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      placeholder={placeholder}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        setEditing(false);
        onLeave();
      }}
      onKeyDown={(e) => {
        // The canvas listens globally for single-key shortcuts.
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          onGo();
          setEditing(false);
        } else if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

/** A profile as its initial, in the colour it's known by everywhere. */
function ProfileAvatar({ identityId, name, size = 24 }: { identityId: string; name: string; size?: number }) {
  const swatch = profileSwatch(identityId);
  const guest = isGuestProfile(identityId);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        ...(guest ? { border: "1.5px dashed var(--text-muted)", color: "var(--text-muted)" } : { background: `color-mix(in srgb, ${swatch.color} 30%, var(--surface))`, color: swatch.color, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${swatch.color} 45%, transparent)` }),
      }}
    >
      {guest ? "" : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Before the address: the page's icon (a spinner while it loads), and a
 * plain "Not secure" for a page that isn't https, as Chrome says it.
 */
function SiteBadge({ url, favicon, loading, t }: { url: string; favicon?: string; loading: boolean; t: Dict }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [favicon]);
  // This Mac's own servers never leave it.
  const insecure = /^http:\/\//i.test(url) && !/^http:\/\/(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(url);
  return (
    <>
      {loading ? (
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--text-muted)] border-t-transparent" aria-hidden="true" />
      ) : favicon && !broken ? (
        <img src={favicon} alt="" className="h-4 w-4 shrink-0 object-contain" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <GlobeGlyph />
      )}
      {insecure && (
        <span className="shrink-0 text-[11px] text-[var(--red)]" title={t.browser_not_secure_hint}>
          {t.browser_not_secure}
        </span>
      )}
    </>
  );
}

function GlobeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  );
}

export function SpeakerIcon({ muted, size = 12 }: { muted: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor" stroke="none" />
      {muted ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />}
    </svg>
  );
}

/**
 * Who is driving this page, and the person's way to take it back: Stop keeps
 * agents off it for a while, Resume lets them back on. Shown while an agent is
 * changing the page, or while they're kept off.
 */
function DrivenBar({ cardId }: { cardId: string }) {
  const t = useT();
  const state = useBrowserDrivingStore((s) => s.byCard[cardId]);
  if (!state || (!state.driver && !state.held)) return null;
  const name = (() => {
    const id = state.driver?.startsWith("terminal:") ? state.driver.slice("terminal:".length) : null;
    const found = id ? findTerminal(id) : null;
    return found ? found.terminal.customTitle?.trim() || TERMINAL_TYPE_CONFIG[found.terminal.type]?.label || found.terminal.title : t.browser_driven_agent;
  })();
  return (
    <div className="tc-br-driven" role="status" onMouseDown={(e) => e.stopPropagation()}>
      <span className="tc-br-driven-dot" data-held={state.held ? "true" : undefined} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {state.held === "stopped" ? t.browser_driven_stopped : state.held === "user" ? t.browser_driven_paused : t.browser_driven_by(name)}
      </span>
      {state.held === "stopped" ? (
        <button type="button" className="tc-br-driven-btn" onClick={() => void window.tacit.browser.resumeDriver(cardId)}>
          {t.browser_driven_resume}
        </button>
      ) : state.driver ? (
        <button type="button" className="tc-br-driven-btn" onClick={() => void window.tacit.browser.stopDriver(cardId)}>
          {t.browser_driven_stop}
        </button>
      ) : null}
    </div>
  );
}
