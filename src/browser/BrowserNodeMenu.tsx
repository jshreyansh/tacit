import { useRef, useState, type ReactNode } from "react";
import { PickerPopover } from "../agents/AgentPicker";
import { removeBrowserCardFromScene } from "../actions/sceneCardActions";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";
import { useT } from "../i18n/useT";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useBrowserTabStateStore, useBrowserTabState } from "../stores/browserTabStateStore";
import { useChromeSyncStore } from "../stores/chromeSyncStore";
import { useIdentityStore } from "../stores/identityStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { openBrowserNodeFind, resetBrowserNodeZoom, stepBrowserNodeZoom } from "./browserNodeCommands";
import { DEFAULT_BROWSER_ZOOM, clampBrowserZoom, formatBrowserZoom } from "./pageZoom";

/**
 * A browser node's ⋯ menu: the parts of Chrome's menu that matter on a
 * workdesk. Zoom, find, print, mute, the page's link, the page in your own
 * browser, recent downloads, developer tools, and syncing logins from Chrome.
 */
export function BrowserNodeMenu({ cardId, connected }: { cardId: string; connected: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const card = useBrowserCardStore((s) => s.cards[cardId]);
  const tab = useBrowserTabState(cardId);
  const downloads = useBrowserTabStateStore((s) => s.downloads);
  const syncing = useChromeSyncStore((s) => s.syncing);
  const hasImportedProfile = useIdentityStore((s) => Object.values(s.identities).some((i) => i.provenance?.source === "chrome"));
  const inGrid = useWorkdeskViewStore((s) => s.mode === "grid");

  if (!card) return null;
  const zoom = clampBrowserZoom(card.pageZoom ?? DEFAULT_BROWSER_ZOOM);
  const webview = () => getBrowserWebview(cardId) ?? null;
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="shrink-0" onMouseDown={(e) => e.stopPropagation()}>
      <button
        ref={button}
        type="button"
        className="tc-br-btn"
        aria-label={t.browser_menu}
        title={t.browser_menu}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3.5" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="8" cy="12.5" r="1.3" />
        </svg>
      </button>
      {open && button.current && (
        <PickerPopover
          anchor={button.current}
          align="right"
          role="menu"
          width={264}
          label={t.browser_menu}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        >
          {!connected && (
            <>
              <div className="flex items-center gap-1 px-2.5 py-1 text-[13px] text-[var(--text-primary)]">
                <span className="flex-1">{t.browser_menu_zoom}</span>
                <RoundButton label={t.browser_menu_zoom_out} onClick={() => stepBrowserNodeZoom(cardId, "out")}>
                  <path d="M3.5 8h9" />
                </RoundButton>
                <button
                  type="button"
                  className="tc-mono w-12 rounded py-0.5 text-center text-[12px] tabular-nums text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  title={t.browser_menu_zoom_reset}
                  onClick={() => resetBrowserNodeZoom(cardId)}
                >
                  {formatBrowserZoom(zoom)}
                </button>
                <RoundButton label={t.browser_menu_zoom_in} onClick={() => stepBrowserNodeZoom(cardId, "in")}>
                  <path d="M3.5 8h9M8 3.5v9" />
                </RoundButton>
                {!inGrid && (
                  <>
                    <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden="true" />
                    <RoundButton
                      label={t.browser_menu_full_size}
                      onClick={() => {
                        setOpen(false);
                        useWorkdeskViewStore.getState().showGrid({ kind: "browser", id: cardId });
                      }}
                    >
                      <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
                    </RoundButton>
                  </>
                )}
              </div>
              <Divider />
              <Item label={t.browser_menu_find} hint="⌘F" onClick={run(() => openBrowserNodeFind(cardId))} />
              <Item label={t.browser_menu_print} onClick={run(() => webview()?.print())} />
              <Item
                label={tab.muted ? t.browser_menu_unmute : t.browser_menu_mute}
                onClick={run(() => setBrowserNodeMuted(cardId, !tab.muted))}
              />
              <Divider />
            </>
          )}
          <Item
            label={t.browser_menu_copy_link}
            onClick={run(() => {
              void navigator.clipboard.writeText(card.url);
              useNotificationStore.getState().notify("info", t.browser_menu_link_copied);
            })}
          />
          <Item label={t.browser_menu_open_default} onClick={run(() => void window.tacit.browser.openInDefaultBrowser(card.url))} />
          {!connected && downloads.length > 0 && (
            <>
              <Divider />
              <div className="tc-eyebrow px-2.5 pb-0.5 pt-1">{t.browser_menu_downloads}</div>
              {downloads.map((d) => (
                <Item
                  key={d.revealToken}
                  label={d.filename}
                  hint={t.browser_menu_show_in_finder}
                  onClick={run(() => void window.tacit.browser.revealDownload(d.revealToken))}
                />
              ))}
            </>
          )}
          {!connected && (
            <>
              <Divider />
              {hasImportedProfile && (
                <Item
                  label={syncing ? t.browser_chrome_sync_running : t.browser_menu_sync_chrome}
                  disabled={syncing}
                  onClick={run(() => void useChromeSyncStore.getState().sync("manual"))}
                />
              )}
              <Item label={t.browser_menu_devtools} onClick={run(() => webview()?.openDevTools())} />
            </>
          )}
          <Divider />
          <Item label={t.browser_menu_close} danger onClick={run(() => removeBrowserCardFromScene(cardId))} />
        </PickerPopover>
      )}
    </div>
  );
}

export function setBrowserNodeMuted(cardId: string, muted: boolean): void {
  const wv = getBrowserWebview(cardId);
  if (!wv) return;
  try {
    wv.setAudioMuted(muted);
    useBrowserTabStateStore.getState().set(cardId, { muted });
  } catch {
    // Not attached yet: nothing is playing to mute.
  }
}

function Item({ label, hint, onClick, disabled, danger }: { label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-pick=""
      disabled={disabled}
      className={`tc-rail-btn flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] disabled:opacity-50 ${danger ? "text-[var(--red)]" : "text-[var(--text-primary)]"}`}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </button>
  );
}

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function Divider() {
  return <div className="mx-1 my-1 h-px bg-[var(--border)]" />;
}
